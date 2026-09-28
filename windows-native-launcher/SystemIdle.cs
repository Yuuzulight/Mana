using System;
using System.Runtime.InteropServices;

namespace Mana.NativeLauncher;

// #681: OS idle time for node-bot's POST /internal/idle-report (Dream
// Mode's idle trigger) -- the native counterpart of windows-launcher's
// powerMonitor.getSystemIdleTime().
internal static class SystemIdle
{
    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetLastInputInfo(ref LastInputInfo info);

    // Whole seconds, like getSystemIdleTime(); 0 if the call fails.
    public static int GetIdleSeconds()
    {
        var info = new LastInputInfo { cbSize = (uint)Marshal.SizeOf<LastInputInfo>() };
        return GetLastInputInfo(ref info) ? IdleSecondsBetween((uint)Environment.TickCount, info.dwTime) : 0;
    }

    // Both are GetTickCount-style uint milliseconds; the unsigned
    // subtraction wraps, so this stays right across the ~49.7-day rollover.
    internal static int IdleSecondsBetween(uint nowTicks, uint lastInputTicks) =>
        (int)((nowTicks - lastInputTicks) / 1000);
}
