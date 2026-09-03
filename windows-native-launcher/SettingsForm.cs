using System.Drawing;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #529 scaffold: Settings as a modal dialog over MainForm, matching the
// mock-up's "popup over the window" shape -- a nav rail (Avatar/Web
// access/Vision/Model/Doctor) plus a content pane, with Core Settings
// (Idle-Pester) as the one section actually built out here. The nav
// items and Theme/Plugins sections are placeholders; #529 owns wiring
// each one to real state.
internal sealed class SettingsForm : Form
{
    private static readonly Color BgColor = ColorTranslator.FromHtml("#1c1a18");
    private static readonly Color Panel2Color = ColorTranslator.FromHtml("#2c2a27");
    private static readonly Color TextColor = ColorTranslator.FromHtml("#e8e4de");
    private static readonly Color MutedColor = ColorTranslator.FromHtml("#948d84");

    private readonly Panel idlePesterDetail = new();

    public SettingsForm()
    {
        Text = "Settings";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        Size = new Size(560, 420);
        BackColor = BgColor;
        Font = new Font(Font.FontFamily, 9f);

        var navRail = BuildNavRail();
        var content = BuildContent();

        Controls.Add(content);
        Controls.Add(navRail);
    }

    private Panel BuildNavRail()
    {
        var rail = new Panel
        {
            Dock = DockStyle.Left,
            Width = 150,
            BackColor = BgColor,
        };

        var y = 12;
        // #529: each of these opens its own detail view (avatar file
        // picker, remote-AI provider list, doctor checks, ...) -- inert
        // here, they're just the nav shape.
        foreach (var label in new[] { "Avatar", "Web access", "Vision", "Model", "Doctor" })
        {
            var item = new Button
            {
                Text = label,
                FlatStyle = FlatStyle.Flat,
                BackColor = BgColor,
                ForeColor = MutedColor,
                TextAlign = ContentAlignment.MiddleLeft,
                Top = y,
                Left = 10,
                Width = 130,
                Height = 28,
            };
            item.FlatAppearance.BorderSize = 0;
            item.FlatAppearance.MouseOverBackColor = Panel2Color;
            rail.Controls.Add(item);
            y += 30;
        }

        return rail;
    }

    // A content-width constant rather than Dock=Fill sizing: the dialog
    // is FixedDialog (no resize handle), so there's no live width to
    // track, and a FlowLayoutPanel is used instead of a plain Panel so
    // each group's bottom Margin is actually honored -- Margin on a
    // Dock-positioned child of a plain Panel is silently ignored.
    private const int ContentWidth = 372;

    private FlowLayoutPanel BuildContent()
    {
        var content = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = BgColor,
            Padding = new Padding(16),
            AutoScroll = true,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
        };

        content.Controls.Add(BuildCoreSettingsGroup());
        content.Controls.Add(BuildPlaceholderGroup("Theme", "Accent color, presets -- see the mock-up's chip picker."));
        content.Controls.Add(BuildPlaceholderGroup("Plugins", "Per-plugin toggles, Get More Plugins browser."));

        return content;
    }

    private GroupBox BuildPlaceholderGroup(string title, string note)
    {
        var group = new GroupBox
        {
            Text = title,
            ForeColor = TextColor,
            Width = ContentWidth,
            Height = 70,
            Margin = new Padding(0, 0, 0, 12),
        };
        group.Controls.Add(new Label
        {
            Text = note,
            ForeColor = MutedColor,
            AutoSize = false,
            Dock = DockStyle.Fill,
            Padding = new Padding(8),
        });
        return group;
    }

    private GroupBox BuildCoreSettingsGroup()
    {
        var group = new GroupBox
        {
            Text = "Core Settings",
            ForeColor = TextColor,
            Width = ContentWidth,
            Height = 110,
            Margin = new Padding(0, 0, 0, 12),
        };

        var idlePesterToggle = new CheckBox
        {
            Text = "Idle-Pester -- bored little-sister check-ins when you've been away",
            ForeColor = TextColor,
            AutoSize = true,
            Checked = true,
            Top = 22,
            Left = 10,
        };
        idlePesterToggle.CheckedChanged += (_, _) => idlePesterDetail.Visible = idlePesterToggle.Checked;
        group.Controls.Add(idlePesterToggle);

        idlePesterDetail.Top = 46;
        idlePesterDetail.Left = 10;
        idlePesterDetail.Height = 56;
        idlePesterDetail.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

        var thresholdLabel = new Label { Text = "Pester after idle for", ForeColor = MutedColor, AutoSize = true, Top = 4, Left = 0 };
        var thresholdBox = new NumericUpDown { Minimum = 5, Maximum = 120, Increment = 5, Value = 25, Top = 0, Left = 130, Width = 60 };
        var thresholdUnit = new Label { Text = "min", ForeColor = MutedColor, AutoSize = true, Top = 4, Left = 196 };

        var deliveryLabel = new Label { Text = "Delivery", ForeColor = MutedColor, AutoSize = true, Top = 30, Left = 0 };
        var spokenOption = new RadioButton { Text = "Spoken", ForeColor = TextColor, Checked = true, AutoSize = true, Top = 28, Left = 130 };
        var popupOption = new RadioButton { Text = "Pop-up", ForeColor = TextColor, AutoSize = true, Top = 28, Left = 200 };

        idlePesterDetail.Controls.Add(thresholdLabel);
        idlePesterDetail.Controls.Add(thresholdBox);
        idlePesterDetail.Controls.Add(thresholdUnit);
        idlePesterDetail.Controls.Add(deliveryLabel);
        idlePesterDetail.Controls.Add(spokenOption);
        idlePesterDetail.Controls.Add(popupOption);
        group.Controls.Add(idlePesterDetail);

        return group;
    }
}
