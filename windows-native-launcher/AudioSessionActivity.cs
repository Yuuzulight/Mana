using System;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

namespace Mana.NativeLauncher;

// #697: call and media awareness. Detects whether another application is
// currently capturing microphone audio (e.g. Discord, Teams, Zoom, game chat)
// or actively playing sound (e.g. media player, browser, voice call).
// When active, spoken proactive remarks are held while visual toasts still arrive.
internal interface IAudioSessionDetector
{
    bool IsAudioBusy();
}

internal sealed class WindowsAudioSessionDetector : IAudioSessionDetector
{
    public bool IsAudioBusy()
    {
        try
        {
            using var enumerator = new MMDeviceEnumerator();

            // Default render device (audio playback, media, music, call audio)
            if (IsDeviceBusy(enumerator, DataFlow.Render, Role.Multimedia))
            {
                return true;
            }

            // Default capture devices (voice communications, microphone input)
            if (IsDeviceBusy(enumerator, DataFlow.Capture, Role.Communications))
            {
                return true;
            }

            if (IsDeviceBusy(enumerator, DataFlow.Capture, Role.Multimedia))
            {
                return true;
            }

            return false;
        }
        catch
        {
            // CoreAudio unavailable, no audio endpoints connected, or COM failure
            return false;
        }
    }

    private static bool IsDeviceBusy(MMDeviceEnumerator enumerator, DataFlow dataFlow, Role role)
    {
        try
        {
            using var device = enumerator.GetDefaultAudioEndpoint(dataFlow, role);
            if (device is null)
            {
                return false;
            }

            var sessionManager = device.AudioSessionManager;
            if (sessionManager is null)
            {
                return false;
            }

            var sessions = sessionManager.Sessions;
            if (sessions is null)
            {
                return false;
            }

            var currentPid = (uint)Environment.ProcessId;
            for (var i = 0; i < sessions.Count; i++)
            {
                using var session = sessions[i];
                if (session is null)
                {
                    continue;
                }

                if (session.State == AudioSessionState.AudioSessionStateActive)
                {
                    var pid = session.GetProcessID;
                    // System sounds (0) or Mana's own launcher process are ignored;
                    // any other non-zero process ID indicates active third-party audio.
                    if (pid != 0 && pid != currentPid)
                    {
                        return true;
                    }
                }
            }
        }
        catch
        {
            // Device endpoint missing or query failed
        }

        return false;
    }
}
