using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace Mana.NativeLauncher;

// #689: one launcher per Windows session -- two would fight over the mic,
// the hotkeys and the backend. A second start asks the first to show its
// chat window, then exits.
internal static class SingleInstance
{
    private const string DefaultName = "Mana.NativeLauncher"; // tests pass their own

    // The held mutex (keep it alive for the process), or null if another
    // launcher already runs -- that one has then been asked to show itself.
    public static Mutex? Claim(string name = DefaultName)
    {
        var mutex = new Mutex(true, $@"Local\{name}", out var first);
        if (first)
        {
            return mutex;
        }
        mutex.Dispose();
        AllowSetForegroundWindow(AsfwAny); // so the first launcher may take focus
        if (EventWaitHandle.TryOpenExisting($@"Local\{name}.Show", out var show))
        {
            using (show)
            {
                show.Set();
            }
        }
        return null;
    }

    // Runs onShow (on a thread-pool thread) each time a second launcher starts.
    public static IDisposable ListenForShow(Action onShow, string name = DefaultName)
    {
        var show = new EventWaitHandle(false, EventResetMode.AutoReset, $@"Local\{name}.Show");
        var registration = ThreadPool.RegisterWaitForSingleObject(show, (_, _) => onShow(), null, Timeout.Infinite, executeOnlyOnce: false);
        return new Listener(show, registration);
    }

    private sealed class Listener(EventWaitHandle show, RegisteredWaitHandle registration) : IDisposable
    {
        public void Dispose()
        {
            registration.Unregister(null);
            show.Dispose();
        }
    }

    private const int AsfwAny = -1;

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int processId);
}
