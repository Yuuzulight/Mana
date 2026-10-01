using System.Drawing;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #688: switching presets with windows open, including to and from the Mana glass look.
[Collection("DarkTheme palette")]
public class LiveThemeTests
{
    private sealed class ThemedWindow : Form
    {
        public readonly Panel Card = new() { Dock = DockStyle.Top, Height = 40 };
        public readonly Panel Plain = new() { Dock = DockStyle.Top, Height = 40 };
        public readonly Label Caption = new() { Text = "hi" };
        public readonly Button Send = new() { Text = "Send", FlatStyle = FlatStyle.Flat };

        public ThemedWindow()
        {
            ShowInTaskbar = false;
            DarkTheme.ApplyForm(this); // handle now -> in Application.OpenForms
            Card.BackColor = DarkTheme.Panel;
            Plain.BackColor = DarkTheme.Background;
            Caption.BackColor = DarkTheme.Panel2;
            Caption.ForeColor = DarkTheme.Text;
            DarkTheme.ApplyButton(Send);
            Controls.Add(Card);
            Controls.Add(Plain);
            Controls.Add(Caption);
            Controls.Add(Send);
        }
    }

    [Fact]
    public void PlainPresetToPlainPreset_RecoloursEveryPaletteColour()
    {
        DarkTheme.ApplyPreset("violet", null);
        using var window = new ThemedWindow();

        DarkTheme.ApplyPresetLive("light", null);

        Assert.Equal(DarkTheme.Background.ToArgb(), window.BackColor.ToArgb());
        Assert.Equal(DarkTheme.Panel.ToArgb(), window.Card.BackColor.ToArgb());
        Assert.Equal(DarkTheme.Panel2.ToArgb(), window.Caption.BackColor.ToArgb());
        Assert.Equal(DarkTheme.Text.ToArgb(), window.Caption.ForeColor.ToArgb());
        Assert.Equal(DarkTheme.Border.ToArgb(), window.Send.FlatAppearance.BorderColor.ToArgb());
    }

    [Fact]
    public void IntoAndOutOfManaGlass_GlassComesOffWithoutATrace()
    {
        DarkTheme.ApplyPreset("violet", null);
        using var window = new ThemedWindow();

        DarkTheme.ApplyPresetLive("mana", null);
        Assert.True(GlassSurface.IsAttached(window));
        Assert.Equal(GlassSurface.GlassFill, window.Card.BackColor);
        Assert.Equal(Color.Transparent, window.Plain.BackColor);
        Assert.NotNull(window.BackgroundImage);

        DarkTheme.ApplyPresetLive("neutral", null);
        Assert.False(GlassSurface.IsAttached(window));
        Assert.Null(window.BackgroundImage);
        Assert.Equal(DarkTheme.Panel.ToArgb(), window.Card.BackColor.ToArgb());
        Assert.Equal(DarkTheme.Background.ToArgb(), window.Plain.BackColor.ToArgb());
        Assert.Equal(DarkTheme.Panel2.ToArgb(), window.Send.BackColor.ToArgb());
        Assert.Equal(DarkTheme.Border.ToArgb(), window.Send.FlatAppearance.MouseOverBackColor.ToArgb());
    }

    // A window another thread owns (another test class's, running in
    // parallel) may be closed at any moment, so a live switch leaves it alone.
    [Fact]
    public void LiveSwitch_LeavesAnotherThreadsWindowAlone()
    {
        DarkTheme.ApplyPreset("violet", null);
        var violet = DarkTheme.Background.ToArgb();
        ThemedWindow? other = null;
        using var created = new ManualResetEventSlim();
        using var done = new ManualResetEventSlim();
        var thread = new Thread(() =>
        {
            other = new ThemedWindow();
            created.Set();
            done.Wait();
            other.Dispose();
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        created.Wait();
        try
        {
            DarkTheme.ApplyPresetLive("light", null);
            Assert.Equal(violet, other!.BackColor.ToArgb());
        }
        finally
        {
            done.Set();
            thread.Join();
            DarkTheme.ApplyPreset("violet", null);
        }
    }

    [Fact]
    public void Remap_KeepsTwoEqualColoursApartOnceItKnowsWhichIsWhich()
    {
        var before = new[] { Color.Black, Color.Black };  // High contrast: background == panel
        var middle = new[] { Color.Red, Color.Blue };
        var after = new[] { Color.Green, Color.Yellow };
        var slot = 1;                                      // known from an earlier switch: it's the panel
        Assert.Equal(Color.Blue, DarkTheme.Remap(Color.Black, before, middle, ref slot));
        Assert.Equal(Color.Yellow, DarkTheme.Remap(Color.Blue, middle, after, ref slot));
        var unknown = -1;
        Assert.Equal(Color.Transparent, DarkTheme.Remap(Color.Transparent, before, after, ref unknown));
    }
}
