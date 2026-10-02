using System.Threading.Channels;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

// Issue #331 (#479 sub-project 2): consumes POST /reply/stream instead of
// the non-streaming ReplyAsync + SynthesizeAsync + Play() sequence -- a
// sentence's TTS synthesis and playback can start while the LLM is still
// generating the rest of the reply, instead of waiting for the whole reply
// then the whole synthesized WAV before any audio plays at all.
//
// Extracted out of VoiceLoop (rather than inlined into its turn-handling
// methods) so this one-ahead pipelining logic can be unit tested without
// real WASAPI audio hardware -- play is an injected delegate instead of a
// concrete AudioPlayer, the same kind of seam ManaBackendClient already
// exposes via its HttpMessageHandler constructor parameter.
internal sealed class StreamingReplyPlayer
{
    private readonly ManaBackendClient backendClient;
    private readonly Func<byte[], Task<bool>> playAsync; // true = clip finished naturally, false = interrupted (#479 sub-project 3)
    private readonly Action<bool> setTalking; // true once the first chunk starts, false once talking stops (naturally or interrupted)
    private readonly Action<bool>? setToolRunning; // #661: true on a "tool" start event, false on its end
    private readonly Action<string, string?, TimeSpan>? onSentencePlaying; // each sentence's text, #623 emotion tag (null if untagged) and audio length, as its audio starts
    private readonly Action<AgentSteps>? onSteps; // #1337: the reply's steps so far, from its "tool" events, in stream order with its sentences

    public StreamingReplyPlayer(ManaBackendClient backendClient, Func<byte[], Task<bool>> playAsync, Action<bool> setTalking, Action<bool>? setToolRunning = null, Action<string, string?, TimeSpan>? onSentencePlaying = null, Action<AgentSteps>? onSteps = null)
    {
        this.onSteps = onSteps;
        this.backendClient = backendClient;
        this.playAsync = playAsync;
        this.setTalking = setTalking;
        this.setToolRunning = setToolRunning;
        this.onSentencePlaying = onSentencePlaying;
    }

    // #623: the last completed reply's emotion tag (its final event's), for
    // a caller speaking that reply as one clip after Changed. Not in the
    // return tuple so its callers don't all change shape for one field.
    public string? FinalEmotion { get; private set; }

    // #675 Q12b: the last completed reply's final `deepThinking` (Mana's own
    // deep thinking is on), for the Think button. Same reason as above.
    public bool FinalDeepThinking { get; private set; }

    // #687: the sentence of the reply now playing out that's being
    // synthesized (1-based), or null -- for the chat's status line. The
    // one-ahead lookahead means at most one synthesis is in flight.
    public int? SynthesizingSentence => synthesizing == 0 ? null : synthesizing;

    // #914: the character whose sentence is playing now (null between
    // sentences or from an older backend) -- group mode lip-syncs her avatar.
    public string? PlayingCharacter => playingCharacter;
    private volatile string? playingCharacter;
    private volatile int synthesizing;
    private int synthesized;

