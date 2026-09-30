using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Mana.NativeLauncher;

// #1121 "My shell": a shell I type into, run inside the launcher through a
// Windows pseudo-console (ConPTY). Only this object holds its pipes -- no
// backend route, tool, bridge or phone can read it or type into it. The
// shell starts suspended inside a job object that kills its whole process
// tree when the job handle closes: on Dispose (its tab closes), or when the
// launcher itself exits or crashes. Its environment is my own fresh one
// (CreateEnvironmentBlock), as a terminal I open myself would get -- not
// the launcher's, which holds node-bot/.env's keys.
internal sealed class PseudoConsole : IDisposable
{
    private readonly IntPtr console;
    private readonly SafeFileHandle job;
    private readonly FileStream input;
    private readonly FileStream output;
    private readonly ProcessWaitHandle process;
    private readonly RegisteredWaitHandle exitWait;
    private int disposed;

    // Decoded shell output, raised on a background thread. Handlers must not
    // block on the UI thread (BeginInvoke, not Invoke): Dispose on the UI
    // thread can wait for this output to drain.
    public event Action<string>? Output;

    // The shell process ended (I typed exit), raised on a background thread.
    public event Action? Exited;

    public int ProcessId { get; }

    public PseudoConsole(string commandLine, string workingDirectory, int columns, int rows)
    {
        if (!CreatePipe(out var inputRead, out var inputWrite, IntPtr.Zero, 0)
            || !CreatePipe(out var outputRead, out var outputWrite, IntPtr.Zero, 0))
        {
            throw new Win32Exception();
        }
        var hr = CreatePseudoConsole(Size(columns, rows), inputRead, outputWrite, 0, out console);
        if (hr != 0)
        {
            throw new Win32Exception(hr);
        }

        job = CreateJobObjectW(IntPtr.Zero, null);
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION { BasicLimitInformation = { LimitFlags = JobObjectLimitKillOnJobClose } };
        if (job.IsInvalid || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()))
        {
            throw new Win32Exception();
        }

        var environment = IntPtr.Zero;
        if (OpenProcessToken(GetCurrentProcess(), TokenQuery, out var token))
        {
            using (token)
            {
                if (!CreateEnvironmentBlock(out environment, token, false))
                {
                    environment = IntPtr.Zero;
                }
            }
        }
        if (environment == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "couldn't build a clean environment for the shell");
        }

        var attributesSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributesSize);
        var attributes = Marshal.AllocHGlobal(attributesSize);
        try
        {
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref attributesSize)
                || !UpdateProcThreadAttribute(attributes, 0, ProcThreadAttributePseudoConsole, console, IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            {
                throw new Win32Exception();
            }
            var startup = new STARTUPINFOEX { lpAttributeList = attributes };
            startup.StartupInfo.cb = Marshal.SizeOf<STARTUPINFOEX>();
            // Suspended until it's in the job, so nothing it starts escapes.
            if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false,
                    ExtendedStartupInfoPresent | CreateSuspended | CreateUnicodeEnvironment, environment, workingDirectory, ref startup, out var info))
            {
                throw new Win32Exception();
            }
            ProcessId = info.dwProcessId;
            process = new ProcessWaitHandle(info.hProcess);
            var assigned = AssignProcessToJobObject(job, info.hProcess);
            ResumeThread(info.hThread);
            CloseHandle(info.hThread);
            if (!assigned)
            {
                var error = new Win32Exception();
                TerminateProcess(info.hProcess, 1);
                throw error;
            }
        }
        finally
        {
            DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
            DestroyEnvironmentBlock(environment);
            // The pseudo-console holds its own ends now.
            inputRead.Dispose();
            outputWrite.Dispose();
        }

        input = new FileStream(inputWrite, FileAccess.Write);
        output = new FileStream(outputRead, FileAccess.Read);
        exitWait = ThreadPool.RegisterWaitForSingleObject(process, (_, _) => Exited?.Invoke(), null, Timeout.Infinite, executeOnlyOnce: true);
        new Thread(ReadLoop) { IsBackground = true, Name = "My shell output" }.Start();
    }

    public void Write(string text)
    {
        if (Volatile.Read(ref disposed) != 0)
        {
            return;
        }
        var bytes = Encoding.UTF8.GetBytes(text);
        try
        {
            input.Write(bytes, 0, bytes.Length);
            input.Flush();
        }
        catch (IOException)
        {
            // The shell is gone; Exited says so.
        }
    }

    public void Resize(int columns, int rows)
    {
        if (Volatile.Read(ref disposed) == 0)
        {
            ResizePseudoConsole(console, Size(columns, rows));
        }
    }

    private void ReadLoop()
    {
        var decoder = Encoding.UTF8.GetDecoder();
        var bytes = new byte[8192];
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
        try
        {
            int read;
            while ((read = output.Read(bytes, 0, bytes.Length)) > 0)
            {
                var count = decoder.GetChars(bytes, 0, read, chars, 0);
                if (count > 0)
                {
                    Output?.Invoke(new string(chars, 0, count));
                }
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            // Closed on Dispose.
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
        {
            return;
        }
        exitWait.Unregister(null);
        // Kills the shell and everything it started, then the console host.
        job.Dispose();
        ClosePseudoConsole(console);
        input.Dispose();
        output.Dispose();
        process.Dispose();
    }

    // Signalled when the process ends.
    private sealed class ProcessWaitHandle : WaitHandle
    {
        public ProcessWaitHandle(IntPtr handle) => SafeWaitHandle = new SafeWaitHandle(handle, ownsHandle: true);
    }

    private static COORD Size(int columns, int rows) =>
        new() { X = (short)Math.Clamp(columns, 1, short.MaxValue), Y = (short)Math.Clamp(rows, 1, short.MaxValue) };

    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private static readonly IntPtr ProcThreadAttributePseudoConsole = (IntPtr)0x00020016;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint TokenQuery = 0x0008;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct COORD
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out SafeFileHandle readPipe, out SafeFileHandle writePipe, IntPtr attributes, int size);

    [DllImport("kernel32.dll")]
    private static extern int CreatePseudoConsole(COORD size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);

    [DllImport("kernel32.dll")]
    private static extern int ResizePseudoConsole(IntPtr console, COORD size);

    [DllImport("kernel32.dll")]
    private static extern void ClosePseudoConsole(IntPtr console);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string? applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll")]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr environment, SafeAccessTokenHandle token, bool inherit);

    [DllImport("userenv.dll")]
    private static extern bool DestroyEnvironmentBlock(IntPtr environment);
}
