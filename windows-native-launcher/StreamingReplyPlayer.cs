using System.Threading.Channels;

namespace Mana.NativeLauncher;

// Issue #331 (#479 sub-project 2): consumes POST /reply/stream instead of
// the non-streaming ReplyAsync + SynthesizeAsync + Play() sequence -- a
// sentence's TTS synthesis and playback can start while the LLM is still
// generating the rest of the reply, instead of waiting for the whole reply
// then the whole synthesized WAV before any audio plays at all.
//
// Extracted out of VoiceLoop (rather than inlined into RunTurnAsync) so this
// one-ahead pipelining logic can be unit tested without real WASAPI audio
// hardware -- play is an injected delegate instead of a concrete
// AudioPlayer, the same kind of seam ManaBackendClient already exposes via
// its HttpMessageHandler constructor parameter.
internal sealed class StreamingReplyPlayer
{
    private readonly ManaBackendClient backendClient;
    private readonly Func<byte[], Task> playAsync;
    private readonly Action<bool> setTalking; // true once the first chunk starts, false once the last one finishes

    public StreamingReplyPlayer(ManaBackendClient backendClient, Func<byte[], Task> playAsync, Action<bool> setTalking)
    {
        this.backendClient = backendClient;
        this.playAsync = playAsync;
        this.setTalking = setTalking;
    }

    // By the time this returns, every already-streamed sentence has
    // finished playing -- there's no PlaybackCompleted continuation left to
    // wait on afterward, unlike a plain AudioPlayer.Play() call.
    //
    // Changed == true covers both "nothing streamed" (tool-calling/best-of-
    // N/vision path never calls onSentence server-side) and "a regeneration
    // pass rewrote the reply after streaming already started" -- either way
    // the caller must fall back to synthesizing and playing Reply fresh.
    public async Task<(string Reply, bool Changed, string? Expression)> StreamReplyAndPlayAsync(string commandText)
    {
        var sentences = Channel.CreateUnbounded<string>();
        ReplyStreamEvent? finalEvent = null;

        var readTask = ReadEventsAsync(commandText, sentences.Writer, e => finalEvent = e);
        var playTask = PlayStreamedSentencesAsync(sentences.Reader);
        await Task.WhenAll(readTask, playTask).ConfigureAwait(false);

        if (finalEvent is null)
        {
            throw new InvalidOperationException("reply/stream ended without a final event");
        }
        if (finalEvent.Error is not null)
        {
            throw new InvalidOperationException(finalEvent.Error);
        }

        return (finalEvent.Reply ?? string.Empty, finalEvent.Changed, finalEvent.Expression);
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

    private async Task PlayStreamedSentencesAsync(ChannelReader<string> sentences)
    {
        var currentTask = TakeAndSynthesizeNextAsync(sentences);
        var talking = false;
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
            var nextTask = TakeAndSynthesizeNextAsync(sentences);
            await playAsync(audio).ConfigureAwait(false);
            currentTask = nextTask;
        }
        if (talking)
        {
            setTalking(false);
        }
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
