using System.Collections.Generic;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class DoctorPanelFormatterTests
{
    [Theory]
    [InlineData("pass")]
    [InlineData("warn")]
    [InlineData("fail")]
    public void NormalizeStatus_PassesThroughKnownStatuses(string status)
    {
        Assert.Equal(status, DoctorPanelFormatter.NormalizeStatus(status));
    }

    [Fact]
    public void NormalizeStatus_FallsBackToWarnForAnUnknownStatus()
    {
        Assert.Equal("warn", DoctorPanelFormatter.NormalizeStatus("unknown-status"));
    }

    [Fact]
    public void Format_HeadingReflectsOk()
    {
        var okResult = new ManaDoctorResult { Ok = true, Checks = System.Array.Empty<ManaDoctorCheck>() };
        var problemResult = new ManaDoctorResult { Ok = false, Checks = System.Array.Empty<ManaDoctorCheck>() };

        Assert.Equal("Doctor: ready", DoctorPanelFormatter.Format(okResult).Heading);
        Assert.Equal("Doctor: attention needed", DoctorPanelFormatter.Format(problemResult).Heading);
    }

    [Fact]
    public void Format_SummaryCountsPassWarnFail()
    {
        var result = new ManaDoctorResult { Pass = 3, Warn = 1, Fail = 2, Checks = System.Array.Empty<ManaDoctorCheck>() };

        Assert.Equal("3 pass, 1 warn, 2 fail", DoctorPanelFormatter.Format(result).Summary);
    }

    [Fact]
    public void Format_LabelFallsBackToIdWhenMissing()
    {
        var result = new ManaDoctorResult
        {
            Checks = new List<ManaDoctorCheck> { new() { Id = "node-runtime", Label = "", Status = "pass", Message = "ok" } },
        };

        Assert.Equal("node-runtime", DoctorPanelFormatter.Format(result).Rows[0].Label);
    }

    [Fact]
    public void Format_LabelFallsBackToCheckWhenBothLabelAndIdAreMissing()
    {
        var result = new ManaDoctorResult
        {
            Checks = new List<ManaDoctorCheck> { new() { Id = "", Label = "", Status = "pass", Message = "ok" } },
        };

        Assert.Equal("Check", DoctorPanelFormatter.Format(result).Rows[0].Label);
    }

    [Fact]
    public void Format_NormalizesEachRowsStatus()
    {
        var result = new ManaDoctorResult
        {
            Checks = new List<ManaDoctorCheck> { new() { Id = "x", Label = "X", Status = "weird", Message = "?" } },
        };

        Assert.Equal("warn", DoctorPanelFormatter.Format(result).Rows[0].Status);
    }
}
