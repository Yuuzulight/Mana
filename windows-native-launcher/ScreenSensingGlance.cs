using System;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

// #690: Electron's ambient screen glance (windows-launcher renderer.js
// runScreenSensingGlance, #272/#283), ported. Opt-in with
// MANA_SCREEN_SENSING_ENABLED=1, every MANA_SCREEN_SENSING_INTERVAL_MS
// (default 2 minutes). Each glance captures the primary screen and POSTs it
// to /screen-sensing/glance, whose attention gate decides whether the
// summary is worth showing; the image is never kept here. Skipped while a
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
    private readonly Func<string> captureScreen;
    private readonly Action<string> surface;
    private readonly long presenceIdleMs;
    private bool running;

    public ScreenSensingGlance(
        ManaBackendClient backendClient,
        Func<bool> voiceIdle,
        Func<bool> gamingModeActive,
        Func<long> idleMilliseconds,
        Func<string> captureScreen,
        Action<string> surface,
        long presenceIdleMs)
    {
        this.backendClient = backendClient;
        this.voiceIdle = voiceIdle;
        this.gamingModeActive = gamingModeActive;
        this.idleMilliseconds = idleMilliseconds;
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
            // Off the UI thread: capturing and JPEG-encoding a full screen
            // would hitch it (same as the clip buffer's capture).
            var image = await Task.Run(captureScreen);
            var summary = await backendClient.ScreenSensingGlanceAsync(image, gamingModeActive());
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
}
