using System.Drawing;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ContextMeterFormatterTests
{
    private static ManaPromptComposition Measured(string countedWith = "tokenizer") => new()
    {
        Blocks = new[]
        {
            new ManaPromptBlock { Name = "system-prompt", Tokens = 412 },
            new ManaPromptBlock { Name = "tool-schemas", Tokens = 2600 },
            new ManaPromptBlock { Name = "some-new-block", Tokens = 5 },
        },
        CountedWith = countedWith,
        TotalTokens = 3017,
        PromptTokens = 3205,
        UnattributedTokens = 188,
        ContextSize = 16384,
        PercentUsed = 19.6,
    };

    [Theory]
    [InlineData(null, "Muted")]
    [InlineData(74.9, "Muted")]
    [InlineData(75.0, "Warn")]
    [InlineData(89.9, "Warn")]
    [InlineData(90.0, "Red")]
    public void MeterColor_AmberFrom75_RedFrom90(double? percent, string expected)
    {
        var want = expected switch { "Warn" => DarkTheme.Warn, "Red" => Color.Firebrick, _ => DarkTheme.Muted };
        Assert.Equal(want, ContextMeterFormatter.MeterColor(percent));
    }

    [Fact]
    public void FormatMeter_ShowsPromptTokensAgainstTheContextWindow()
    {
        Assert.Equal("Context 3,205 / 16,384 (19.6%)", ContextMeterFormatter.FormatMeter(Measured()));
    }

    [Fact]
    public void FormatMeter_FallsBackToTheBlockTotalWhenLlamaServerDidNotReport()
    {
        var composition = new ManaPromptComposition { TotalTokens = 1640, ContextSize = 16384, PercentUsed = 10 };

        Assert.Equal("Context 1,640 / 16,384 (10%)", ContextMeterFormatter.FormatMeter(composition));
    }

    [Fact]
    public void FormatMeterAndBreakdown_AreEmptyWithoutAMeasurement()
    {
        Assert.Equal("", ContextMeterFormatter.FormatMeter(null));
        // Base #400 record: no finalize ran, so no percentage or window size.
        var unmeasured = new ManaPromptComposition { TotalTokens = 500 };
        Assert.Equal("", ContextMeterFormatter.FormatMeter(unmeasured));
        Assert.Equal("", ContextMeterFormatter.FormatBreakdown(unmeasured));
    }

    [Fact]
    public void FormatBreakdown_ListsEachCategoryAndTheUnattributedRest()
    {
        Assert.Equal(
            "Last reply's prompt, in tokens:\r\n" +
            "System prompt: 412\r\n" +
            "Tool definitions: 2,600\r\n" +
            "some-new-block: 5\r\n" +
            "Chat template & tool results: 188",
            ContextMeterFormatter.FormatBreakdown(Measured()).ReplaceLineEndings("\r\n"));
    }

    [Fact]
    public void FormatBreakdown_SaysWhenTheCountsAreEstimates()
    {
        Assert.EndsWith("Estimated -- the model's tokenizer wasn't available.", ContextMeterFormatter.FormatBreakdown(Measured("estimate")));
    }
}
