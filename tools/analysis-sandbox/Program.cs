using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace Mana.AnalysisSandbox;

internal static class Program
{
    public static int Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("Windows AppContainer is required");
            if (args.Length == 2 && args[0] == "--process") return ProcessSandbox.Run(args[1]);
            if (args.Length == 2 && args[0] == "--process-cleanup") { ProcessSandbox.Cleanup(args[1]); return 0; }
            if (args.Length == 3 && args[0] == "--cleanup")
            {
                Cleanup(args[1], args[2]);
                return 0;
            }
            if (args.Length != 3 || !Path.IsPathFullyQualified(args[0])) throw new ArgumentException("A dedicated Python runtime directory, scratch directory and timeout are required");
            var timeout = int.Parse(args[2]);
            if (timeout is < 100 or > 60000) throw new ArgumentException("timeout must be 100 to 60000 milliseconds");
            var runtime = Path.GetFullPath(args[0]);
            var python = Path.Combine(runtime, "python.exe");
            if (!File.Exists(python)) throw new FileNotFoundException("python.exe is missing from the analysis runtime");
            var input = ReadBounded(Console.OpenStandardInput(), 8 * 1024 * 1024);
            ValidateWork(args[1]);
            Console.Write(Run(runtime, python, input, timeout, args[1]));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static string Run(string runtime, string python, string input, int timeout, string work)
    {
        var profile = Path.GetFileName(work);
        IntPtr sid = IntPtr.Zero, attributes = IntPtr.Zero, capabilities = IntPtr.Zero, environment = IntPtr.Zero;
        var process = new Native.ProcessInformation();
        var initialized = false;
        using var job = Native.CreateLimitedJob();
        using var owner = Native.OpenOwnerProcess();
        try
        {
            Marshal.ThrowExceptionForHR(Native.CreateAppContainerProfile(profile, profile, "Mana offline analysis", IntPtr.Zero, 0, out sid));
            var identity = new SecurityIdentifier(sid);
            Directory.CreateDirectory(work);
            Grant(work, identity, FileSystemRights.Modify);
            // AppContainer processes run at low integrity. Only the scratch directory is writable.
            Native.SetLowIntegrity(work);
            Grant(runtime, identity, FileSystemRights.ReadAndExecute);
            File.WriteAllText(Path.Combine(work, "request.json"), input, new UTF8Encoding(false));
            File.Copy(Path.Combine(AppContext.BaseDirectory, "worker.py"), Path.Combine(work, "worker.py"));

            nuint size = 0;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal((int)size);
            Native.Check(Native.InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
            initialized = true;
            capabilities = Marshal.AllocHGlobal(Marshal.SizeOf<Native.SecurityCapabilities>());
            Marshal.StructureToPtr(new Native.SecurityCapabilities { AppContainerSid = sid }, capabilities, false);
            Native.Check(Native.UpdateProcThreadAttribute(attributes, 0, (nuint)0x20009, capabilities, (nuint)Marshal.SizeOf<Native.SecurityCapabilities>(), IntPtr.Zero, IntPtr.Zero));

            var startup = new Native.StartupInfoEx { StartupInfo = new Native.StartupInfo { cb = Marshal.SizeOf<Native.StartupInfoEx>() }, AttributeList = attributes };
            var command = new StringBuilder($"\"{python}\" -I -B \"{Path.Combine(work, "worker.py")}\" \"{work}\"");
            // No host environment variables or handles (tokens, API keys, pipes) reach Python.
            var systemRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            environment = Marshal.StringToHGlobalUni($"APPDATA={work}\0LOCALAPPDATA={work}\0MKL_NUM_THREADS=1\0MPLBACKEND=Agg\0MPLCONFIGDIR={work}\0NUMEXPR_NUM_THREADS=1\0OMP_NUM_THREADS=1\0OPENBLAS_NUM_THREADS=1\0PATH={runtime};{systemRoot}\\System32\0SystemDrive={Path.GetPathRoot(systemRoot)?.TrimEnd('\\')}\0SystemRoot={systemRoot}\0TEMP={work}\0TMP={work}\0USERPROFILE={work}\0WINDIR={systemRoot}\0\0");
            Native.Check(Native.CreateProcess(python, command, IntPtr.Zero, IntPtr.Zero, false,
                0x00080000 | 0x00000004 | 0x00000400 | 0x08000000, environment, work, ref startup, out process));
            // Assign while suspended so user code cannot spawn outside the job.
            Native.Check(Native.AssignProcessToJobObject(job, process.Process));
            if (Native.ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception();
            var watch = Stopwatch.StartNew();
            var inaccessibleScans = 0;
            while (Native.WaitForSingleObject(process.Process, 100) == 258)
            {
                Native.CheckOwner(owner);
                if (watch.ElapsedMilliseconds > timeout) throw new TimeoutException("analysis sandbox timed out");
                try
                {
                    if (ScratchBytes(work) > 64 * 1024 * 1024) throw new IOException("analysis scratch storage limit exceeded");
                    inaccessibleScans = 0;
                }
                // Windows can briefly deny enumeration of a directory pending deletion.
                // Persistent unreadable scratch still fails closed after three scans.
                catch (UnauthorizedAccessException) when (++inaccessibleScans < 3) { }
            }
            Native.Check(Native.GetExitCodeProcess(process.Process, out var exit));
            if (exit != 0) throw new IOException($"analysis Python exited with code {exit}");
            var resultPath = Path.Combine(work, "result.json");
            if ((File.GetAttributes(work) & FileAttributes.ReparsePoint) != 0 || (File.GetAttributes(resultPath) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("refusing a redirected analysis result");
            using var result = File.OpenRead(resultPath);
            return ReadBounded(result, 1500000);
        }
        finally
        {
            // Also terminate a suspended process if assignment or launch failed.
            if (process.Process != IntPtr.Zero)
            {
                Native.TerminateProcess(process.Process, 1);
                Native.WaitForSingleObject(process.Process, 5000);
                Native.CloseHandle(process.Process);
            }
            if (process.Thread != IntPtr.Zero) Native.CloseHandle(process.Thread);
            job.Dispose();
            if (initialized) Native.DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (sid != IntPtr.Zero) Native.FreeSid(sid);
            Cleanup(runtime, work);
        }
    }

    private static void ValidateWork(string work)
    {
        var full = Path.GetFullPath(work);
        var name = Path.GetFileName(full);
        if (!Path.IsPathFullyQualified(work) || !string.Equals(Path.GetDirectoryName(full)?.TrimEnd('\\'), Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)
            || !name.StartsWith("Mana.Analysis.", StringComparison.Ordinal) || !Guid.TryParseExact(name[14..], "N", out _))
            throw new ArgumentException("invalid analysis scratch directory");
        if (Directory.Exists(full) && (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("refusing a redirected scratch directory");
    }

    private static void Cleanup(string runtime, string work)
    {
        ValidateWork(work);
        var profile = Path.GetFileName(work);
        Marshal.ThrowExceptionForHR(Native.DeriveAppContainerSidFromAppContainerName(profile, out var sid));
        try { Revoke(runtime, new SecurityIdentifier(sid)); }
        finally { Native.FreeSid(sid); }
        var deleted = Native.DeleteAppContainerProfile(profile);
        if (deleted < 0 && deleted != unchecked((int)0x80070002)) Marshal.ThrowExceptionForHR(deleted);
        if (Directory.Exists(work)) Directory.Delete(work, true);
    }

    private static void Grant(string directory, SecurityIdentifier sid, FileSystemRights rights)
    {
        var info = new DirectoryInfo(directory);
        var acl = info.GetAccessControl();
        acl.AddAccessRule(new FileSystemAccessRule(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        info.SetAccessControl(acl);
    }

    private static void Revoke(string directory, SecurityIdentifier sid)
    {
        var info = new DirectoryInfo(directory);
        var acl = info.GetAccessControl();
        acl.PurgeAccessRules(sid);
        info.SetAccessControl(acl);
    }

    private static long ScratchBytes(string directory)
    {
        long total = 0;
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false };
        var count = 0;
        try
        {
            foreach (var file in Directory.EnumerateFileSystemEntries(directory, "*", options))
            {
                if (++count > 5000) throw new IOException("analysis scratch file count limit exceeded");
                try { if (!Directory.Exists(file)) total += new FileInfo(file).Length; }
                catch (FileNotFoundException) { continue; }
                if (total > 64 * 1024 * 1024) break;
            }
        }
        catch (DirectoryNotFoundException) { /* A script can remove a temporary subtree during enumeration. */ }
        return total;
    }

    private static string ReadBounded(Stream stream, int maxBytes)
    {
        using var result = new MemoryStream();
        var buffer = new byte[8192];
        int count;
        while ((count = stream.Read(buffer)) > 0)
        {
            if (result.Length + count > maxBytes) throw new IOException("analysis transport size limit exceeded");
            result.Write(buffer, 0, count);
        }
        return Encoding.UTF8.GetString(result.ToArray());
    }
}