    // Reply is null when Interrupted is true -- a barge-in cut off
    // playback before the reply finished streaming/speaking, so there's no
    // meaningful "true final reply" to report (the caller's already moved
    // on to handling the interruption instead). Pending (#513) is then the
    // sentences that had already streamed but hadn't started playing yet
    // -- the caller can hold and later replay them via
    // ReplaySentencesAsync; it's empty whenever Interrupted is false.
    // Otherwise, by the time this returns, every already-streamed sentence
    // has finished playing -- there's no PlaybackCompleted continuation
    // left to wait on afterward, unlike a plain AudioPlayer.Play() call.
    //
    // Changed == true covers both "nothing streamed" (tool-calling/best-of-
    // N/vision path never calls onSentence server-side) and "a regeneration
    // pass rewrote the reply after streaming already started" -- either way
    // the caller must fall back to synthesizing and playing Reply fresh.
    // #521: onSentence, when given, fires as soon as each sentence's text
    // is known from the stream -- decoupled from playback timing (it does
    // NOT wait for that sentence to actually finish being spoken), since a
    // chat log should show text as it arrives, not lag behind audio.
    // #963: source ("voice" or "typed") goes to /reply/stream as is.
    // #914: onSentence also gets the speaking character's name (null from
    // an older backend). In group mode a second final follows with her
    // sister's reaction; its sentence streams and plays like the rest, and
    // the first final stays the reply reported here.
    public async Task<(string? Reply, bool Changed, string? Expression, bool Interrupted, IReadOnlyList<string> Pending)> StreamReplyAndPlayAsync(
        string commandText, string? sessionId = null, Action<string, string?>? onSentence = null, string screenText = "", string? image = null, IReadOnlyList<string>? images = null, string? presetId = null, bool? thinkHarder = null, string? source = null, Action<ReplyStreamEvent>? onNoted = null)
    {
        var sentences = Channel.CreateUnbounded<(string Text, string? Emotion, string? Character)>();
        ReplyStreamEvent? finalEvent = null;

        var readTask = ReadEventsAsync(commandText, sessionId, screenText, image, images, presetId, thinkHarder, source, onSentence, sentences.Writer, e => finalEvent ??= e, onNoted);
        var (interrupted, pending) = await PlayStreamedSentencesAsync(sentences.Reader).ConfigureAwait(false);

        if (interrupted)
        {
            // Nobody's listening to the rest of this reply anymore --
            // don't block returning on the server finishing generating it.
            // Still observe any fault from the now-abandoned read so it
            // doesn't become a silently-unobserved task exception (it's a
            // real, potentially long-lived background HTTP call, unlike
            // the one-ahead synthesis lookahead below, which is cheap
            // enough to just abandon).
            _ = readTask.ContinueWith(
                t => _ = t.Exception,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
            return (null, false, null, true, pending);
        }

        await readTask.ConfigureAwait(false);

        if (finalEvent is null)
        {
            throw new InvalidOperationException("reply/stream ended without a final event");
        }
        if (finalEvent.Error is not null)
        {
            throw new InvalidOperationException(finalEvent.Error);
        }

        FinalEmotion = finalEvent.Emotion;
        FinalDeepThinking = finalEvent.DeepThinking;
        return (finalEvent.Reply ?? string.Empty, finalEvent.Changed, finalEvent.Expression, false, pending);
    }

    // #513: re-speaks sentences a barge-in cut off before they played
    // (StreamReplyAndPlayAsync's Pending), through the exact same one-ahead
    // synth/play pipeline -- not a second playback primitive, just a second
    // entry point into it, fed from a fixed list instead of the NDJSON
    // stream. Held state is text only; this re-synthesizes rather than
    // replaying cached audio. Returns the same Interrupted/Pending pair, so
    // a second interruption mid-resume can be held again by the caller.
    public Task<(bool Interrupted, IReadOnlyList<string> Pending)> ReplaySentencesAsync(IReadOnlyList<string> sentences)
    {
        var channel = Channel.CreateUnbounded<(string Text, string? Emotion, string? Character)>();
        foreach (var sentence in sentences)
        {
            channel.Writer.TryWrite((sentence, null, null));
        }
        channel.Writer.Complete();
        return PlayStreamedSentencesAsync(channel.Reader);
    }

    private async Task ReadEventsAsync(string commandText, string? sessionId, string screenText, string? image, IReadOnlyList<string>? images, string? presetId, bool? thinkHarder, string? source, Action<string, string?>? onSentence, ChannelWriter<(string Text, string? Emotion, string? Character)> writer, Action<ReplyStreamEvent> onFinal, Action<ReplyStreamEvent>? onNoted)
    {
        // #1337: steps with a textOffset; older ones are left to the poll.
        var runId = Guid.NewGuid().ToString("N");
        var steps = new List<AgentStep>();
        try
        {
            await foreach (var evt in backendClient.ReplyStreamAsync(commandText, sessionId, screenText, image, images, presetId, thinkHarder, source))
            {
                if (evt.Type == "sentence" && !string.IsNullOrWhiteSpace(evt.Text))
                {
                    onSentence?.Invoke(evt.Text, evt.CharacterName);
                    await writer.WriteAsync((evt.Text, evt.Emotion, evt.Character)).ConfigureAwait(false);
                }
                else if (evt.Type == "final")
                {
                    onFinal(evt);
                }
                else if (evt.Type == "tool")
                {
                    setToolRunning?.Invoke(evt.Phase == "start");
                    if (evt.Step is { TextOffset: not null } step && onSteps is not null)
                    {
                        var at = steps.FindIndex(s => s.Id == step.Id);
                        if (at < 0)
                        {
                            steps.Add(step);
                        }
                        else
                        {
                            steps[at] = step;
                        }
                        onSteps(new AgentSteps(runId, true, steps.ToList()));
                    }
                }
                else if (evt.Type == "noted" && !string.IsNullOrWhiteSpace(evt.Text))
                {
                    onNoted?.Invoke(evt); // #914: a relationship note or milestone she just made
                }
            }
        }
        finally
        {
            // Runs even if the loop above throws, so PlayStreamedSentencesAsync
            // (reading concurrently from the other side of the channel) is
            // never left waiting forever on a stream that failed mid-flight.
            writer.Complete();
            if (steps.Count > 0)
            {
                onSteps?.Invoke(new AgentSteps(runId, false, steps.ToList()));
            }
        }
    }

    // Interrupted is true if playback was cut off by an interruption (#479
    // sub-project 3) before every streamed sentence had a chance to play;
    // Pending is then what hadn't started playing yet, in order (#513).
    private async Task<(bool Interrupted, IReadOnlyList<string> Pending)> PlayStreamedSentencesAsync(ChannelReader<(string Text, string? Emotion, string? Character)> sentences)
    {
        // The one-ahead lookahead pulls its sentence out of the channel on
        // its own (thread-pool) continuation. At interrupt time, Pending
        // has to be "the lookahead's sentence (if it took one) + whatever
        // is still in the channel" with no gap between the two: a
        // sentence must never be already out of the channel but not yet
        // recorded as the lookahead. So the take itself (TryRead + record)
        // happens under this lock, and so does the snapshot. Never held
        // across an await.
        var lookaheadLock = new object();
        string? lookaheadText = null;
        synthesized = 0;

        (string Text, string? Emotion, string? Character)? TakeNext()
        {
            lock (lookaheadLock)
            {
                if (!sentences.TryRead(out var next))
                {
                    return null;
                }
                lookaheadText = next.Text;
                return next;
            }
        }

        var currentTask = TakeAndSynthesizeNextAsync(sentences, TakeNext);
        var talking = false;
        var interrupted = false;
        var pending = new List<string>();
        try
        {
            while (true)
            {
                var next = await currentTask.ConfigureAwait(false);
                if (next is not { } sentence)
                {
                    break;
                }
                // The sentence that was the lookahead is now the one about
                // to play -- it's no longer pending.
                lock (lookaheadLock)
                {
                    lookaheadText = null;
                }
                if (!talking)
                {
                    talking = true;
                    setTalking(true);
                }
                // Kick off synthesis of the next sentence before awaiting this
                // one's playback -- the reason chunks play back-to-back with no
                // audible gap instead of a synthesis-latency pause between each.
                // Abandoned unawaited if this chunk gets interrupted below --
                // matches the acceptable-risk call already made for this same
                // kind of dangling in-flight synth call elsewhere in this file.
                var nextTask = TakeAndSynthesizeNextAsync(sentences, TakeNext);
                onSentencePlaying?.Invoke(sentence.Text, sentence.Emotion, AudioPlayer.Duration(sentence.Audio));
                playingCharacter = sentence.Character;
                var completedNaturally = await playAsync(sentence.Audio).ConfigureAwait(false);
                if (!completedNaturally)
                {
                    interrupted = true;
                    lock (lookaheadLock)
                    {
                        if (lookaheadText is not null)
                        {
                            pending.Add(lookaheadText);
                        }
                        // Anything the server had streamed by now but the
                        // lookahead hadn't reached yet. Sentences it streams
                        // after this instant aren't held -- same snapshot-at-
                        // the-cut semantics as windows-launcher's peekPending().
                        while (sentences.TryRead(out var unplayed))
                        {
                            pending.Add(unplayed.Text);
                        }
                    }
                    break;
                }
                currentTask = nextTask;
            }
        }
        finally
        {
            // Must run even if a later sentence's synthesis throws mid-loop
            // (e.g. SynthesizeAsync failing) -- otherwise setTalking(false)
            // never fires and the caller (VoiceLoop, via avatarOverlay) is
            // left showing "talking" forever, on top of never handing mode
            // back to the caller either.
            playingCharacter = null;
            if (talking)
            {
                setTalking(false);
            }
        }
        return (interrupted, pending);
    }

    private async Task<(string Text, string? Emotion, string? Character, byte[] Audio)?> TakeAndSynthesizeNextAsync(ChannelReader<(string Text, string? Emotion, string? Character)> sentences, Func<(string Text, string? Emotion, string? Character)?> takeNext)
    {
        if (!await sentences.WaitToReadAsync().ConfigureAwait(false))
        {
            return null;
        }
        if (takeNext() is not { } next)
        {
            return null;
        }
        synthesizing = ++synthesized;
        try
        {
            return (next.Text, next.Emotion, next.Character, await backendClient.SynthesizeAsync(next.Text, next.Emotion, next.Character).ConfigureAwait(false));
        }
        finally
        {
            synthesizing = 0;
        }
    }
}
