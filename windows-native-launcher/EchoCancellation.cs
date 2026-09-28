using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;

namespace Mana.NativeLauncher;

// #619: echo cancellation for VoiceLoop's microphone, so Mana doesn't hear
// her own TTS from the speakers (Electron gets this from getUserMedia's
// WebRTC AEC). Rather than adding a software AEC, this tags the capture
// stream AudioCategory_Communications. Windows then runs the mic through
// its communications signal-processing mode, which on Windows 11 is Voice
// Clarity (AEC + noise suppression + dereverb, x64/Arm64, no extra
// hardware) for devices without their own communications APO, such as the
// inbox USB-audio driver a USB mic uses. That AEC takes its reference from
// what the render endpoint actually plays, so Mana's AudioPlayer needs no
// changes.
//
// Windows only reports what it applied through IAudioEffectsManager (build
// 22000+). If it reports no active AEC effect, communications mode brings
// only side effects (possible ducking, NS), so VoiceLoop goes back to the
// raw capture it always used. It does the same if any step here throws.
internal static class EchoCancellation
{
    // AUDIO_EFFECT_TYPE_* (ksmedia.h) this reports by name.
    internal static readonly Guid AcousticEchoCancellation = new("6f64adbe-8211-11e2-8c70-2c27d7f001fa");
    private static readonly Dictionary<Guid, string> EffectNames = new()
    {
        [AcousticEchoCancellation] = "AEC",
        [new Guid("6f64adbf-8211-11e2-8c70-2c27d7f001fa")] = "NS",
        [new Guid("6f64adc0-8211-11e2-8c70-2c27d7f001fa")] = "AGC",
        [new Guid("6f64adc1-8211-11e2-8c70-2c27d7f001fa")] = "BeamForming",
        [new Guid("6f64add0-8211-11e2-8c70-2c27d7f001fa")] = "DeepNS",
    };

    // MANA_VOICE_AEC (0/off/false or 1/on/true) overrides the Settings >
    // Voice checkbox; neither set means on.
    internal static bool IsEnabled(string? env, bool? setting) => env?.Trim().ToLowerInvariant() switch
    {
        "0" or "off" or "false" => false,
        "1" or "on" or "true" => true,
        _ => setting ?? true,
    };

    // Keep the communications stream only when Windows says an AEC effect
    // is on, or can't say at all (effects null, i.e. before build 22000).
    // If AEC is listed but off (e.g. the user turned Voice Clarity off),
    // their choice stands.
    internal static bool KeepCommunicationsCapture(IReadOnlyList<(Guid Id, bool On)>? effects) =>
        effects is null || effects.Any(e => e.Id == AcousticEchoCancellation && e.On);

    internal static string Describe(IReadOnlyList<(Guid Id, bool On)>? effects) =>
        effects is null ? "unknown"
        : effects.Count == 0 ? "none"
        : string.Join(",", effects.Select(e =>
            (EffectNames.TryGetValue(e.Id, out var name) ? name : e.Id.ToString()[..8]) + (e.On ? ":on" : ":off")));

    // Must run before capture.StartRecording(), which is where NAudio
    // initializes the stream.
    public static void RequestCommunicationsProcessing(WasapiCapture capture)
    {
        var properties = new AudioClientProperties
        {
            cbSize = (uint)Marshal.SizeOf<AudioClientProperties>(),
            eCategory = AudioStreamCategory.Communications,
        };
        Marshal.ThrowExceptionForHR(AudioClientOf(capture).SetClientProperties(ref properties));
    }

