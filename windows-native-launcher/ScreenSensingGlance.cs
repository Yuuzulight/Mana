using System;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

// #690: Electron's ambient screen glance (windows-launcher renderer.js
// runScreenSensingGlance, #272/#283), ported. Opt-in with
// MANA_SCREEN_SENSING_ENABLED=1, every MANA_SCREEN_SENSING_INTERVAL_MS
// (default 2 minutes). Each glance reads the foreground window's text first
// (ScreenContextReader: UI Automation tree, OCR fallback) and POSTs that to
// /screen-sensing/glance; only when no usable text comes back does it
// capture the primary screen and send the image instead (Electron's only
// path). The backend summarizes either one and its attention gate decides
// whether that's worth showing; neither is kept here. Skipped while a
// turn is in flight or she's speaking, while gaming, and when nobody has
// touched the keyboard/mouse for MANA_SCREEN_SENSING_PRESENCE_IDLE_MS
// (default 90s). A surfaced summary shows in the chat as a message from
// Mana, not spoken -- same as Electron.
internal sealed class ScreenSensingGlance
{
    private readonly ManaBackendClient backendClient;
    private readonly Func<bool> voiceIdle;
    private readonly Func<bool> gamingModeActive;
    private readonly Func<long> idleMilliseconds;
    private readonly Func<Task<string>> readScreenText;
    private readonly Func<string> captureScreen;
    private readonly Action<string> surface;
    private readonly long presenceIdleMs;
    private bool running;

    public ScreenSensingGlance(
        ManaBackendClient backendClient,
        Func<bool> voiceIdle,
        Func<bool> gamingModeActive,
        Func<long> idleMilliseconds,
        Func<Task<string>> readScreenText,
        Func<string> captureScreen,
        Action<string> surface,
        long presenceIdleMs)
    {
        this.backendClient = backendClient;
        this.voiceIdle = voiceIdle;
        this.gamingModeActive = gamingModeActive;
        this.idleMilliseconds = idleMilliseconds;
        this.readScreenText = readScreenText;
        this.captureScreen = captureScreen;
        this.surface = surface;
        this.presenceIdleMs = presenceIdleMs;
    }

    // Called from a UI-thread timer, so `running` needs no lock. Never
    // throws: a failed glance is logged and the next tick tries again.
    public async Task RunOnceAsync()
    {
        if (running || !voiceIdle() || gamingModeActive() || idleMilliseconds() >= presenceIdleMs)
        {
            return;
        }
        running = true;
        try
        {
            // Off the UI thread: the OCR fallback's capture, or capturing
            // and JPEG-encoding a full screen, would hitch it (same as the
            // clip buffer's capture).
            var text = (await Task.Run(readScreenText)).Trim();
            var summary = IsUsableText(text)
                ? await backendClient.ScreenSensingGlanceAsync(text: text, image: null, gamingModeActive())
                : await backendClient.ScreenSensingGlanceAsync(text: null, image: await Task.Run(captureScreen), gamingModeActive());
            // Re-check: a turn may have started during the capture or the
            // vision call, and a glance shouldn't land on top of it.
            if (!string.IsNullOrWhiteSpace(summary) && voiceIdle())
            {
                surface(summary);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"ScreenSensingGlance: glance failed. {ex.Message}");
        }
        finally
        {
            running = false;
        }
    }

    // A few words at least -- less than that (an empty read, a stray OCR
    // fragment) says too little to summarize, so the image goes instead.
    internal const int MinTextChars = 20;

    internal static bool IsUsableText(string text) => text.Length >= MinTextChars;
}
