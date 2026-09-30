using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using NAudio.CoreAudioApi;

namespace Mana.NativeLauncher;

// #911: the launcher's half of node-bot's desktop__* tools
// (ai/desktop-tool-source.js), relayed by VisionCaptureClient. node-bot's
// risk gate has already allowed the call; this is the trust boundary for
// the arguments. Media keys are the only simulated input -- no clicks or
// typing into other apps. Errors are thrown with a message Mana can repeat.
internal static class DesktopActions
{
    private static readonly Dictionary<string, byte> MediaKeys = new()
    {
        ["play_pause"] = 0xB3, // VK_MEDIA_PLAY_PAUSE
        ["next"] = 0xB0,       // VK_MEDIA_NEXT_TRACK
        ["previous"] = 0xB1,   // VK_MEDIA_PREV_TRACK
    };

    public static object Run(string action, JsonElement args) => action switch
    {
        "media" => PressMediaKey(RequiredString(args, "key")),
        "set_volume" => SetVolume(OptionalString(args, "app"), OptionalNumber(args, "level"), OptionalNumber(args, "change")),
        "open_app" => OpenApp(RequiredString(args, "name")),
        "focus_app" => FocusApp(RequiredString(args, "name")),
        "list_audio_outputs" => ListAudioOutputs(),
        "set_audio_output" => SetAudioOutput(RequiredString(args, "name")),
        _ => throw new ArgumentException($"unknown desktop action: {action}"),
    };

    private static object PressMediaKey(string key)
    {
        if (!MediaKeys.TryGetValue(key, out var vk))
        {
            throw new ArgumentException($"unknown media key: {key}");
        }
        keybd_event(vk, 0, KeyEventExtendedKey, UIntPtr.Zero);
        keybd_event(vk, 0, KeyEventExtendedKey | KeyEventKeyUp, UIntPtr.Zero);
        return new { key };
    }

    // The default output's master volume, or every audio session of one
    // app. Never Mana's own sessions (#893: her playback must not move
    // anything else, and nothing here moves hers).
    private static object SetVolume(string? app, double? level, double? change)
    {
        NewLevel(0, level, change); // bad arguments fail before any audio is touched
        using var enumerator = new MMDeviceEnumerator();
        using var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
        if (app is null)
        {
            var endpoint = device.AudioEndpointVolume;
            endpoint.MasterVolumeLevelScalar = NewLevel(endpoint.MasterVolumeLevelScalar, level, change);
            return new { level = Percent(endpoint.MasterVolumeLevelScalar), muted = endpoint.Mute };
        }
        if (IsMana(app))
        {
            throw new InvalidOperationException("Mana's own voice volume is in Mana's settings, not here");
        }
        var sessions = device.AudioSessionManager.Sessions;
        float? newLevel = null;
        for (var i = 0; i < sessions.Count; i++)
        {
            var session = sessions[i];
            var pid = (int)session.GetProcessID;
            if (pid == 0 || pid == Environment.ProcessId || !NameMatches(app, ProcessName(pid)))
            {
                continue;
            }
            var volume = session.SimpleAudioVolume;
            volume.Volume = NewLevel(volume.Volume, level, change);
            newLevel = volume.Volume;
        }
        return newLevel is float set
            ? new { app, level = Percent(set) }
            : throw new InvalidOperationException($"{app} isn't playing any sound right now");
    }

    // level (0-100) or change (-100..100 points) -> the new 0..1 scalar.
    internal static float NewLevel(float current, double? level, double? change)
    {
        if (level is null == change is null)
        {
            throw new ArgumentException("give either level or change");
        }
        var target = level is double l ? l / 100 : current + change!.Value / 100;
        return (float)Math.Clamp(double.IsFinite(target) ? target : current, 0, 1);
    }

    private static int Percent(float scalar) => (int)Math.Round(scalar * 100);

    // Brings its window forward if it's open, else starts its Start-menu
    // shortcut -- never an arbitrary path.
    private static object OpenApp(string name)
    {
        // By process only: a browser tab titled "Discord" isn't Discord.
        if (FindWindow(name, byTitle: false) is IntPtr window)
        {
            return new { name, opened = false, focused = BringToFront(window) };
        }
        var shortcut = FindShortcut(StartMenuShortcuts(), name);
        Process.Start(new ProcessStartInfo(shortcut) { UseShellExecute = true })?.Dispose();
        return new { name = Path.GetFileNameWithoutExtension(shortcut), opened = true, focused = false };
    }

    private static object FocusApp(string name)
    {
        var window = FindWindow(name, byTitle: true) ?? throw new InvalidOperationException($"{name} isn't open");
        return new { name, focused = BringToFront(window) };
    }

