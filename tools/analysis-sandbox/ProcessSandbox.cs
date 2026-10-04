using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Mana.AnalysisSandbox;

internal static class ProcessSandbox
{
    private sealed record Request(string Executable, string[] Arguments, string Cwd, string Profile, string Mode);

    internal static int Run(string work)
    {
        ValidateWork(work);
        var requestPath = Path.Combine(work, "launch.json");
        if ((File.GetAttributes(requestPath) & FileAttributes.ReparsePoint) != 0) throw new IOException("Redirected launch request");
        if (new FileInfo(requestPath).Length > 65536) throw new IOException("Launch request too large");
        var request = JsonSerializer.Deserialize<Request>(File.ReadAllText(requestPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? throw new IOException("Missing launch request");
        var executable = Path.GetFullPath(request.Executable);
        var cwd = Path.GetFullPath(request.Cwd);
        if (!Inside(work, executable) || !Inside(work, cwd) || !File.Exists(executable)) throw new IOException("Execution must use the disposable workspace");
        ValidateAncestors(work, executable);
        ValidateAncestors(work, cwd);
        if (request.Arguments.Length > 128 || request.Arguments.Any(a => a.Length > 16000 || a.Contains('\0'))) throw new IOException("Invalid process arguments");
        var skill = request.Mode == "skill";
        var unrestricted = request.Mode == "test-unrestricted";
        if (!skill && request.Mode != "test" && !unrestricted) throw new IOException("Unknown sandbox mode");
        if (request.Profile != "standard" && request.Profile != "large") throw new IOException("Unknown resource profile");
        var large = request.Profile == "large";
        var timeout = skill ? 15000 : large ? 1800000 : 900000;
        var memory = skill ? 512 : large ? 4096 : 2048;
        var processes = skill ? 1u : large ? 64u : 32u;
        var profile = Path.GetFileName(work);
        IntPtr sid = IntPtr.Zero, attributes = IntPtr.Zero, capabilities = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero;
        var process = new Native.ProcessInformation();
        var inherited = new List<IntPtr>();
        var initialized = false;
        using var owner = Native.OpenOwnerProcess();
        using var job = Native.CreateLimitedJob(memory, processes, timeout / 1000 * 8, skill ? 1000u : 5000u);
        try
        {
            if (!unrestricted)
            {
                Marshal.ThrowExceptionForHR(Native.CreateAppContainerProfile(profile, profile, "Mana isolated execution", IntPtr.Zero, 0, out sid));
                var directory = new DirectoryInfo(work);
                var acl = directory.GetAccessControl();
                acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.Modify, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                directory.SetAccessControl(acl);
                Native.SetLowIntegrity(work);
                // GetTempPath redirects AppContainer processes into their package temp directory.
                Directory.CreateDirectory(Path.Combine(work, "Packages", profile.ToLowerInvariant(), "AC", "Temp"));
            }

            foreach (var kind in new[] { -10, -11, -12 })
            {
                Native.Check(Native.DuplicateHandle(Native.GetCurrentProcess(), Native.GetStdHandle(kind), Native.GetCurrentProcess(), out var duplicate, 0, true, 2));
                inherited.Add(duplicate);
            }
            nuint size = 0;
            var attributeCount = unrestricted ? 1 : 2;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size);
            attributes = Marshal.AllocHGlobal((int)size);
            Native.Check(Native.InitializeProcThreadAttributeList(attributes, attributeCount, 0, ref size));
            initialized = true;
            if (!unrestricted)
            {
                capabilities = Marshal.AllocHGlobal(Marshal.SizeOf<Native.SecurityCapabilities>());
                Marshal.StructureToPtr(new Native.SecurityCapabilities { AppContainerSid = sid }, capabilities, false);
                Native.Check(Native.UpdateProcThreadAttribute(attributes, 0, 0x20009, capabilities, (nuint)Marshal.SizeOf<Native.SecurityCapabilities>(), IntPtr.Zero, IntPtr.Zero));
            }
            handles = Marshal.AllocHGlobal(IntPtr.Size * inherited.Count);
            Marshal.Copy(inherited.ToArray(), 0, handles, inherited.Count);
            Native.Check(Native.UpdateProcThreadAttribute(attributes, 0, 0x20002, handles, (nuint)(IntPtr.Size * inherited.Count), IntPtr.Zero, IntPtr.Zero));
            var startup = new Native.StartupInfoEx
            {
                StartupInfo = new Native.StartupInfo { cb = Marshal.SizeOf<Native.StartupInfoEx>(), Flags = 0x100, StdInput = inherited[0], StdOutput = inherited[1], StdError = inherited[2] },
                AttributeList = attributes,
            };
            var systemRoot = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            var runtime = Path.GetDirectoryName(executable)!;
            // Only three explicit protocol/output handles and a secret-free environment cross the boundary.
            var variables = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["ALLUSERSPROFILE"] = work, ["APPDATA"] = work, ["CI"] = "1",
                ["DOTNET_CLI_HOME"] = work, ["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1",
                ["DOTNET_CLI_USE_MSBUILD_SERVER"] = "0", ["DOTNET_GENERATE_ASPNET_CERTIFICATE"] = "false",
                ["DOTNET_NOLOGO"] = "1", ["DOTNET_ROOT"] = Path.Combine(work, "dotnet"),
                ["LOCALAPPDATA"] = work, ["MANA_APP_CONTAINER_TEST"] = skill || unrestricted ? "0" : "1",
                ["MSBUILDDISABLENODEREUSE"] = "1", ["NODE_ENV"] = "test",
                ["NODE_OPTIONS"] = "--preserve-symlinks --preserve-symlinks-main",
                ["NUGET_PACKAGES"] = Path.Combine(work, "nuget-packages"),
                ["PATH"] = $"{runtime};{systemRoot}\\System32", ["PROGRAMDATA"] = work,
                ["PROGRAMFILES"] = work, ["PROGRAMFILES(X86)"] = work, ["SystemRoot"] = systemRoot,
                ["TEMP"] = work, ["TMP"] = work, ["USERPROFILE"] = work, ["WINDIR"] = systemRoot,
            };
            environment = Marshal.StringToHGlobalUni(string.Join('\0', variables.Select(pair => $"{pair.Key}={pair.Value}")) + "\0\0");
            var command = new StringBuilder(string.Join(" ", new[] { executable }.Concat(request.Arguments).Select(Quote)));
            Native.Check(Native.CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x4 | 0x400 | 0x08000000, environment, cwd, ref startup, out process));
            Native.Check(Native.AssignProcessToJobObject(job, process.Process));
            foreach (var handle in inherited) Native.CloseHandle(handle);
            inherited.Clear();
            if (Native.ResumeThread(process.Thread) == uint.MaxValue) throw new System.ComponentModel.Win32Exception();
            var watch = Stopwatch.StartNew();
            var storageCheck = Stopwatch.StartNew();
            while (Native.WaitForSingleObject(process.Process, 100) == 258)
            {
                Native.CheckOwner(owner);
                if (watch.ElapsedMilliseconds > timeout) throw new TimeoutException("Native execution timed out");
                if (storageCheck.ElapsedMilliseconds >= 1000)
                {
                    CheckStorage(work, skill ? 256L * 1024 * 1024 : 8L * 1024 * 1024 * 1024, skill ? 5000 : 500000);
                    storageCheck.Restart();
                }
            }
            Native.Check(Native.GetExitCodeProcess(process.Process, out var exit));
            return unchecked((int)exit);
        }
        finally
        {
            try
            {
                Native.Check(Native.TerminateJobObject(job, 1));
                if (process.Process != IntPtr.Zero)
                {
                    Native.TerminateProcess(process.Process, 1);
                    Native.WaitForSingleObject(process.Process, 5000);
                }
                var watch = Stopwatch.StartNew();
                for (;;)
                {
                    Native.Check(Native.QueryInformationJobObject(job, 1, out var accounting, Marshal.SizeOf<Native.JobAccounting>(), IntPtr.Zero));
                    if (accounting.ActiveProcesses == 0) break;
                    if (watch.ElapsedMilliseconds > 15000) throw new IOException("Sandbox processes did not terminate");
                    Thread.Sleep(20);
                }
            }
            finally
            {
                if (process.Process != IntPtr.Zero) Native.CloseHandle(process.Process);
                if (process.Thread != IntPtr.Zero) Native.CloseHandle(process.Thread);
                foreach (var handle in inherited) Native.CloseHandle(handle);
                if (initialized) Native.DeleteProcThreadAttributeList(attributes);
                foreach (var allocation in new[] { attributes, capabilities, handles, environment }) if (allocation != IntPtr.Zero) Marshal.FreeHGlobal(allocation);
                if (sid != IntPtr.Zero) Native.FreeSid(sid);
                job.Dispose();
                Cleanup(work);
            }
        }
    }

