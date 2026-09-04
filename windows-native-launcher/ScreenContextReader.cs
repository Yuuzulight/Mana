using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
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
// Deliberately shells out to windows-launcher/scripts/read-accessibility-
// tree.ps1 -- reused unmodified, not reimplemented in C# via
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

    private readonly string scriptPath;
    private readonly ManaBackendClient backendClient;
    private int treeFailureCount;
    private string lastScreenText = "";
    private long lastReadAtMs = long.MinValue;

    public ScreenContextReader(string rootDirectory, ManaBackendClient backendClient)
    {
        scriptPath = Path.Combine(rootDirectory, "windows-launcher", "scripts", "read-accessibility-tree.ps1");
        this.backendClient = backendClient;
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
            var tree = await ReadAccessibilityTreeAsync();
            if (IsTreeUsable(tree, Environment.ProcessId))
            {
                lastScreenText = tree!.Value.Text;
                lastReadAtMs = now;
                return lastScreenText;
            }

            var imageDataUrl = CaptureScreenAsJpegDataUrl();
            var text = await backendClient.ReadScreenAsync(imageDataUrl);
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

    private static string CaptureScreenAsJpegDataUrl()
    {
        var bounds = Screen.PrimaryScreen!.Bounds;
        using var bitmap = new Bitmap(bounds.Width, bounds.Height);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
        }
        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Jpeg);
        return $"data:image/jpeg;base64,{Convert.ToBase64String(stream.ToArray())}";
    }
}
