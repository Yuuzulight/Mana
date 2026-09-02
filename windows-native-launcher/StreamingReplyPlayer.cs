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

    public StreamingReplyPlayer(ManaBackendClient backendClient, Func<byte[], Task<bool>> playAsync, Action<bool> setTalking)
    {
        this.backendClient = backendClient;
        this.playAsync = playAsync;
        this.setTalking = setTalking;
    }

    // Reply is null when Interrupted is true -- a barge-in cut off
    // playback before the reply finished streaming/speaking, so there's no
    // meaningful "true final reply" to report (the caller's already moved
    // on to handling the interruption instead). Otherwise, by the time
    // this returns, every already-streamed sentence has finished playing
    // -- there's no PlaybackCompleted continuation left to wait on
    // afterward, unlike a plain AudioPlayer.Play() call.
    //
    // Changed == true covers both "nothing streamed" (tool-calling/best-of-
    // N/vision path never calls onSentence server-side) and "a regeneration
    // pass rewrote the reply after streaming already started" -- either way
    // the caller must fall back to synthesizing and playing Reply fresh.
    public async Task<(string? Reply, bool Changed, string? Expression, bool Interrupted)> StreamReplyAndPlayAsync(
        string commandText)
    {
        var sentences = Channel.CreateUnbounded<string>();
        ReplyStreamEvent? finalEvent = null;

        var readTask = ReadEventsAsync(commandText, sentences.Writer, e => finalEvent = e);
        var interrupted = await PlayStreamedSentencesAsync(sentences.Reader).ConfigureAwait(false);

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
            return (null, false, null, true);
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

        return (finalEvent.Reply ?? string.Empty, finalEvent.Changed, finalEvent.Expression, false);
    }

    private async Task ReadEventsAsync(string commandText, ChannelWriter<string> writer, Action<ReplyStreamEvent> onFinal)
    {
        try
        {
            await foreach (var evt in backendClient.ReplyStreamAsync(commandText))
            {
                if (evt.Type == "sentence" && !string.IsNullOrWhiteSpace(evt.Text))
                {
                    await writer.WriteAsync(evt.Text).ConfigureAwait(false);
                }
                else if (evt.Type == "final")
                {
                    onFinal(evt);
                }
            }
        }
        finally
        {
            // Runs even if the loop above throws, so PlayStreamedSentencesAsync
            // (reading concurrently from the other side of the channel) is
            // never left waiting forever on a stream that failed mid-flight.
            writer.Complete();
        }
    }

    // Returns true if playback was cut off by an interruption (#479
    // sub-project 3) before every streamed sentence had a chance to play.
    private async Task<bool> PlayStreamedSentencesAsync(ChannelReader<string> sentences)
    {
        var currentTask = TakeAndSynthesizeNextAsync(sentences);
        var talking = false;
        var interrupted = false;
        try
        {
            while (true)
            {
                var audio = await currentTask.ConfigureAwait(false);
                if (audio is null)
                {
                    break;
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
                var nextTask = TakeAndSynthesizeNextAsync(sentences);
                var completedNaturally = await playAsync(audio).ConfigureAwait(false);
                if (!completedNaturally)
                {
                    interrupted = true;
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
            if (talking)
            {
                setTalking(false);
            }
        }
        return interrupted;
    }

    private async Task<byte[]?> TakeAndSynthesizeNextAsync(ChannelReader<string> sentences)
    {
        if (!await sentences.WaitToReadAsync().ConfigureAwait(false))
        {
            return null;
        }
        return sentences.TryRead(out var text)
            ? await backendClient.SynthesizeAsync(text).ConfigureAwait(false)
            : null;
    }
}