    internal static void Cleanup(string work)
    {
        ValidateWork(work);
        var deleted = Native.DeleteAppContainerProfile(Path.GetFileName(work));
        if (deleted < 0 && deleted != unchecked((int)0x80070002)) Marshal.ThrowExceptionForHR(deleted);
        if (Directory.Exists(work)) Directory.Delete(work, true);
    }

    private static bool Inside(string root, string target) => string.Equals(root, target, StringComparison.OrdinalIgnoreCase) || target.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    private static void ValidateAncestors(string root, string target)
    {
        for (var current = target; Inside(root, current); current = Path.GetDirectoryName(current)!)
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("Redirected execution path");
            if (string.Equals(root, current, StringComparison.OrdinalIgnoreCase)) break;
        }
    }

    private static void CheckStorage(string root, long maxBytes, int maxEntries)
    {
        long bytes = 0;
        var count = 0;
        var options = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false };
        foreach (var entry in Directory.EnumerateFileSystemEntries(root, "*", options))
        {
            if (++count > maxEntries) throw new IOException("Sandbox scratch entry limit exceeded");
            try { if (!Directory.Exists(entry)) bytes += new FileInfo(entry).Length; }
            catch (FileNotFoundException) { continue; }
            if (bytes > maxBytes) throw new IOException("Sandbox scratch storage limit exceeded");
        }
    }
    private static void ValidateWork(string work)
    {
        var full = Path.GetFullPath(work);
        var name = Path.GetFileName(full);
        if (!Path.IsPathFullyQualified(work) || !string.Equals(Path.GetDirectoryName(full)?.TrimEnd('\\'), Path.GetTempPath().TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)
            || !name.StartsWith("Mana.Execution.", StringComparison.Ordinal) || !Guid.TryParseExact(name[15..], "N", out _)) throw new IOException("Invalid execution scratch directory");
        if (Directory.Exists(full) && (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0) throw new IOException("Redirected execution scratch directory");
    }

    private static string Quote(string value)
    {
        var output = new StringBuilder("\"");
        var slashes = 0;
        foreach (var c in value)
        {
            if (c == '\\') { slashes++; continue; }
            output.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            output.Append(c);
            slashes = 0;
        }
        output.Append('\\', slashes * 2).Append('"');
        return output.ToString();
    }
}
