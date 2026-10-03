using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Mana.NativeLauncher.Dictation;

// #849: low-level keyboard hook (WH_KEYBOARD_LL) to track key-down and key-up
// events across the whole operating system for hold-to-talk dictation.
public sealed class LowLevelKeyboardHook : IDisposable
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;

    private const int VK_CONTROL = 0x11;
    private const int VK_LCONTROL = 0xA2;
    private const int VK_RCONTROL = 0xA3;
    private const int VK_MENU = 0x12;
    private const int VK_CAPITAL = 0x14;
    private const int VK_F8 = 0x77;
    private const int VK_F9 = 0x78;

    private const int LLKHF_EXTENDED = 0x01;

    private readonly LowLevelKeyboardProc hookProc;
    private IntPtr hookId = IntPtr.Zero;
    private bool disposed;

    public event Action<HoldKeyTarget>? KeyDown;
    public event Action<HoldKeyTarget>? KeyUp;

    public LowLevelKeyboardHook()
    {
        hookProc = HookCallback;
    }

    public void Start()
    {
        if (hookId != IntPtr.Zero)
        {
            return;
        }

        using var curProcess = Process.GetCurrentProcess();
        using var curModule = curProcess.MainModule;
        var moduleHandle = curModule is not null ? GetModuleHandle(curModule.ModuleName) : IntPtr.Zero;
        hookId = SetWindowsHookEx(WH_KEYBOARD_LL, hookProc, moduleHandle, 0);
        if (hookId == IntPtr.Zero)
        {
            var err = Marshal.GetLastWin32Error();
            Console.WriteLine($"LowLevelKeyboardHook: failed to install hook (error {err}).");
        }
    }

    public void Stop()
    {
        if (hookId != IntPtr.Zero)
        {
            UnhookWindowsHookEx(hookId);
            hookId = IntPtr.Zero;
        }
    }

    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var msg = wParam.ToInt32();
            var isDown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            var isUp = msg == WM_KEYUP || msg == WM_SYSKEYUP;

            if (isDown || isUp)
            {
                var kbd = Marshal.PtrToStructure<KbdLlHookStruct>(lParam);
                if (ResolveKeyTarget(kbd) is { } target)
                {
                    try
                    {
                        if (isDown)
                        {
                            KeyDown?.Invoke(target);
                        }
                        else if (isUp)
                        {
                            KeyUp?.Invoke(target);
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"LowLevelKeyboardHook: exception in hook handler: {ex.Message}");
                    }
                }
            }
        }

        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    private static HoldKeyTarget? ResolveKeyTarget(KbdLlHookStruct kbd)
    {
        var isExtended = (kbd.flags & LLKHF_EXTENDED) != 0;

        if (kbd.vkCode == VK_RCONTROL || (kbd.vkCode == VK_CONTROL && isExtended))
        {
            return HoldKeyTarget.RightControl;
        }
        if (kbd.vkCode == VK_LCONTROL || (kbd.vkCode == VK_CONTROL && !isExtended))
        {
            return HoldKeyTarget.LeftControl;
        }
        if (kbd.vkCode == VK_MENU && isExtended)
        {
            return HoldKeyTarget.RightAlt;
        }
        if (kbd.vkCode == VK_CAPITAL)
        {
            return HoldKeyTarget.CapsLock;
        }
        if (kbd.vkCode == VK_F8)
        {
            return HoldKeyTarget.F8;
        }
        if (kbd.vkCode == VK_F9)
        {
            return HoldKeyTarget.F9;
        }

        return null;
    }

    public void Dispose()
    {
        if (!disposed)
        {
            Stop();
            disposed = true;
        }
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KbdLlHookStruct
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);
}
