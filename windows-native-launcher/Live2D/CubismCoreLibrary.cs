using System.Runtime.InteropServices;

namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: Live2DCubismCore.dll lives in the source tree
// (native/cubism-core/, gitignored -- see its README.md), not next to the
// built app -- matching every other asset this project resolves relative
// to the discovered root directory (SileroVadRunner's model,
// AvatarOverlayForm's fallback PNGs) instead of relying on MSBuild to copy
// it into the output directory. Resolving it this way also makes "is
// Cubism Core even available" a plain file-existence check (IsAvailable)
// instead of something only discoverable by attempting a P/Invoke call and
// catching DllNotFoundException.
internal static class CubismCoreLibrary
{
    private static readonly object registrationLock = new();
    private static bool resolverRegistered;
    private static string? dllPath;

    public static bool IsAvailable(string rootDirectory)
    {
        EnsureResolverRegistered(rootDirectory);
        return dllPath is not null && File.Exists(dllPath);
    }

    private static void EnsureResolverRegistered(string rootDirectory)
    {
        lock (registrationLock)
        {
            if (resolverRegistered)
            {
                return;
            }
            resolverRegistered = true;

            dllPath = Path.Combine(rootDirectory, "windows-native-launcher", "native", "cubism-core", "Live2DCubismCore.dll");
            var capturedPath = dllPath;

            NativeLibrary.SetDllImportResolver(typeof(CubismCoreNative).Assembly, (name, _, _) =>
            {
                if (name != "Live2DCubismCore" || !File.Exists(capturedPath))
                {
                    return nint.Zero; // falls through to normal (failing) resolution
                }
                return NativeLibrary.Load(capturedPath);
            });
        }
    }
}
