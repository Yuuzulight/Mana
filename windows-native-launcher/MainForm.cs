using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #520/#521 scaffold: the native launcher's full "opened" window -- the
// session sidebar (#520) and the chat surface itself (#521), custom-drawn
// (FormBorderStyle.None) to match windows-launcher's own dark chrome
// instead of the OS titlebar. Hidden at startup; ManaApplicationContext
// owns showing/hiding it from the tray icon. This form never really
// closes on its own -- the titlebar's own controls and the close box both
// hide it back to the tray+overlay state, matching how the mock-up's
// minimize button worked. Only the tray menu's "Exit Mana" tears the
// whole app down (see AllowExit).
//
// This is a structural scaffold, not the finished feature: the tool
// panels (Browser/Terminal/Artifacts/Background Tasks) and the Settings
// dialog show placeholder content deep enough to prove the layout, not
// full implementations -- those are their own follow-up issues (#522-529)
// off #479.
internal sealed class MainForm : Form
{
    private static readonly Color BgColor = ColorTranslator.FromHtml("#1c1a18");
    private static readonly Color PanelColor = ColorTranslator.FromHtml("#242220");
    private static readonly Color Panel2Color = ColorTranslator.FromHtml("#2c2a27");
    private static readonly Color BorderColor = ColorTranslator.FromHtml("#3a3733");
    private static readonly Color TextColor = ColorTranslator.FromHtml("#e8e4de");
    private static readonly Color MutedColor = ColorTranslator.FromHtml("#948d84");
    private static readonly Color AccentColor = ColorTranslator.FromHtml("#9d8ce0");
    private static readonly Color UserBubbleColor = ColorTranslator.FromHtml("#3a3560");
    private static readonly Color ManaBubbleColor = ColorTranslator.FromHtml("#2a2725");

    private readonly ManaBackendClient backendClient;
    private readonly Action openSettings;

    private readonly Panel titleBar = new();
    private readonly Panel sidebar = new();
    private readonly Panel messageScroll = new();
    private readonly Panel composerBar = new();
    private readonly TextBox composerBox = new();
    private readonly Panel toolRail = new();
    private readonly Panel toolPanel = new();
    private readonly Label toolPanelTitle = new();
    private readonly Panel toolPanelBody = new();
    private readonly Dictionary<string, Button> railButtons = new();

    private int nextBubbleTop;
    private string? activeTool;
    private bool allowClose;
    private Point dragMouseOffset;
    private bool dragging;

    public MainForm(ManaBackendClient backendClient, Action openSettings)
    {
        this.backendClient = backendClient;
        this.openSettings = openSettings;

        Text = "Mana";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1020, 720);
        MinimumSize = new Size(760, 520);
        BackColor = BgColor;

        BuildTitleBar();
        BuildToolRail();
        BuildToolPanel();
        BuildSidebar();
        var chatArea = BuildChatShell();

        // Dock order matters: the first control added claims its edge
        // first, so the fill area goes in last, after every edge-docked
        // panel above it has already staked its strip. Final layout,
        // left to right: sidebar (240) | chat (fill) | toolPanel (300) |
        // toolRail (44), with titleBar spanning the top of all of it.
        Controls.Add(titleBar);
        Controls.Add(toolRail);
        Controls.Add(toolPanel);
        Controls.Add(sidebar);
        Controls.Add(chatArea);

        // The tool panel starts closed -- ToggleTool calls ShowTool(tool)
        // fresh the first time a rail button opens it, so there's nothing
        // to prime here.
        toolPanel.Visible = false;

