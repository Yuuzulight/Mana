using Xunit;

namespace ManaNativeLauncher.Tests;

// xunit 2.x has no runtime Assert.Skip (that's a v3-only API) -- the
// standard v2 way to skip a test based on a runtime condition (here:
// whether the build-time-fetched Silero VAD model is actually present on
// disk) is a FactAttribute subclass that sets the inherited Skip property
// in its constructor. xunit reads Skip at test discovery time (which
// happens on every run, not just at compile time), so this correctly
// reports the test as "Skipped" with a reason instead of either failing
// the whole run (no model, hard-required) or silently reporting "Passed"
// with zero assertions (the old early-return-from-the-test-body pattern).
internal sealed class SkippableFactAttribute : FactAttribute
{
    public SkippableFactAttribute()
    {
        if (!SileroVadRunnerTests.ModelAvailable)
        {
            Skip = "Silero VAD model not available (fetch may have failed or been skipped offline)";
        }
    }
}
