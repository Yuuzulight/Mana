using Xunit;

namespace ManaNativeLauncher.Tests;

// Same pattern as SkippableFactAttribute (Silero VAD model), for a
// different optional binary dependency: the Cubism Core native DLL and the
// Live2D model files it needs to load, neither committed to the repo. See
// CubismModelTests.CubismCoreAvailable's own comment for why.
internal sealed class CubismAvailableFactAttribute : FactAttribute
{
    public CubismAvailableFactAttribute()
    {
        if (!CubismModelTests.CubismCoreAvailable)
        {
            Skip = "Cubism Core DLL and/or Live2D model files not available (see native/cubism-core/README.md)";
        }
    }
}