        // messageScroll has no real ClientSize until it's actually
        // parented and laid out, so the two seed bubbles are appended
        // once the form has actually been shown rather than here in the
        // constructor -- appending earlier would measure/position them
        // against Panel's zero-ish default size instead of the real one.
        Shown += (_, _) =>
        {
            AppendBubble("hey, welcome back~", isUser: false);
            AppendBubble("hey mana", isUser: true);
        };
    }

    // Only ManaApplicationContext's real "Exit Mana" path should call
    // this before Close(); every other close (the titlebar box, Alt+F4,
    // the system menu) should just hide the window like minimizing does.
    public void AllowExit() => allowClose = true;

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!allowClose)
        {
            e.Cancel = true;
            Hide();
            return;
        }

        base.OnFormClosing(e);
    }

    private void BuildTitleBar()
    {
        titleBar.Dock = DockStyle.Top;
        titleBar.Height = 30;
        titleBar.BackColor = BgColor;
        titleBar.MouseDown += (_, e) => { dragging = true; dragMouseOffset = e.Location; };
        titleBar.MouseMove += (_, e) => { if (dragging) Location = new Point(Location.X + e.X - dragMouseOffset.X, Location.Y + e.Y - dragMouseOffset.Y); };
        titleBar.MouseUp += (_, _) => dragging = false;

        var titleLabel = new Label
        {
            Text = "Mana — native",
            ForeColor = MutedColor,
            BackColor = Color.Transparent,
            AutoSize = true,
            Location = new Point(14, 8),
            Font = new Font(Font.FontFamily, 9f),
        };
        titleBar.Controls.Add(titleLabel);

        var minimizeButton = MakeIconButton("_", "Minimize to tray");
        minimizeButton.Location = new Point(titleBar.Width - 34, 4);
        minimizeButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        minimizeButton.Click += (_, _) => Hide();
        titleBar.Controls.Add(minimizeButton);
    }

    private Panel BuildChatShell()
    {
        var chatPane = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = BgColor,
            Padding = new Padding(0),
        };

        composerBar.Dock = DockStyle.Bottom;
        composerBar.Height = 56;
        composerBar.Padding = new Padding(20, 10, 20, 14);
        composerBar.BackColor = BgColor;

        composerBox.Dock = DockStyle.Fill;
        composerBox.Multiline = false;
        composerBox.BackColor = Panel2Color;
        composerBox.ForeColor = TextColor;
        composerBox.BorderStyle = BorderStyle.FixedSingle;
        composerBox.Font = new Font(Font.FontFamily, 10.5f);
        composerBox.PlaceholderText = "Message Mana…";
        composerBox.KeyDown += async (_, e) =>
        {
            if (e.KeyCode != Keys.Enter)
            {
                return;
            }

            e.SuppressKeyPress = true;
            await SendCurrentMessageAsync();
        };
        composerBar.Controls.Add(composerBox);

        messageScroll.Dock = DockStyle.Fill;
        messageScroll.AutoScroll = true;
        messageScroll.BackColor = BgColor;
        // Padding has no effect here -- AppendBubble positions each
        // bubble manually rather than through docking, so the margins
        // below are baked into that math (MessageScrollMargin*) instead.

        chatPane.Controls.Add(messageScroll);
        chatPane.Controls.Add(composerBar);
        return chatPane;
    }

    // #521 review: FlowLayoutPanel's alignment model can't easily put
    // some children flush-left and others flush-right in the same
    // vertical flow, so the bubble list is laid out by hand -- each
    // bubble is measured, clamped to 60% of the scroll area's width, and
    // placed against whichever edge its side owns. nextBubbleTop is the
    // running vertical cursor. messageScroll.Padding does nothing for
    // manually-positioned children, so these margins are applied directly
    // instead of relying on it.
    private const int MessageScrollSideMargin = 28;
    private const int MessageScrollTopMargin = 20;

    private void AppendBubble(string text, bool isUser)
    {
        var maxWidth = (int)(messageScroll.ClientSize.Width * 0.6);
        var textSize = TextRenderer.MeasureText(text, Font, new Size(maxWidth - 24, int.MaxValue), TextFormatFlags.WordBreak);

        var bubble = new Panel
        {
            BackColor = isUser ? UserBubbleColor : ManaBubbleColor,
            Size = new Size(textSize.Width + 24, textSize.Height + 20),
            Top = MessageScrollTopMargin + nextBubbleTop,
        };
        bubble.Left = isUser
            ? messageScroll.ClientSize.Width - bubble.Width - MessageScrollSideMargin
            : MessageScrollSideMargin;
        ApplyRoundedRegion(bubble, 10);

        var label = new Label
        {
            Text = text,
            ForeColor = TextColor,
            BackColor = Color.Transparent,
            Dock = DockStyle.Fill,
            Padding = new Padding(12, 10, 12, 10),
            Font = new Font(Font.FontFamily, 10f),
        };
        bubble.Controls.Add(label);
        messageScroll.Controls.Add(bubble);
        nextBubbleTop += bubble.Height + 14;
    }

    private async Task SendCurrentMessageAsync()
    {
        var text = composerBox.Text.Trim();
        if (text.Length == 0)
        {
            return;
        }

        composerBox.Text = string.Empty;
        AppendBubble(text, isUser: true);

        try
        {
            var reply = await backendClient.ReplyAsync(text);
            AppendBubble(reply, isUser: false);
        }
        catch (Exception error)
        {
            AppendBubble($"(couldn't reach the backend: {error.Message})", isUser: false);
        }
    }

    // sidebar's children are manually positioned (not docked/flow-laid-out),
    // and Padding has no effect on those -- so the 14px/12px margins the
    // mock-up used are baked into these offsets directly instead.
    private const int SidebarSideMargin = 14;
    private const int SidebarTopMargin = 12;

    private void BuildSidebar()
    {
        sidebar.Dock = DockStyle.Left;
        sidebar.Width = 240;
        sidebar.BackColor = BgColor;
        sidebar.Controls.Add(new Panel { Dock = DockStyle.Right, Width = 1, BackColor = BorderColor });

        var logo = new Label
        {
            Text = "Mana",
            ForeColor = TextColor,
            BackColor = Color.Transparent,
            Font = new Font(Font.FontFamily, 12f, FontStyle.Bold),
            AutoSize = true,
            Top = SidebarTopMargin,
            Left = SidebarSideMargin,
        };
        sidebar.Controls.Add(logo);

        var newChatButton = new Button
        {
            Text = "+ New chat",
            FlatStyle = FlatStyle.Flat,
            BackColor = AccentColor,
            ForeColor = ColorTranslator.FromHtml("#171513"),
            Top = SidebarTopMargin + 32,
            Left = SidebarSideMargin,
            Width = 240 - (SidebarSideMargin * 2),
            Height = 30,
            TextAlign = ContentAlignment.MiddleLeft,
        };
        newChatButton.FlatAppearance.BorderSize = 0;
        // #520: session list/switch/rename/delete is the rest of this
        // issue -- wiring a real session store is out of scope for this
        // scaffold, so this just clears the visible transcript for now.
        newChatButton.Click += (_, _) =>
        {
            messageScroll.Controls.Clear();
            nextBubbleTop = 0;
        };
        sidebar.Controls.Add(newChatButton);

        var artifactsItem = BuildNavItem("Artifacts", top: SidebarTopMargin + 74);
        artifactsItem.Click += (_, _) => ShowTool("artifacts");
        sidebar.Controls.Add(artifactsItem);

        var sessionsItem = BuildNavItem("Sessions", top: SidebarTopMargin + 110);
        sidebar.Controls.Add(sessionsItem);

        var avatarCard = new Panel
        {
            BackColor = PanelColor,
            Height = 70,
            Left = SidebarSideMargin,
            Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
        };
        avatarCard.Paint += (_, e) => e.Graphics.DrawString("Mana — idle", Font, new SolidBrush(MutedColor), 10, 26);
        sidebar.Resize += (_, _) =>
        {
            avatarCard.Width = sidebar.ClientSize.Width - (SidebarSideMargin * 2);
            avatarCard.Top = sidebar.ClientSize.Height - SidebarTopMargin - avatarCard.Height;
        };
        sidebar.Controls.Add(avatarCard);
    }

    private Button BuildNavItem(string label, int top)
    {
        var button = new Button
        {
            Text = label,
            FlatStyle = FlatStyle.Flat,
            BackColor = BgColor,
            ForeColor = MutedColor,
            Top = top,
            Left = SidebarSideMargin,
            Width = 240 - (SidebarSideMargin * 2),
            Height = 30,
            TextAlign = ContentAlignment.MiddleLeft,
        };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = Panel2Color;
        return button;
    }

    private void BuildToolRail()
    {
        toolRail.Dock = DockStyle.Right;
        toolRail.Width = 44;
        toolRail.BackColor = BgColor;
        toolRail.Controls.Add(new Panel { Dock = DockStyle.Left, Width = 1, BackColor = BorderColor });

        AddRailButton("browser", "B", "Browser", top: 12);
        AddRailButton("terminal", ">_", "Terminal", top: 50);
        AddRailButton("artifacts", "[]", "Artifacts", top: 88);
        AddRailButton("tasks", "=", "Background Tasks", top: 126);

        var settingsButton = MakeIconButton("*", "Settings");
        settingsButton.Anchor = AnchorStyles.Bottom;
        settingsButton.Click += (_, _) => openSettings();
        toolRail.Resize += (_, _) => settingsButton.Top = toolRail.ClientSize.Height - settingsButton.Height - 10;
        toolRail.Controls.Add(settingsButton);
    }

    private void AddRailButton(string tool, string glyph, string tooltip, int top)
    {
        var button = MakeIconButton(glyph, tooltip);
        button.Top = top;
        button.Click += (_, _) => ToggleTool(tool);
        toolRail.Controls.Add(button);
        railButtons[tool] = button;
    }

    // Matches the mock-up: clicking the already-open tool's rail icon
    // closes the panel instead of leaving it open and inert.
    private void ToggleTool(string tool)
    {
        if (activeTool == tool && toolPanel.Visible)
        {
            toolPanel.Visible = false;
            activeTool = null;
            foreach (var button in railButtons.Values)
            {
                button.BackColor = BgColor;
                button.ForeColor = MutedColor;
            }
            return;
        }

        ShowTool(tool);
    }

    private Button MakeIconButton(string glyph, string tooltip)
    {
        var button = new Button
        {
            Text = glyph,
            FlatStyle = FlatStyle.Flat,
            BackColor = BgColor,
            ForeColor = MutedColor,
            Width = 30,
            Height = 30,
            Left = 7,
        };
        button.FlatAppearance.BorderSize = 0;
        button.FlatAppearance.MouseOverBackColor = Panel2Color;
        var toolTip = new ToolTip();
        toolTip.SetToolTip(button, tooltip);
        return button;
    }

    private void BuildToolPanel()
    {
        toolPanel.Dock = DockStyle.Right;
        toolPanel.Width = 300;
        toolPanel.BackColor = PanelColor;
        toolPanel.Padding = new Padding(0);

        var header = new Panel { Dock = DockStyle.Top, Height = 40, BackColor = PanelColor };
        toolPanelTitle.ForeColor = TextColor;
        toolPanelTitle.BackColor = Color.Transparent;
        toolPanelTitle.Font = new Font(Font.FontFamily, 10f, FontStyle.Bold);
        toolPanelTitle.AutoSize = true;
        toolPanelTitle.Location = new Point(14, 11);
        header.Controls.Add(toolPanelTitle);

        toolPanelBody.Dock = DockStyle.Fill;
        toolPanelBody.BackColor = PanelColor;
        toolPanelBody.Padding = new Padding(14);
        toolPanelBody.AutoScroll = true;

        toolPanel.Controls.Add(toolPanelBody);
        toolPanel.Controls.Add(header);
    }

    // #522-528 own each tool's real content (browser live-view, terminal
    // output, artifact rendering, the background-tasks list); this just
    // proves the one-panel-many-tools shape from the mock-up.
    private void ShowTool(string tool)
    {
        activeTool = tool;
        toolPanel.Visible = true;
        toolPanelBody.Controls.Clear();

        toolPanelTitle.Text = tool switch
        {
            "browser" => "Browser",
            "terminal" => "Terminal",
            "tasks" => "Background Tasks",
            _ => "Artifacts",
        };

        var placeholder = new Label
        {
            AutoSize = false,
            Dock = DockStyle.Top,
            Height = 60,
            ForeColor = MutedColor,
            Text = tool switch
            {
                "browser" => "Browser live-view -- see issue #418.",
                "terminal" => "Terminal output panel.",
                "tasks" => "Dream Mode, cron, and coding-agent runs will list here.",
                _ => "Artifact preview renders here.",
            },
        };
        toolPanelBody.Controls.Add(placeholder);

        foreach (var (name, button) in railButtons)
        {
            button.BackColor = name == tool ? Panel2Color : BgColor;
            button.ForeColor = name == tool ? AccentColor : MutedColor;
        }
    }

    private static void ApplyRoundedRegion(Control control, int radius)
    {
        var bounds = new Rectangle(Point.Empty, control.Size);
        using var path = new GraphicsPath();
        var d = radius * 2;
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        control.Region = new Region(path);
    }
}
