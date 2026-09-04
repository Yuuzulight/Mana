using NAudio.Wave;

namespace Mana.NativeLauncher;

// #479 sub-project 4: taps PCM samples as they're read for playback,
// invoking a callback with each block before passing it through unchanged
// -- lets AudioPlayer feed live audio to a lip-sync analyzer without the
// playback pipeline itself knowing anything about lip-sync.
internal delegate void SamplesReadHandler(ReadOnlySpan<float> samples, int sampleRate);

internal sealed class TappingSampleProvider : ISampleProvider
{
    private readonly ISampleProvider source;
    private readonly SamplesReadHandler onSamplesRead;

    public TappingSampleProvider(ISampleProvider source, SamplesReadHandler onSamplesRead)
    {
        this.source = source;
        this.onSamplesRead = onSamplesRead;
    }

    public WaveFormat WaveFormat => source.WaveFormat;

    public int Read(float[] buffer, int offset, int count)
    {
        var samplesRead = source.Read(buffer, offset, count);
        if (samplesRead > 0)
        {
            onSamplesRead(new ReadOnlySpan<float>(buffer, offset, samplesRead), source.WaveFormat.SampleRate);
        }
        return samplesRead;
    }
}
