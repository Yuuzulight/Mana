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

    private const int MaxMoves = 200;
    private const int MaxListed = 200;

    // folders: the settings' DesktopActionFolders (null = the defaults).
    public static object Run(string action, JsonElement args, IReadOnlyList<string>? folders = null) => action switch
    {
        "media" => PressMediaKey(RequiredString(args, "key")),
        "set_volume" => SetVolume(OptionalString(args, "app"), OptionalNumber(args, "level"), OptionalNumber(args, "change")),
        "open_app" => OpenApp(RequiredString(args, "name")),
        "focus_app" => FocusApp(RequiredString(args, "name")),
        "list_audio_outputs" => ListAudioOutputs(),
        "set_audio_output" => SetAudioOutput(RequiredString(args, "name")),
        "list_folder" => ListFolder(OptionalString(args, "path"), AllowedFolders(folders)),
        "move_files" => MoveFiles(StringList(args, "from"), RequiredString(args, "to"),
            args.TryGetProperty("exact", out var exact) && exact.ValueKind == JsonValueKind.True, AllowedFolders(folders)),
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

    // Desktop, Downloads, Pictures and Documents, unless the settings list
    // other folders (#997: Settings > Desktop; an empty list means none).
    // Only full local paths count (a hand-edited \server\share doesn't).
    internal static IReadOnlyList<string> AllowedFolders(IReadOnlyList<string>? configured) =>
        (configured is not null
            ? configured
            : new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                DownloadsFolder(),
                Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            })
        .Where(f => !string.IsNullOrWhiteSpace(f) && Path.IsPathFullyQualified(f) && !f.StartsWith(@"\\", StringComparison.Ordinal))
        .Select(f => Path.TrimEndingDirectorySeparator(Path.GetFullPath(f)))
        .ToList();

    private static string DownloadsFolder()
    {
        if (SHGetKnownFolderPath(new Guid("374DE290-123F-4565-9164-39C4925E467B"), 0, IntPtr.Zero, out var path) != 0)
        {
            return "";
        }
        try
        {
            return Marshal.PtrToStringUni(path) ?? "";
        }
        finally
        {
            Marshal.FreeCoTaskMem(path);
        }
    }

    // `path` as a full path, if it's inside one of `roots` (a root itself
    // only with allowRoot) with no symlink or junction on the way from the
    // root; otherwise throws. OneDrive placeholders are reparse points too,
    // but not links, so they pass.
    internal static string Allowed(string path, IReadOnlyList<string> roots, bool allowRoot = false)
    {
        // Relative, a device path, or an alternate data stream (a second ':').
        if (!Path.IsPathFullyQualified(path) || path.IndexOf(':', 2) >= 0)
        {
            throw new InvalidOperationException($"{path} isn't a plain full path");
        }
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        var root = roots.FirstOrDefault(r => IsInside(full, r));
        if (root is null || (!allowRoot && full.Length == root.Length))
        {
            throw new InvalidOperationException($"{path} isn't inside the folders I may use: {string.Join(", ", roots)}");
        }
        // Even if a drive root was allowed (#997 only warns about those).
        if (SystemFolders().Any(s => IsInside(full, s)))
        {
            throw new InvalidOperationException($"{path} is a system folder; I never move things there");
        }
        for (var dir = full; dir.Length > root.Length; dir = Path.GetDirectoryName(dir)!)
        {
            if (new DirectoryInfo(dir).LinkTarget is not null)
            {
                throw new InvalidOperationException($"{dir} is a link; I only use real folders");
            }
        }
        return full;
    }

    // `full` is `root` or somewhere under it.
    private static bool IsInside(string full, string root) =>
        full.Equals(root, StringComparison.OrdinalIgnoreCase)
        || full.StartsWith(Path.EndsInDirectorySeparator(root) ? root : root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private static IEnumerable<string> SystemFolders() =>
        new[] { Environment.SpecialFolder.Windows, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 }
            .Select(Environment.GetFolderPath)
            .Where(f => f.Length > 0);

    // #997: Settings > Desktop's check before adding an allowed folder.
    // Error: not a local folder, or Windows/Program Files. Warning (asks
    // first): a whole drive, or a folder apps keep their own files in.
    internal static (string? Error, string? Warning) CheckFolder(string path)
    {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal) || path.IndexOf(':', 2) >= 0)
        {
            return ("Only a folder on this PC, as a full path.", null);
        }
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        if (!Directory.Exists(full))
        {
            return ($"{full} doesn't exist.", null);
        }
        if (new DriveInfo(Path.GetPathRoot(full)!).DriveType == DriveType.Network)
        {
            return ("Only a folder on this PC, not a network drive.", null);
        }
        if (SystemFolders().Any(s => IsInside(full, s)))
        {
            return ($"{full} is a system folder; Mana never moves files there.", null);
        }
        if (full.Equals(Path.GetPathRoot(full), StringComparison.OrdinalIgnoreCase))
        {
            return (null, $"{full} is a whole drive: Mana could move anything on it (except Windows and Program Files). Add it anyway?");
        }
        var profile = Path.TrimEndingDirectorySeparator(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        var appFiles = new[] { Path.Combine(profile, "AppData"), Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData) }
            .Where(f => f.Length > 0);
        if (full.Equals(profile, StringComparison.OrdinalIgnoreCase) || appFiles.Any(a => IsInside(full, a)))
        {
            return (null, $"{full} holds apps' own files (settings, caches); moving things there can break them. Add it anyway?");
        }
        return (null, null);
    }

    // The allowed folders, or one folder's contents, newest first. Hidden
    // and system files are left out.
    internal static object ListFolder(string? path, IReadOnlyList<string> roots)
    {
        if (path is null)
        {
            return new { folders = roots };
        }
        var dir = new DirectoryInfo(Allowed(path, roots, allowRoot: true));
        if (!dir.Exists)
        {
            throw new InvalidOperationException($"{path} isn't a folder");
        }
        var entries = dir.EnumerateFileSystemInfos("*", new EnumerationOptions { AttributesToSkip = FileAttributes.Hidden | FileAttributes.System })
            .OrderByDescending(e => e.LastWriteTime)
            .ToList();
        return new
        {
            path = dir.FullName,
            total = entries.Count,
            entries = entries.Take(MaxListed)
                .Select(e => new { name = e.Name, folder = e is DirectoryInfo, modified = e.LastWriteTime.ToString("yyyy-MM-dd HH:mm") })
                .ToArray(),
        };
    }

    // Moves each of `from` into the folder `to`, or one item to the new
    // path `to` (a rename; also when exact, which undo uses). Both ends stay
    // inside the allowed folders; nothing is overwritten or deleted. Returns
    // what moved (the undo record) and what didn't.
    internal static object MoveFiles(IReadOnlyList<string> from, string to, bool exact, IReadOnlyList<string> roots)
    {
        if (from.Count is 0 or > MaxMoves)
        {
            throw new ArgumentException($"give 1 to {MaxMoves} paths to move");
        }
        var target = Allowed(to, roots, allowRoot: true);
        var into = !exact && Directory.Exists(target);
        if (!into && from.Count > 1)
        {
            throw new InvalidOperationException($"{to} isn't a folder");
        }
        var moved = new List<object>();
        var failed = new List<(string From, string Error)>();
        foreach (var path in from)
        {
            try
            {
                var source = Allowed(path, roots);
                var destination = Allowed(into ? Path.Combine(target, Path.GetFileName(source)) : target, roots);
                if (File.Exists(destination) || Directory.Exists(destination))
                {
                    throw new IOException($"{destination} already exists");
                }
                // "to" was meant as a folder that doesn't exist yet: don't
                // turn shot.png into a file called "Screenshots".
                if (!into && !exact && File.Exists(source)
                    && !Path.GetExtension(source).Equals(Path.GetExtension(destination), StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException($"{to} isn't a folder; to rename, keep the {Path.GetExtension(source)} extension");
                }
                if (File.Exists(source))
                {
                    File.Move(source, destination);
                }
                else if (Directory.Exists(source))
                {
                    Directory.Move(source, destination);
                }
                else
                {
                    throw new FileNotFoundException($"{path} doesn't exist");
                }
                moved.Add(new { from = source, to = destination });
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
            {
                failed.Add((path, ex.Message));
            }
        }
        return moved.Count > 0
            ? new { moved, failed = failed.Select(f => new { from = f.From, error = f.Error }).ToArray() }
            : throw new InvalidOperationException(string.Join("; ", failed.Select(f => f.Error)));
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

    // A string or an array of strings.
    private static List<string> StringList(JsonElement args, string key) =>
        !args.TryGetProperty(key, out var v) ? new()
        : v.ValueKind == JsonValueKind.String ? new() { v.GetString()! }
        : v.ValueKind == JsonValueKind.Array ? v.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToList()
        : new();

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

    [DllImport("shell32.dll")]
    private static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid rfid, uint dwFlags, IntPtr hToken, out IntPtr ppszPath);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);
}
