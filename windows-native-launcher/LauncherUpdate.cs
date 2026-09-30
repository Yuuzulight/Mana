using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;

namespace Mana.NativeLauncher;

// #995: staged launcher updates. update-mana.ps1 builds the new launcher
// into "<live>.staging" beside the running one and marks it ready. The
// running launcher hands off by starting the staged exe with
// --install-update and exiting; that process (running from staging) moves
// the old build to "<live>.previous", copies itself into the live folder
// and starts it. The new build proves it starts by writing a marker once
// its message loop is idle; if it doesn't, the previous build goes back.
internal static class LauncherUpdate
{
    public const string InstallArg = "--install-update";
    public const string UpdatedArg = "--updated";
    public const string ReadyMarker = "update-ready";
    public const string StartedMarker = "startup-ok";
    public const string RolledBackNote = "update-rolled-back";
    private const string ExeName = "ManaNativeLauncher.exe";

    public static string LiveDir => Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory);
    public static string StagingDir(string live) => live + ".staging";
    public static string PreviousDir(string live) => live + ".previous";

    private const string ChatArg = "--chat";

    // The chat window, handed to the next build when it was open.
    public static string[] ChatBoundsArgs(Rectangle bounds) =>
        [ChatArg, $"{bounds.X},{bounds.Y},{bounds.Width},{bounds.Height}"];

    public static Rectangle? ChatBoundsFrom(IReadOnlyList<string> args)
    {
        var at = args.ToList().IndexOf(ChatArg);
        if (at < 0 || at + 1 >= args.Count)
        {
            return null;
        }
        var parts = args[at + 1].Split(',');
        return parts.Length == 4 && parts.All(p => int.TryParse(p, out _))
            ? new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]))
            : null;
    }

    public static bool IsStaged(string live) =>
        File.Exists(Path.Combine(StagingDir(live), ReadyMarker)) && File.Exists(Path.Combine(StagingDir(live), ExeName));

    // The running launcher's half: start the staged build as the installer,
    // then exit. handoff is passed on to the build that ends up running.
    public static void StartInstaller(string live, IEnumerable<string> handoff)
    {
        var startInfo = new ProcessStartInfo(Path.Combine(StagingDir(live), ExeName)) { UseShellExecute = false };
        startInfo.ArgumentList.Add(InstallArg);
        startInfo.ArgumentList.Add(Environment.ProcessId.ToString());
        foreach (var arg in handoff)
        {
            startInfo.ArgumentList.Add(arg);
        }
        Process.Start(startInfo)?.Dispose();
    }

    // The staged build's half, run from the staging folder. True if the new
    // build is running, false if it failed its self-check and the previous
    // one was put back (and started).
    public static bool RunInstaller(string staging, int oldPid, IReadOnlyList<string> handoff, TimeSpan selfCheck)
    {
        if (!staging.EndsWith(".staging", StringComparison.OrdinalIgnoreCase))
        {
            return false; // only a staged build installs itself
        }
        WaitForExit(oldPid);
        var live = staging[..^".staging".Length];
        var previous = PreviousDir(live);
        // Removed first, so a build that fails is never installed twice.
        File.Delete(Path.Combine(staging, ReadyMarker));
        try
        {
            Swap(live, staging, previous);
            if (StartsCleanly(live, [UpdatedArg, .. handoff], selfCheck))
            {
                return true;
            }
            Rollback(live, previous);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Swap already put the old build back if it got that far.
        }
        File.WriteAllText(Path.Combine(live, RolledBackNote), "");
        Start(live, handoff)?.Dispose();
        return false;
    }

    // The old build becomes the previous one (replacing any older one) and
    // the staged build is copied in; a failed copy puts the old one back.
    internal static void Swap(string live, string staging, string previous)
    {
        if (Directory.Exists(previous))
        {
            Retry(() => Directory.Delete(previous, recursive: true));
        }
        Retry(() => Directory.Move(live, previous));
        try
        {
            CopyDirectory(staging, live);
        }
        catch
        {
            Rollback(live, previous);
            throw;
        }
    }

    internal static void Rollback(string live, string previous)
    {
        if (Directory.Exists(live))
        {
            Retry(() => Directory.Delete(live, recursive: true));
        }
        Retry(() => Directory.Move(previous, live));
    }

    private static bool StartsCleanly(string live, IEnumerable<string> args, TimeSpan timeout)
    {
        var marker = Path.Combine(live, StartedMarker);
        File.Delete(marker);
        using var process = Start(live, args);
        if (process is null)
        {
            return false;
        }
        var deadline = DateTime.UtcNow + timeout;
        while (!File.Exists(marker))
        {
            if (process.HasExited)
            {
                return false;
            }
            if (DateTime.UtcNow >= deadline)
            {
                KillQuietly(process);
                return false;
            }
            Thread.Sleep(250);
        }
        File.Delete(marker);
        // Up, and still up a few seconds later.
        if (process.WaitForExit(TimeSpan.FromSeconds(5)))
        {
            return false;
        }
        return true;
    }

    private static Process? Start(string live, IEnumerable<string> args)
    {
        var startInfo = new ProcessStartInfo(Path.Combine(live, ExeName)) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = live };
        foreach (var arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }
        return Process.Start(startInfo);
    }

    private static void WaitForExit(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            // Its graceful shutdown stops every service first.
            process.WaitForExit(TimeSpan.FromMinutes(2));
        }
        catch (ArgumentException)
        {
            // Already gone.
        }
    }

    private static void KillQuietly(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit(TimeSpan.FromSeconds(10));
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
        }
    }

    private static void CopyDirectory(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var dir in Directory.GetDirectories(from, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(to, Path.GetRelativePath(from, dir)));
        }
        foreach (var file in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
        {
            File.Copy(file, Path.Combine(to, Path.GetRelativePath(from, file)));
        }
    }

    // A folder whose exe just exited can stay locked for a moment
    // (antivirus, the loader).
    private static void Retry(Action action)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                action();
                return;
            }
            catch (Exception ex) when (attempt < 10 && ex is IOException or UnauthorizedAccessException)
            {
                Thread.Sleep(500);
            }
        }
    }
}
