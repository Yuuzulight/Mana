using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #522: ports windows-launcher's screen-context feature (issues #343/
// #344, both closed/shipped there) -- read the Windows UI Automation tree
// of the focused window first (fast, precise), falling back to
// screenshot+OCR (existing POST /screen/read) when the tree is disabled,
// times out, errors, or comes back too sparse to be worth using.
//
// Deliberately shells out to tools/read-accessibility-tree.ps1 (moved
// there from windows-launcher/scripts/ in #681) -- reused unmodified, not reimplemented in C# via
// System.Windows.Automation directly. That script's breadth-first tree
// walk (depth/element caps, char budget, PID detection) is already
// working, tested-in-production logic; re-deriving the same walk natively
// would risk subtle behavioral drift from windows-launcher's identical
// feature for no real benefit here.
internal sealed class ScreenContextReader
{
    private const int TreeTimeoutMs = 800;
    private const int DefaultTreeMaxChars = 1200;
    private const int MaxTreeFailures = 3;
    private const int MinIntervalMs = 8000;
    private const int GamingMinIntervalMs = 30000;
    // #671: no tree walk within this long of the last keyboard/mouse input.
    private const int InputQuietMs = 1000;

    // #671: apps whose UI Automation trees are known to be slow or hang.
    private static readonly string[] SlowTreeApps = { "outlook" };

    private readonly string scriptPath;
    private readonly ManaBackendClient backendClient;
    private readonly ScreenOcrGate ocrGate = new();
    private int treeFailureCount;
    private string lastScreenText = "";
    private long lastReadAtMs = long.MinValue;
    private long? previousTurnAtMs; // Q36: ReadAsync runs once per voice turn
    private readonly Func<Rectangle?>? avatarBounds;

    // avatarBounds (Q37): Mana's avatar on screen, or null while she's
    // hidden/minimized.
    public ScreenContextReader(string rootDirectory, ManaBackendClient backendClient, Func<Rectangle?>? avatarBounds = null)
    {
        this.avatarBounds = avatarBounds;
        // #681: shared with windows-launcher from tools/ (was under
        // windows-launcher/scripts/).
        scriptPath = Path.Combine(rootDirectory, "tools", "read-accessibility-tree.ps1");
        this.backendClient = backendClient;
    }

    // commandText should already be the turn's resolved command (not the
    // raw wake-word-prefixed transcript). Returns "" (not the previous
    // cached value) on any failure in the read path itself -- matches
    // windows-launcher's own readScreenContext, whose single catch block
    // does the same.
    public async Task<string> ReadAsync(string commandText, bool gamingModeActive)
    {
        var normalized = ScreenContextTrigger.CleanTranscriptText(commandText).ToLowerInvariant();
        // #648: "this"/"here" means whatever is under the mouse cursor
        // right now, which the cached read may not describe -- so a
        // deictic command skips the min interval and reads at the cursor.
        var atCursor = ScreenContextTrigger.IsDeictic(normalized) || ScreenContextTrigger.MeansNearAvatar(normalized);
        var now = Environment.TickCount64;
        var readsOnItsOwn = ScreenContextTrigger.ReadsScreenOnItsOwn(normalized, now - previousTurnAtMs);
        previousTurnAtMs = now;
        // #910: an explicit translate request always reads fresh, and its OCR
        // reads Japanese (JapaneseOcr).
        if (ScreenContextTrigger.AsksToTranslate(normalized))
        {
            return await ReadForegroundAsync(atCursor, normalized, now, translate: true);
        }
        var minInterval = gamingModeActive ? GamingMinIntervalMs : MinIntervalMs;
        if (!atCursor && lastScreenText.Length > 0 && now - lastReadAtMs < minInterval)
        {
            return lastScreenText;
        }

        // Issue #344's own override, ported: set to "0" to restore the
        // old always-read-outside-gaming behavior.
        var keywordGateEnabled = Environment.GetEnvironmentVariable("MANA_SCREEN_CONTEXT_KEYWORD_GATE") != "0";
        if (!readsOnItsOwn && !ScreenContextTrigger.ShouldReadScreenForCommand(normalized, gamingModeActive, keywordGateEnabled))
        {
            return lastScreenText;
        }

        return await ReadForegroundAsync(atCursor, normalized, now);
    }

