using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Windows.Graphics.Imaging;
using Windows.Media.Capture;
using Windows.Media.Capture.Frames;
using Windows.Media.MediaProperties;
using Windows.Storage.Streams;

namespace Mana.NativeLauncher;

// #912: one webcam frame for Mana's vision, through Windows' own
// MediaCapture (no extra package). The camera is opened for this call only
// and released before it returns; the frame never touches the disk.
internal static class WebcamCapture
{
    public const string OffMessage = "The camera is off. Turn it on in Settings > Voice.";
    public const string NoCameraMessage = "No camera found.";
    public const string InUseMessage = "The camera is in use by another app.";
    public const string BlockedMessage = "Windows is blocking camera access. Turn on \"Let desktop apps access your camera\" in Settings > Privacy & security > Camera.";

    // The first frames off most webcams are dark while auto-exposure
    // settles. MANA_CAMERA_WARMUP_MS tunes it for a slow camera.
    private static int WarmupMs =>
        int.TryParse(Environment.GetEnvironmentVariable("MANA_CAMERA_WARMUP_MS"), out var ms) && ms >= 0 ? ms : 700;

    public static async Task<string> CaptureAsJpegDataUrlAsync()
    {
        try
        {
            using var capture = new MediaCapture();
            await capture.InitializeAsync(new MediaCaptureInitializationSettings
            {
                StreamingCaptureMode = StreamingCaptureMode.Video,
                MemoryPreference = MediaCaptureMemoryPreference.Cpu,
                SharingMode = MediaCaptureSharingMode.ExclusiveControl,
            });
            var source = capture.FrameSources.Values.FirstOrDefault(s => s.Info.SourceKind == MediaFrameSourceKind.Color)
                ?? throw new InvalidOperationException(NoCameraMessage);
            using var reader = await capture.CreateFrameReaderAsync(source, MediaEncodingSubtypes.Bgra8);
            var status = await reader.StartAsync();
            if (status != MediaFrameReaderStartStatus.Success)
            {
                throw new InvalidOperationException(status is MediaFrameReaderStartStatus.ExclusiveControlNotAvailable or MediaFrameReaderStartStatus.DeviceNotAvailable
                    ? InUseMessage
                    : $"The camera wouldn't start ({status}).");
            }
            try
            {
                await Task.Delay(WarmupMs);
                MediaFrameReference? frame = null;
                for (var i = 0; i < 30 && (frame = reader.TryAcquireLatestFrame()) is null; i++)
                {
                    await Task.Delay(100);
                }
                using (frame)
                {
                    var bitmap = frame?.VideoMediaFrame?.SoftwareBitmap ?? throw new InvalidOperationException("The camera sent no picture.");
                    return await ToVisionDataUrlAsync(bitmap);
                }
            }
            finally
            {
                await reader.StopAsync();
            }
        }
        catch (Exception ex) when (Describe(ex) is string message)
        {
            throw new InvalidOperationException(message, ex);
        }
    }

    private static async Task<string> ToVisionDataUrlAsync(SoftwareBitmap frame)
    {
        using var opaque = SoftwareBitmap.Convert(frame, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore);
        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, stream);
        encoder.SetSoftwareBitmap(opaque);
        await encoder.FlushAsync();
        stream.Seek(0);
        using var image = Image.FromStream(stream.AsStream());
        return ScreenCapture.ToVisionDataUrl(image);
    }

    // The failures worth a plain answer; anything else keeps its own message.
    internal static string? Describe(Exception ex) => ex is UnauthorizedAccessException
        ? BlockedMessage
        : unchecked((uint)ex.HResult) switch
        {
            0xC00DABE0 => NoCameraMessage, // MF_E_NO_CAPTURE_DEVICES_AVAILABLE
            0xC00D3704 or 0xC00D3EA2 or 0xC00D3EA3 => InUseMessage, // HW_MFT_FAILED_START_STREAMING, RECORDING_DEVICE_INVALIDATED/PREEMPTED
            _ => null,
        };
}