    // The .lnk files in the all-users and my own Start menu.
    private static IEnumerable<string> StartMenuShortcuts()
    {
        var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true };
        return new[] { Environment.SpecialFolder.CommonPrograms, Environment.SpecialFolder.Programs }
            .Select(Environment.GetFolderPath)
            .Where(Directory.Exists)
            .SelectMany(dir => Directory.EnumerateFiles(dir, "*.lnk", options));
    }

    // The shortcut picked by PickByName. Uninstallers are never offered.
    internal static string FindShortcut(IEnumerable<string> shortcuts, string name)
    {
        var byName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in shortcuts)
        {
            var app = Path.GetFileNameWithoutExtension(path);
            if (!app.Contains("uninstall", StringComparison.OrdinalIgnoreCase))
            {
                byName.TryAdd(app, path);
            }
        }
        return byName[PickByName(byName.Keys, name, "Start-menu app")];
    }

    // The name that is exactly `name` (case, spaces and punctuation
    // ignored), else the only one containing it.
    internal static string PickByName(IEnumerable<string> names, string name, string what)
    {
        var all = names.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var exact = all.FirstOrDefault(n => Normalize(n) == Normalize(name));
        if (exact is not null)
        {
            return exact;
        }
        var partial = all.Where(n => Normalize(n).Contains(Normalize(name))).ToList();
        return partial.Count switch
        {
            1 => partial[0],
            0 => throw new InvalidOperationException($"no {what} called {name}"),
            _ => throw new InvalidOperationException($"which one: {string.Join(", ", partial.Take(5))}?"),
        };
    }

    private static object ListAudioOutputs()
    {
        using var enumerator = new MMDeviceEnumerator();
        var current = enumerator.HasDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)
            ? enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia).ID
            : null;
        return new
        {
            outputs = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
                .Select(d => new { name = d.FriendlyName, current = d.ID == current })
                .ToArray(),
        };
    }

    // Makes it the default output for every role (console, multimedia,
    // communications), as the Sound settings page does.
    private static object SetAudioOutput(string name)
    {
        using var enumerator = new MMDeviceEnumerator();
        var devices = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active).ToList();
        var chosen = PickByName(devices.Select(d => d.FriendlyName), name, "audio output");
        var id = devices.First(d => d.FriendlyName.Equals(chosen, StringComparison.OrdinalIgnoreCase)).ID;
        var policy = (IPolicyConfig)new PolicyConfigClient();
        try
        {
            for (var role = 0; role < 3; role++)
            {
                Marshal.ThrowExceptionForHR(policy.SetDefaultEndpoint(id, role));
            }
        }
        finally
        {
            Marshal.ReleaseComObject(policy);
        }
        return new { name = chosen };
    }

    // A visible, titled window whose process is `name` (spaces and case
    // ignored), else (byTitle) one whose title contains it. Never Mana's own.
    private static IntPtr? FindWindow(string name, bool byTitle)
    {
        var windows = new List<(IntPtr Handle, string Process, string Title)>();
        var names = new Dictionary<uint, string>();
        EnumWindows((hwnd, _) =>
        {
            var length = GetWindowTextLength(hwnd);
            GetWindowThreadProcessId(hwnd, out var pid);
            if (length > 0 && IsWindowVisible(hwnd) && pid != Environment.ProcessId)
            {
                var title = new StringBuilder(length + 1);
                GetWindowText(hwnd, title, title.Capacity);
                if (!names.TryGetValue(pid, out var process))
                {
                    names[pid] = process = ProcessName((int)pid);
                }
                windows.Add((hwnd, process, title.ToString()));
            }
            return true;
        }, IntPtr.Zero);
        return PickWindow(windows, name, byTitle);
    }

    internal static IntPtr? PickWindow(IReadOnlyList<(IntPtr Handle, string Process, string Title)> windows, string name, bool byTitle) =>
        windows.Where(w => NameMatches(name, w.Process))
            .Concat(windows.Where(w => byTitle && w.Title.Contains(name, StringComparison.OrdinalIgnoreCase)))
            .Select(w => (IntPtr?)w.Handle)
            .FirstOrDefault();

    // Windows only lets the process that had the last input take the
    // foreground; an empty mouse input makes that us (PowerToys does the same).
    private static bool BringToFront(IntPtr window)
    {
        if (IsIconic(window))
        {
            ShowWindow(window, SwRestore);
        }
        mouse_event(0, 0, 0, 0, UIntPtr.Zero);
        return SetForegroundWindow(window);
    }

    internal static bool NameMatches(string requested, string processName) =>
        Normalize(processName) is { Length: > 0 } process && process == Normalize(requested);

    internal static bool IsMana(string name) => Normalize(name) is "mana" or "mananativelauncher";

    private static string Normalize(string s) => new(s.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    private static string ProcessName(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.ProcessName;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return ""; // exited already
        }
    }

    private static string RequiredString(JsonElement args, string key) =>
        OptionalString(args, key) ?? throw new ArgumentException($"{key} is required");

    private static string? OptionalString(JsonElement args, string key) =>
        args.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString())
            ? v.GetString()!.Trim()
            : null;

    private static double? OptionalNumber(JsonElement args, string key) =>
        args.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    private const uint KeyEventExtendedKey = 0x0001;
    private const uint KeyEventKeyUp = 0x0002;
    private const int SwRestore = 9;

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    // Windows has no public API for changing the default output; this is
    // the undocumented interface the Sound settings use (and EarTrumpet,
    // SoundSwitch). Only SetDefaultEndpoint is called; the slots before it
    // just keep the vtable order.
    [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPolicyConfig
    {
        void GetMixFormat();
        void GetDeviceFormat();
        void ResetDeviceFormat();
        void SetDeviceFormat();
        void GetProcessingPeriod();
        void SetProcessingPeriod();
        void GetShareMode();
        void SetShareMode();
        void GetPropertyValue();
        void SetPropertyValue();
        [PreserveSig]
        int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
    }

    [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
    private class PolicyConfigClient
    {
    }

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);
}