    // #690: the ambient glance's read -- the foreground window as it is now
    // (tree first, OCR fallback), no command or interval gate. "" when
    // nothing usable came back.
    public Task<string> ReadForGlanceAsync() => ReadForegroundAsync(atCursor: false, normalized: "", Environment.TickCount64);

    private async Task<string> ReadForegroundAsync(bool atCursor, string normalized, long now, bool translate = false)
    {
        try
        {
            var window = GetForegroundWindow();
            GetWindowThreadProcessId(window, out var windowPid);
            // #671: Mana's own UI in front is a self-description, not
            // context -- skip both the tree walk and OCR.
            if (windowPid == Environment.ProcessId)
            {
                return "";
            }

            if (!ShouldSkipTreeWalk(windowPid, atCursor))
            {
                var tree = await ReadAccessibilityTreeAsync(atCursor ? ReadPoint(normalized) : null);
                if (IsTreeUsable(tree, Environment.ProcessId))
                {
                    lastScreenText = tree!.Value.Text;
                    lastReadAtMs = now;
                    return lastScreenText;
                }
            }

            // #671: OCR just the foreground window, and only when it
            // changed since the last OCR (ScreenOcrGate).
            using var bitmap = ScreenCapture.Capture(ForegroundBounds(window));
            if (translate)
            {
                // Not cached: the next ordinary turn shouldn't get
                // JapaneseOcr's vision__look note as its screen text.
                return await JapaneseOcr.ReadAsync(bitmap);
            }
            var text = await ocrGate.ReadAsync(
                window,
                ScreenOcrGate.DifferenceHash(bitmap),
                () => backendClient.ReadScreenAsync(ScreenCapture.ToJpegDataUrl(bitmap)));
            lastScreenText = text;
            lastReadAtMs = now;
            return lastScreenText;
        }
        catch
        {
            return "";
        }
    }

    // #522 review: pulled out of ReadAsync so the fallback-to-OCR
    // decision (own-window check + usability threshold) is testable
    // without spawning a process. false for a null tree (disabled/gave
    // up/timed out/errored) or one whose ownerPid is this launcher's own
    // -- reading our own window is a self-description, not real context,
    // same as OCR-on-screenshot already treats it.
    internal static bool IsTreeUsable(AccessibilityTreeResult? tree, int ownProcessId) =>
        tree is { } t && t.OwnerPid != ownProcessId && AccessibilityTreeOutputParser.IsUsable(t.Text);

    // #648/Q37: where a deictic read starts -- beside the avatar for "next
    // to you"/"behind you", else the cursor (physical pixels, what UI
    // Automation hit-tests in; Cursor.Position is DPI-virtualized on a
    // monitor whose scale differs from ours). null: the focused element.
    // ponytail: avatar bounds are logical pixels, so on a mixed-DPI setup the avatar point can be off; convert with LogicalToPhysicalPointForPerMonitorDPI if that shows up.
    private Point? ReadPoint(string normalized)
    {
        if (ScreenContextTrigger.MeansNearAvatar(normalized) && avatarBounds?.Invoke() is Rectangle avatar)
        {
            return BesideAvatar(avatar, SystemInformation.VirtualScreen);
        }
        return GetPhysicalCursorPos(out var cursor) ? cursor : null;
    }

