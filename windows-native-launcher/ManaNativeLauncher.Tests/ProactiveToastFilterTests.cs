using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ProactiveToastFilterTests
{
    [Theory]
    [InlineData("dream")]
    [InlineData("cron")]
    [InlineData("research")]
    public void IsProactiveToast_TrueForEachProactiveType(string type)
    {
        Assert.True(ProactiveToastFilter.IsProactiveToast(type));
    }

    [Fact]
    public void IsProactiveToast_FalseForDoctor()
    {
        // #524's own scope note: doctor stays a tray-tooltip-only status
        // surface, deliberately not re-toasted on every check.
        Assert.False(ProactiveToastFilter.IsProactiveToast("doctor"));
    }

    [Fact]
    public void IsProactiveToast_FalseForAnUnrecognizedType()
    {
        Assert.False(ProactiveToastFilter.IsProactiveToast("audit"));
    }

    [Fact]
    public void IsProactiveToast_FalseForNull()
    {
        Assert.False(ProactiveToastFilter.IsProactiveToast(null));
    }
}
