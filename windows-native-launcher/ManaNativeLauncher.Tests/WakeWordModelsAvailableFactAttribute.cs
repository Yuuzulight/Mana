using Xunit;

namespace ManaNativeLauncher.Tests;

// Same pattern as SkippableFactAttribute (Silero VAD model), for the wake-word models: openWakeWord's
// melspectrogram and embedding models are fetched at build time, so a failed download skips these tests
// instead of failing them. (SkippableFact only checks the Silero model.)
internal sealed class WakeWordModelsAvailableFactAttribute : FactAttribute
{
    public WakeWordModelsAvailableFactAttribute()
    {
        if (!WakeWordClassifierTests.ModelsAvailable)
        {
            Skip = "Wake-word models not available (their build-time download may have failed or been skipped offline)";
        }
    }
}
