using System.Collections.Generic;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1426: the composer's thinking level card.
[Collection("DarkTheme palette")]
public class ThinkingLevelPickerTests
{
    [Fact]
    public void Levels_RunFasterToSmarter_WithMediumRecommended()
    {
        Assert.Equal(new[] { "off", "low", "medium", "high", "max" }, System.Array.ConvertAll(ThinkingLevelPicker.Levels, l => l.Id));
        Assert.Equal("medium", ThinkingLevelPicker.Recommended);
        Assert.Equal("High", ThinkingLevelPicker.LabelOf("high"));
    }

    [Fact]
    public void Picking_SaysTheNewLevelOnce_AndStaysInRange()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var picker = new ThinkingLevelPicker("medium");
            var said = new List<string>();
            picker.LevelChanged += said.Add;
            picker.Pick(3);
            picker.Pick(3); // no change, nothing said
            picker.Pick(99);
            picker.Pick(-5);
            Assert.Equal(new[] { "high", "max", "off" }, said);
            Assert.Equal("off", picker.Level);
            Assert.Equal("Off", picker.AccessibleDescription);
        });
    }
}