    // After StartRecording (the stream is initialized by then). Null when
    // this Windows can't report effects -- "unknown", not "none", so it
    // never costs the AEC by itself.
    public static IReadOnlyList<(Guid Id, bool On)>? GetEffects(WasapiCapture capture)
    {
        var iid = typeof(IAudioEffectsManager).GUID;
        if (AudioClientOf(capture).GetService(ref iid, out var service) < 0
            || service is not IAudioEffectsManager manager
            || manager.GetAudioEffects(out var array, out var count) < 0)
        {
            return null;
        }
        try
        {
            var size = Marshal.SizeOf<AudioEffect>();
            var effects = new List<(Guid, bool)>();
            for (var i = 0; i < count; i++)
            {
                var effect = Marshal.PtrToStructure<AudioEffect>(array + i * size);
                effects.Add((effect.Id, effect.State == 1)); // AUDIO_EFFECT_STATE_ON
            }
            return effects;
        }
        finally
        {
            Marshal.FreeCoTaskMem(array);
        }
    }

    // Best effort: a communications stream makes Windows lower other apps'
    // audio by 80% by default (Sound > Communications), and this capture is
    // open the whole time Mana listens. IAudioClientDuckingControl (build
    // 20348+) asks Windows not to; false when it's unavailable.
    // Never throws: this is optional, and mustn't cost the AEC.
    public static bool TryOptOutOfDucking(WasapiCapture capture)
    {
        try
        {
            var iid = typeof(IAudioClientDuckingControl).GUID;
            return AudioClientOf(capture).GetService(ref iid, out var service) >= 0
                && service is IAudioClientDuckingControl control
                && control.SetDuckingOptionsForCurrentStream(1) >= 0; // DO_NOT_DUCK_OTHER_STREAMS
        }
        catch (Exception ex) when (ex is COMException or InvalidCastException or InvalidOperationException)
        {
            return false;
        }
    }

    // NAudio 2.2.1 has no public way to set client properties on the stream
    // WasapiCapture opens, so this reads the two private fields holding it.
    // EchoCancellationTests pins these names, so an NAudio upgrade that
    // renames them fails a test instead of quietly logging "aec=failed".
    internal static readonly FieldInfo? CaptureClientField =
        typeof(WasapiCapture).GetField("audioClient", BindingFlags.NonPublic | BindingFlags.Instance);
    internal static readonly FieldInfo? ClientInterfaceField =
        typeof(AudioClient).GetField("audioClientInterface", BindingFlags.NonPublic | BindingFlags.Instance);

    private static IAudioClient2 AudioClientOf(WasapiCapture capture)
    {
        var client = CaptureClientField?.GetValue(capture) as AudioClient
            ?? throw new InvalidOperationException("NAudio's WasapiCapture.audioClient field wasn't found");
        return (IAudioClient2)(ClientInterfaceField?.GetValue(client)
            ?? throw new InvalidOperationException("NAudio's AudioClient.audioClientInterface field wasn't found"));
    }

    // Declared here rather than using NAudio's IAudioClient2, which inherits
    // IAudioClient in C#. COM interop doesn't lay out an inherited interface
    // as one vtable, so its SetClientProperties would call the wrong slot.
    // IAudioClient's methods are repeated in vtable order; only GetService
    // is ever called, the others just hold their slots.
    [ComImport, Guid("726778CD-F60A-4eda-82DE-E47610CD78AA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient2
    {
        void Initialize();
        void GetBufferSize();
        void GetStreamLatency();
        void GetCurrentPadding();
        void IsFormatSupported();
        void GetMixFormat();
        void GetDevicePeriod();
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle();
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
        void IsOffloadCapable();
        [PreserveSig] int SetClientProperties(ref AudioClientProperties properties);
    }

    [ComImport, Guid("4460B3AE-4B44-4527-8676-7548A8ACD260"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEffectsManager
    {
        void RegisterAudioEffectsChangedNotificationCallback();
        void UnregisterAudioEffectsChangedNotificationCallback();
        [PreserveSig] int GetAudioEffects(out IntPtr effects, out uint count);
    }

    [ComImport, Guid("C789D381-A28C-4168-B28F-D3A837924DC3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClientDuckingControl
    {
        [PreserveSig] int SetDuckingOptionsForCurrentStream(int options);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct AudioEffect
    {
        public Guid Id;
        public int CanSetState;
        public int State;
    }
}
