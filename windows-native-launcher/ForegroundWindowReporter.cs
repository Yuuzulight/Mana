using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

// #697 part 1 (Q9): tells node-bot which app is in front whenever the
// foreground window changes (POST /internal/foreground-report), so the
// proactive pipeline knows it -- first use: alt-tabbing out of a game is a
// break where a held remark may go out. Event-driven (SetWinEventHook), no
// polling; the callback arrives on the UI thread's message loop. Mana's own
// windows are skipped, and a repeat of the last app + title isn't re-sent.
internal sealed class ForegroundWindowReporter : IDisposable
{
    private const uint EventSystemForeground = 0x0003;
    private const uint WinEventOutOfContext = 0x0000;

    private readonly Func<string, string, Task> report;
    // Held in a field: the hook keeps only a pointer to it, and a collected
    // delegate would crash the next callback.
    private readonly WinEventDelegate callback;
    private readonly IntPtr hook;
    private string? lastReport;

    public ForegroundWindowReporter(Func<string, string, Task> report)
    {
        this.report = report;
        callback = OnForegroundChanged;
        hook = SetWinEventHook(EventSystemForeground, EventSystemForeground, IntPtr.Zero, callback, 0, 0, WinEventOutOfContext);
    }

    private void OnForegroundChanged(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint eventThread, uint eventTime)
    {
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == 0 || pid == Environment.ProcessId)
        {
            return;
        }
        string app;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            app = process.ProcessName + ".exe";
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return; // exited already
        }
        var title = new StringBuilder(GetWindowTextLength(hwnd) + 1);
        GetWindowText(hwnd, title, title.Capacity);
        Report(app, title.ToString());
    }

    internal void Report(string app, string title)
    {
        var key = app + "\n" + title;
        if (key == lastReport)
        {
            return;
        }
        lastReport = key;
        report(app, title).ContinueWith(
            t => Console.WriteLine($"Foreground report failed: {t.Exception?.GetBaseException().Message}"),
            TaskContinuationOptions.OnlyOnFaulted);
    }

    public void Dispose()
    {
        if (hook != IntPtr.Zero)
        {
            UnhookWinEvent(hook);
        }
    }

    private delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint eventThread, uint eventTime);

    [DllImport("user32.dll")]
    private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);

    [DllImport("user32.dll")]
    private static extern bool UnhookWinEvent(IntPtr hWinEventHook);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);
}