    // Just left of her window at mid-height (her own pixels would hit-test
    // as Mana, which the script skips), or just right of it at the left
    // edge of the desktop.
    internal static Point BesideAvatar(Rectangle avatar, Rectangle desktop)
    {
        const int gap = 40;
        var y = avatar.Top + (avatar.Height / 2);
        return avatar.Left - gap >= desktop.Left ? new Point(avatar.Left - gap, y) : new Point(avatar.Right + gap, y);
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool GetPhysicalCursorPos(out Point point);

    // Returns null when the tree read is disabled/gave up for this
    // session/timed out/errored/exited non-zero -- all of those (except
    // the disabled/gave-up gate itself) increment treeFailureCount, same
    // circuit-breaker shape as windows-launcher's own
    // accessibilityTreeFailureCount. A successful parse whose ownerPid
    // turns out to be this launcher's own process is NOT a failure (the
    // script did its job correctly) -- that check happens in the caller.
    private async Task<AccessibilityTreeResult?> ReadAccessibilityTreeAsync(Point? readAt)
    {
        if (Environment.GetEnvironmentVariable("MANA_ACCESSIBILITY_TREE_ENABLED") == "0" || treeFailureCount >= MaxTreeFailures)
        {
            return null;
        }

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "powershell",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true,
            },
        };
        process.StartInfo.ArgumentList.Add("-NoProfile");
        process.StartInfo.ArgumentList.Add("-ExecutionPolicy");
        process.StartInfo.ArgumentList.Add("Bypass");
        process.StartInfo.ArgumentList.Add("-File");
        process.StartInfo.ArgumentList.Add(scriptPath);
        var maxCharsEnv = Environment.GetEnvironmentVariable("MANA_ACCESSIBILITY_TREE_MAX_CHARS");
        var maxChars = int.TryParse(maxCharsEnv, out var parsedMaxChars) ? parsedMaxChars : DefaultTreeMaxChars;
        process.StartInfo.ArgumentList.Add("-MaxChars");
        process.StartInfo.ArgumentList.Add(maxChars.ToString());
        // #648: read from the element at readAt (see ReadPoint). Our own
        // windows (avatar, captions) there are skipped in favor of the
        // focused element, as before.
        if (readAt is Point cursor)
        {
            process.StartInfo.ArgumentList.Add("-AtPoint");
            process.StartInfo.ArgumentList.Add("-PointX");
            process.StartInfo.ArgumentList.Add(cursor.X.ToString(System.Globalization.CultureInfo.InvariantCulture));
            process.StartInfo.ArgumentList.Add("-PointY");
            process.StartInfo.ArgumentList.Add(cursor.Y.ToString(System.Globalization.CultureInfo.InvariantCulture));
            process.StartInfo.ArgumentList.Add("-IgnorePointPid");
            process.StartInfo.ArgumentList.Add(Environment.ProcessId.ToString());
        }

        using var cts = new CancellationTokenSource(TreeTimeoutMs);
        try
        {
            process.Start();
            var stdout = await process.StandardOutput.ReadToEndAsync(cts.Token);
            await process.WaitForExitAsync(cts.Token);
            if (process.ExitCode != 0)
            {
                treeFailureCount++;
                return null;
            }
            return AccessibilityTreeOutputParser.Parse(stdout);
        }
        catch
        {
            try { process.Kill(); } catch { /* already exited */ }
            treeFailureCount++;
            return null;
        }
    }

    // #671: UI-tree budgets on top of the timeout/caps above. Walking the
    // tree of the app being typed into can stall its input, and some apps'
    // trees are slow enough to burn the whole timeout for nothing -- both
    // go straight to OCR. "In use" is Windows' own last-input time (Q2:
    // GetLastInputInfo, no keyboard listener), so mouse movement counts too.
    // A pointing read (#648: "what's this?", "next to you") is exempt from
    // the in-use skip: the mouse is often still moving onto the thing meant,
    // and it asked for exactly that spot. The slow-app skip still applies.
    private static bool ShouldSkipTreeWalk(int windowPid, bool atCursor) =>
        SkipTreeWalk(atCursor, SystemIdle.GetIdleMilliseconds(), ProcessNameOf(windowPid));

    internal static bool SkipTreeWalk(bool atCursor, long? idleMs, string processName) =>
        (!atCursor && InUse(idleMs)) || IsSlowTreeApp(processName);

    // Unknown idle time (the call failed) never counts as in use.
    internal static bool InUse(long? idleMs) => idleMs < InputQuietMs;

    internal static bool IsSlowTreeApp(string processName) =>
        SlowTreeApps.Contains(processName, StringComparer.OrdinalIgnoreCase);

    private static string ProcessNameOf(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.ProcessName;
        }
        catch
        {
            return "";
        }
    }

    // The foreground window's rect clipped to the desktop; the whole
    // primary screen (the old behavior) when there's no usable window.
    private static Rectangle ForegroundBounds(IntPtr window)
    {
        var bounds = GetWindowRect(window, out var rect)
            ? Rectangle.Intersect(Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom), SystemInformation.VirtualScreen)
            : Rectangle.Empty;
        return bounds.Width > 0 && bounds.Height > 0 ? bounds : Screen.PrimaryScreen!.Bounds;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr hWnd, out NativeRect rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
