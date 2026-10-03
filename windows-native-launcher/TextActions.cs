using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #680 part 1: one text action -- a menu name and the fixed instruction
// sent with the selected text.
internal sealed record TextAction(string Name, string Prompt)
{
    public static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mana", "text-actions.json");

    public static readonly IReadOnlyList<TextAction> Defaults =
    [
        new("Explain", "Explain the following text clearly and briefly."),
        new("Translate to English", "Translate the following text into natural English. Reply with the translation only."),
        new("Shorter", "Rewrite the following text to be shorter, keeping its meaning and tone. Reply with the rewritten text only."),
        new("More formal", "Rewrite the following text in a more formal tone, keeping its meaning. Reply with the rewritten text only."),
        new("Fix grammar", "Fix the grammar, spelling and punctuation of the following text and change nothing else. Reply with the corrected text only."),
    ];

    // The menu: text-actions.json ([{"name": ..., "prompt": ...}], so an
    // action like "Translate to Japanese" needs no code), else the defaults.
    // A missing, unreadable or empty file means the defaults.
    public static IReadOnlyList<TextAction> Load(string? path = null)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path ?? FilePath));
            List<TextAction> actions = document.RootElement.ValueKind != JsonValueKind.Array ? [] : document.RootElement.EnumerateArray()
                .Where(e => e.ValueKind == JsonValueKind.Object)
                .Select(e => new TextAction(Str(e, "name"), Str(e, "prompt")))
                .Where(a => a.Name.Length > 0 && a.Prompt.Length > 0)
                .ToList();
            return actions.Count > 0 ? actions : Defaults;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return Defaults;
        }

        static string Str(JsonElement e, string name) =>
            e.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()!.Trim() : "";
    }
}

// #680: every format on the clipboard, copied out so it can be put back
// after Mana borrows the clipboard to copy a selection or paste a result.
// Formats that can't be read (some apps' delayed-render data) are skipped.
internal sealed class ClipboardSnapshot
{
    private readonly List<(string Format, object Data)> items = [];

    public static ClipboardSnapshot From(IDataObject? data)
    {
        var snapshot = new ClipboardSnapshot();
        foreach (var format in data?.GetFormats(autoConvert: false) ?? [])
        {
            try
            {
                if (data!.GetData(format, autoConvert: false) is { } value)
                {
                    snapshot.items.Add((format, value));
                }
            }
            catch (Exception ex) when (ex is ExternalException or COMException or OutOfMemoryException or ArgumentException)
            {
                // unreadable format: skipped
            }
        }
        return snapshot;
    }

    // Null when the clipboard was empty.
    public DataObject? ToDataObject()
    {
        if (items.Count == 0)
        {
            return null;
        }
        var data = new DataObject();
        foreach (var (format, value) in items)
        {
            data.SetData(format, autoConvert: false, value);
        }
        return data;
    }

    // UI (STA) thread only, like every Clipboard call.
    public static ClipboardSnapshot Take()
    {
        try
        {
            return From(Clipboard.GetDataObject());
        }
        catch (ExternalException)
        {
            return new ClipboardSnapshot(); // held by another app right now
        }
    }

    public void Restore()
    {
        try
        {
            if (ToDataObject() is { } data)
            {
                Clipboard.SetDataObject(data, copy: true, retryTimes: 5, retryDelay: 50);
            }
            else
            {
                Clipboard.Clear();
            }
        }
        catch (ExternalException ex)
        {
            Console.WriteLine($"ClipboardSnapshot: couldn't restore the clipboard. {ex.Message}");
        }
    }
}

