using System.Collections.Generic;
using System.Linq;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #689: remappable hotkeys (Settings > Hotkeys).
public class HotkeyBindingsTests
{
    private static HotkeyAction Action(string key) => HotkeyBindings.Actions.Single(a => a.Key == key);

    [Fact]
    public void Resolve_UsesTheDefaultUntilChangedAndEmptyMeansOff()
    {
        var vision = Action("vision");
        Assert.Equal(Keys.Control | Keys.Alt | Keys.M, HotkeyBindings.Resolve(null, vision));
        Assert.Equal(Keys.Control | Keys.Alt | Keys.M, HotkeyBindings.Resolve(new Dictionary<string, string>(), vision));
        Assert.Null(HotkeyBindings.Resolve(new Dictionary<string, string> { ["vision"] = "" }, vision));
        Assert.Equal(Keys.Control | Keys.Shift | Keys.F9, HotkeyBindings.Resolve(new Dictionary<string, string> { ["vision"] = "Ctrl+Shift+F9" }, vision));
        Assert.Equal(vision.Default, HotkeyBindings.Resolve(new Dictionary<string, string> { ["vision"] = "nonsense+" }, vision));
        Assert.Equal(vision.Default, HotkeyBindings.Resolve(new Dictionary<string, string> { ["vision"] = "Shift+A" }, vision)); // not a valid global hotkey
    }

    [Fact]
    public void Format_RoundTripsThroughResolve()
    {
        var clip = Action("clip");
        var text = HotkeyBindings.Format(clip.Default);
        Assert.Equal(clip.Default, HotkeyBindings.Resolve(new Dictionary<string, string> { ["clip"] = text }, clip));
        Assert.Equal("Off", HotkeyBindings.Format(null));
    }

    [Theory]
    [InlineData(Keys.Control | Keys.Alt | Keys.W, true)]
    [InlineData(Keys.Alt | Keys.F1, true)]
    [InlineData(Keys.Shift | Keys.A, false)]
    [InlineData(Keys.A, false)]
    [InlineData(Keys.Control | Keys.ControlKey, false)]
    public void IsValid_NeedsCtrlOrAltPlusARealKey(Keys keys, bool expected)
    {
        Assert.Equal(expected, HotkeyBindings.IsValid(keys));
    }

    [Fact]
    public void ConflictFor_FindsAnotherActionWithTheSameKeys()
    {
        var saved = new Dictionary<string, string> { ["interrupt"] = "Ctrl+Alt+M", ["vision"] = "Ctrl+Alt+V" };
        Assert.Equal("vision", HotkeyBindings.ConflictFor(null, Action("interrupt"), Keys.Control | Keys.Alt | Keys.M)?.Key);
        Assert.Null(HotkeyBindings.ConflictFor(null, Action("vision"), Keys.Control | Keys.Alt | Keys.M)); // its own
        Assert.Null(HotkeyBindings.ConflictFor(new Dictionary<string, string> { ["vision"] = "" }, Action("interrupt"), Keys.Control | Keys.Alt | Keys.M));
        Assert.Equal("interrupt", HotkeyBindings.ConflictFor(saved, Action("window"), Keys.Control | Keys.Alt | Keys.M)?.Key);
    }

    [Fact]
    public void DefaultsDontCollideAndIdsAreUnique()
    {
        Assert.Equal(HotkeyBindings.Actions.Length, HotkeyBindings.Actions.Select(a => a.Default).Distinct().Count());
        Assert.Equal(HotkeyBindings.Actions.Length, HotkeyBindings.Actions.Select(a => a.Id).Distinct().Count());
    }

    [Fact]
    public void Modifiers_MapToRegisterHotKeyFlags()
    {
        Assert.Equal(0x1u | 0x2u | 0x4u, GlobalHotkeyListener.Modifiers(Keys.Control | Keys.Alt | Keys.Shift | Keys.M));
        Assert.Equal(0x2u, GlobalHotkeyListener.Modifiers(Keys.Control | Keys.F5));
    }
}
