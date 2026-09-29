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
    // #671: no tree walk within this long of the last keystroke.
    private const int TypingQuietMs = 1000;

    // #671: apps whose UI Automation trees are known to be slow or hang.
    private static readonly string[] SlowTreeApps = { "outlook" };

    private readonly string scriptPath;
    private readonly ManaBackendClient backendClient;
    private readonly ScreenOcrGate ocrGate = new();
    private readonly KeyboardActivity keyboard;
    private int treeFailureCount;
    private string lastScreenText = "";
    private long lastReadAtMs = long.MinValue;

    public ScreenContextReader(string rootDirectory, ManaBackendClient backendClient)
    {
        // #681: shared with windows-launcher from tools/ (was under
        // windows-launcher/scripts/).
        scriptPath = Path.Combine(rootDirectory, "tools", "read-accessibility-tree.ps1");
        this.backendClient = backendClient;
        // Constructed on the UI thread (ManaApplicationContext), whose
        // message loop then delivers WM_INPUT to it.
        keyboard = new KeyboardActivity();
    }

    // commandText should already be the turn's resolved command (not the
    // raw wake-word-prefixed transcript). Returns "" (not the previous
    // cached value) on any failure in the read path itself -- matches
    // windows-launcher's own readScreenContext, whose single catch block
    // does the same.
    public async Task<string> ReadAsync(string commandText, bool gamingModeActive)
    {
        var now = Environment.TickCount64;
        var minInterval = gamingModeActive ? GamingMinIntervalMs : MinIntervalMs;
        if (lastScreenText.Length > 0 && now - lastReadAtMs < minInterval)
        {
            return lastScreenText;
        }

        var normalized = ScreenContextTrigger.CleanTranscriptText(commandText).ToLowerInvariant();
        // Issue #344's own override, ported: set to "0" to restore the
        // old always-read-outside-gaming behavior.
        var keywordGateEnabled = Environment.GetEnvironmentVariable("MANA_SCREEN_CONTEXT_KEYWORD_GATE") != "0";
        if (!ScreenContextTrigger.ShouldReadScreenForCommand(normalized, gamingModeActive, keywordGateEnabled))
        {
            return lastScreenText;
        }

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

            if (!ShouldSkipTreeWalk(windowPid))
            {
                var tree = await ReadAccessibilityTreeAsync();
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

    // Returns null when the tree read is disabled/gave up for this
    // session/timed out/errored/exited non-zero -- all of those (except
    // the disabled/gave-up gate itself) increment treeFailureCount, same
    // circuit-breaker shape as windows-launcher's own
    // accessibilityTreeFailureCount. A successful parse whose ownerPid
    // turns out to be this launcher's own process is NOT a failure (the
    // script did its job correctly) -- that check happens in the caller.
    private async Task<AccessibilityTreeResult?> ReadAccessibilityTreeAsync()
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
    // go straight to OCR.
    private bool ShouldSkipTreeWalk(int windowPid) =>
        Environment.TickCount64 - keyboard.LastKeyAtMs < TypingQuietMs
        || IsSlowTreeApp(ProcessNameOf(windowPid));

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

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RegisterRawInputDevices(RawInputDevice[] devices, uint count, uint size);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawInputDevice
    {
        public ushort UsagePage;
        public ushort Usage;
        public uint Flags;
        public IntPtr Target;
    }

    // #671: when the last keystroke happened anywhere on the system, from
    // keyboard raw input delivered to a hidden window. Only WM_INPUT's
    // arrival is timestamped -- the key data itself is never read. Raw
    // input registration is per process and device type, so another
    // keyboard registration in the launcher would take this one over.
    // If registration fails, nothing ever counts as typing (the old
    // always-walk behavior).
    private sealed class KeyboardActivity : NativeWindow
    {
        private const int WmInput = 0x00FF;
        private const uint RidevInputSink = 0x00000100;
        private long lastKeyAtMs;

        public KeyboardActivity()
        {
            CreateHandle(new CreateParams());
            var keyboardDevice = new RawInputDevice { UsagePage = 0x01, Usage = 0x06, Flags = RidevInputSink, Target = Handle };
            RegisterRawInputDevices(new[] { keyboardDevice }, 1, (uint)Marshal.SizeOf<RawInputDevice>());
        }

        public long LastKeyAtMs => Interlocked.Read(ref lastKeyAtMs);

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WmInput)
            {
                Interlocked.Exchange(ref lastKeyAtMs, Environment.TickCount64);
            }
            base.WndProc(ref m);
        }
    }
}