// #680: reading the selection in, and pasting a result back into, whatever
// window has focus in another app. UI thread only (clipboard).
internal static class ForeignWindow
{
    // What the focused element says about itself via UI Automation: a
    // password field, and its selected text (null if it doesn't expose
    // one). Bounded: a hung app's UIA provider can block for seconds.
    public static async Task<(bool IsPassword, string? Selection)> ReadFocusedAsync()
    {
        try
        {
            return await Task.Run(() =>
            {
                var element = AutomationElement.FocusedElement;
                if (element is null)
                {
                    return (false, (string?)null);
                }
                if (element.Current.IsPassword)
                {
                    return (true, null);
                }
                return (false, element.TryGetCurrentPattern(TextPattern.Pattern, out var pattern)
                    ? string.Concat(((TextPattern)pattern).GetSelection().Select(range => range.GetText(-1)))
                    : null);
            }).WaitAsync(TimeSpan.FromMilliseconds(700));
        }
        // Broad on purpose: UIA providers throw all sorts, and any failure
        // just means "fall back to the clipboard".
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return (false, null);
        }
    }

    // The selection via the clipboard: Ctrl+C, read, then the clipboard is
    // put back as it was. "" when nothing was copied.
    public static async Task<string> CopySelectionAsync()
    {
        var saved = ClipboardSnapshot.Take();
        var before = GetClipboardSequenceNumber();
        await SendCtrlAsync('C');
        for (var waited = 0; waited < 600 && GetClipboardSequenceNumber() == before; waited += 20)
        {
            await Task.Delay(20);
        }
        if (GetClipboardSequenceNumber() == before)
        {
            return "";
        }
        string text;
        try
        {
            text = Clipboard.GetText();
        }
        catch (ExternalException)
        {
            text = "";
        }
        saved.Restore();
        return text;
    }

    // Pastes `text` into the focused window with Ctrl+V, then puts the
    // clipboard back once the target has had time to read it.
    public static async Task PasteAsync(string text)
    {
        var saved = ClipboardSnapshot.Take();
        Clipboard.SetDataObject(text, copy: true, retryTimes: 5, retryDelay: 50);
        await SendCtrlAsync('V');
        await Task.Delay(500);
        saved.Restore();
    }

    // Input from a normal-rights app into an admin window is silently
    // dropped by Windows (UIPI). True when `hwnd` belongs to an elevated
    // process and Mana isn't one -- or when its process can't even be
    // queried, which in practice means the same.
    public static bool IsElevatedAboveUs(nint hwnd)
    {
        if (Environment.IsPrivilegedProcess || hwnd == 0)
        {
            return false;
        }
        GetWindowThreadProcessId(hwnd, out var pid);
        var process = OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (process == 0)
        {
            return true;
        }
        try
        {
            if (!OpenProcessToken(process, TokenQuery, out var token))
            {
                return true;
            }
            try
            {
                return GetTokenInformation(token, TokenElevationClass, out var elevated, sizeof(int), out _) && elevated != 0;
            }
            finally
            {
                CloseHandle(token);
            }
        }
        finally
        {
            CloseHandle(process);
        }
    }

    public static nint Foreground() => GetForegroundWindow();

    // Left or right mouse button held right now, anywhere on screen.
    public static bool MouseButtonDown() => ((GetAsyncKeyState(0x01) | GetAsyncKeyState(0x02)) & 0x8000) != 0;

    public static bool IsOwnWindow(nint hwnd)
    {
        GetWindowThreadProcessId(hwnd, out var pid);
        return pid == Environment.ProcessId;
    }

    // #849: types unicode text directly into the focused window using SendInput
    public static void SendTextUnicode(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return;
        }

        var inputs = new Input[text.Length * 2];
        for (var i = 0; i < text.Length; i++)
        {
            inputs[i * 2] = new Input { Type = 1, U = new InputUnion { Ki = new KeybdInput { Vk = 0, Scan = (ushort)text[i], Flags = 4u } } }; // KEYEVENTF_UNICODE
            inputs[i * 2 + 1] = new Input { Type = 1, U = new InputUnion { Ki = new KeybdInput { Vk = 0, Scan = (ushort)text[i], Flags = 6u } } }; // KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        }
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>());
    }

    // Waits (up to 1s) for the hotkey's own Ctrl/Alt/Shift/Win to be let
    // go -- otherwise Ctrl+C would arrive as Ctrl+Alt+C -- then sends
    // Ctrl+<key>.
    private static async Task SendCtrlAsync(char key)
    {
        int[] modifiers = [0x10, 0x11, 0x12, 0x5B, 0x5C]; // Shift, Ctrl, Alt, LWin, RWin
        for (var waited = 0; waited < 1000 && modifiers.Any(vk => (GetAsyncKeyState(vk) & 0x8000) != 0); waited += 20)
        {
            await Task.Delay(20);
        }
        Input[] inputs =
        [
            KeyInput(0x11, up: false),
            KeyInput(key, up: false),
            KeyInput(key, up: true),
            KeyInput(0x11, up: true),
        ];
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>());
    }

    private static Input KeyInput(int vk, bool up) =>
        new() { Type = 1, U = new InputUnion { Ki = new KeybdInput { Vk = (ushort)vk, Flags = up ? 2u : 0u } } };

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputUnion U;
    }

    // Sized by its largest member (MOUSEINPUT), as SendInput expects.
    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput Mi;
        [FieldOffset(0)] public KeybdInput Ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int Dx;
        public int Dy;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public nint ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeybdInput
    {
        public ushort Vk;
        public ushort Scan;
        public uint Flags;
        public uint Time;
        public nint ExtraInfo;
    }

    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint TokenQuery = 0x0008;
    private const int TokenElevationClass = 20;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vk);

    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint hwnd, out int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint OpenProcess(uint access, bool inherit, int processId);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(nint process, uint access, out nint token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(nint token, int infoClass, out int info, int length, out int returnLength);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(nint handle);
}
