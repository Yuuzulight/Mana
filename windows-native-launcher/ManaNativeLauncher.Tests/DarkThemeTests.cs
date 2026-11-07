using System.Drawing;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// Mutates DarkTheme's shared static fields -- every test here sets a
// known preset/accent before asserting, rather than depending on
// whatever a previous test (in this class or another) last left behind.
[Collection("DarkTheme palette")] // shared static palette: never run these in parallel
public class DarkThemeTests
{
    [Fact]
    public void ApplyPreset_SwitchesToTheNamedPresetsColors()
    {
        DarkTheme.ApplyPreset("neutral", null);

        Assert.Equal(ColorTranslator.FromHtml("#18191b"), DarkTheme.Background);
        Assert.Equal(ColorTranslator.FromHtml("#4fb3a8"), DarkTheme.Accent);
    }

    [Fact]
    public void ApplyPreset_FallsBackToTheManaDefaultForAnUnknownPresetId()
    {
        DarkTheme.ApplyPreset("not-a-real-preset", null);

        Assert.Equal(ColorTranslator.FromHtml("#f5f3fa"), DarkTheme.Background);
        Assert.Equal(ColorTranslator.FromHtml("#6a5fb8"), DarkTheme.Accent);
    }

    [Fact]
    public void ApplyPreset_AccentOverrideWinsOverThePresetsOwnAccent()
    {
        DarkTheme.ApplyPreset("violet", "#ff00ff");

        Assert.Equal(ColorTranslator.FromHtml("#ff00ff"), DarkTheme.Accent);
        // The rest of the palette still comes from the preset.
        Assert.Equal(ColorTranslator.FromHtml("#1c1a18"), DarkTheme.Background);
    }

    [Fact]
    public void ApplyPreset_IgnoresAMalformedAccentOverride()
    {
        DarkTheme.ApplyPreset("violet", "not-a-hex-color");

        Assert.Equal(ColorTranslator.FromHtml("#9d8ce0"), DarkTheme.Accent);
    }

    [Fact]
    public void ApplyPreset_ManaUsesItsReferenceSheetPaletteAsALightTheme()
    {
        DarkTheme.ApplyPreset("mana", null);

        Assert.Equal(ColorTranslator.FromHtml("#f5f3fa"), DarkTheme.Background);
        Assert.Equal(ColorTranslator.FromHtml("#6a5fb8"), DarkTheme.Accent);
        Assert.Equal(ColorTranslator.FromHtml("#e3f1fd"), DarkTheme.ManaBubble);
        Assert.True(DarkTheme.IsLight);
        Assert.Equal(Color.White.ToArgb(), DarkTheme.OnAccent.ToArgb());
        Assert.Contains(DarkTheme.Presets, p => p.Id == "mana" && p.Label == "Mana");
    }

    // Mana night: her glass after dark. It keeps the glass look, but every white veil the light glass uses
    // becomes a faint one, so nothing glares on the navy page.
    [Fact]
    public void ApplyPreset_ManaNightIsDarkGlassWithFaintVeils()
    {
        DarkTheme.ApplyPreset("manaNight", null);

        Assert.True(DarkTheme.IsGlass);
        Assert.False(DarkTheme.IsLight);
        Assert.Equal(ColorTranslator.FromHtml("#181624"), DarkTheme.Background);
        Assert.Equal(ColorTranslator.FromHtml("#a99ef0"), DarkTheme.Accent);
        Assert.Contains(DarkTheme.Presets, p => p.Id == "manaNight" && p.Label == "Mana night");
        Assert.True(GlassSurface.Veil(200).A <= 60);
        Assert.True(GlassSurface.GlassFill.A <= 60);

        DarkTheme.ApplyPreset("mana", null);
        Assert.Equal(200, GlassSurface.Veil(200).A);
    }

    [Fact]
    public void ApplyPreset_LightPresetsGetDarkerCodeAndStatusColors()
    {
        DarkTheme.ApplyPreset("violet", null);
        var darkCode = DarkTheme.CodeText;
        Assert.False(DarkTheme.IsLight);
        Assert.Equal(ColorTranslator.FromHtml("#171513").ToArgb(), DarkTheme.OnAccent.ToArgb());

        DarkTheme.ApplyPreset("light", null);

        Assert.NotEqual(darkCode, DarkTheme.CodeText);
        Assert.Equal(ColorTranslator.FromHtml("#23874a"), DarkTheme.Green);
        Assert.True(DarkTheme.IsLight);
    }
}
