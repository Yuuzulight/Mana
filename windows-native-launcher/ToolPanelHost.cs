using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1118: the chat window's docked tool panel, between the chat and the rail
// (#652's design). Every rail tool (Artifacts, Settings, Background tasks,
// Terminal, Browser) opens in it through one host API:
//
//   Button SessionListForm.RegisterRailTool(string id, string icon, string label, Func<Control> createContent)
//
// which makes the rail icon and calls Add below. Rail order, top to bottom,
// is registration order (set the returned button's Dock to Bottom to sit
// with Settings instead).
// - createContent runs the first time the tool opens; its control is kept
//   (hidden, not disposed) while another tool is open. If it throws, the
//   panel shows the error with Retry instead of an empty panel.
// - Clicking a tool's icon opens it and gives the icon the lavender "active"
//   fill (IsOpen); clicking the open tool's icon again closes the panel.
// - Pin keeps the panel open across chat switches and sends; unpinned,
//   CloseUnlessPinned (the chat got focus, or I switched chats) closes it.
// - Ctrl+1...Ctrl+5 open the tools in rail order (HandleShortcut); Esc
//   closes an unpinned panel (SessionListForm.ProcessCmdKey).
// - The open tool, the pin and the width are saved in ManaSettingsStore
//   (RailTool, RailToolPinned, RailToolWidth); a pinned tool reopens on launch.
internal sealed class ToolPanelHost : Panel
{
    private const int MinWidth = 160;
    private const int MaxWidth = 600;

    private sealed class Tool(string id, string label, Button? button, Func<Control> create)
    {
        public string Id { get; } = id;
        public string Label { get; } = label;
        public Button? Button { get; } = button;
        public Func<Control> Create { get; } = create;
        public Control? Content { get; set; }
    }

    private readonly List<Tool> tools = new();
    private readonly Label titleLabel = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(10, 0, 0, 0), ForeColor = DarkTheme.Text };
    private readonly Font titleFont;
    private readonly Button pinButton = new() { Text = "Pin", Dock = DockStyle.Right, Width = 40, FlatStyle = FlatStyle.Flat };
    private readonly Button closeButton = new() { Text = "×", Dock = DockStyle.Right, Width = 26, FlatStyle = FlatStyle.Flat, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Muted };
    private readonly Panel body = new() { Dock = DockStyle.Fill };
    private readonly Panel errorRow = new() { Dock = DockStyle.Top, Height = 52, Visible = false, Padding = new Padding(10, 6, 10, 6) };
    private readonly Label errorLabel = new() { Dock = DockStyle.Fill, ForeColor = DarkTheme.Muted, AutoEllipsis = true };
    private readonly Button retryButton = new() { Text = "Retry", Dock = DockStyle.Right, Width = 60, AccessibleName = "Retry opening the tool" };
    private readonly ToolTip toolTip;
    // null = the real settings file; tests pass a temp one.
    private readonly string? settingsPath;
    private readonly string? restoreId;
    private bool pinned;

    // Docked right beside the panel, shown and hidden with it (a stranded
    // 4px bar otherwise); the form adds it to its Controls next to this.
    public Splitter Splitter { get; } = new() { Dock = DockStyle.Right, Width = 4, BackColor = DarkTheme.Border, MinSize = MinWidth, MinExtra = 240, Visible = false };

    public string? OpenId { get; private set; }

    public ToolPanelHost(ToolTip toolTip, string? settingsPath = null)
    {
        this.toolTip = toolTip;
        this.settingsPath = settingsPath;
        Dock = DockStyle.Right;
        Visible = false;
        BackColor = DarkTheme.Panel2;
        AccessibleName = "Tool panel";

        var saved = ManaSettingsStore.Load(settingsPath);
        Width = Math.Clamp(saved.RailToolWidth ?? 320, MinWidth, MaxWidth);
        restoreId = saved.RailToolPinned ? saved.RailTool : null;

        titleFont = new Font(titleLabel.Font, FontStyle.Bold);
        titleLabel.Font = titleFont;
        pinButton.FlatAppearance.BorderSize = 0;
        closeButton.FlatAppearance.BorderSize = 0;
        closeButton.AccessibleName = "Close panel";
        toolTip.SetToolTip(closeButton, "Close");
        closeButton.Click += (_, _) => Close();
        pinButton.Click += (_, _) => Pinned = !Pinned;
        SetPinned(saved.RailToolPinned, save: false);
        var header = new Panel { Dock = DockStyle.Top, Height = 28, BackColor = DarkTheme.Panel };
        // Last added docks first: × outermost right, Pin inside it, the title fills the rest.
        header.Controls.Add(titleLabel);
        header.Controls.Add(pinButton);
        header.Controls.Add(closeButton);

        DarkTheme.ApplyButton(retryButton);
        retryButton.Click += (_, _) =>
        {
            if (OpenId is { } id)
            {
                OpenId = null; // so Open builds it again
                Open(id);
            }
        };
        errorRow.Controls.Add(errorLabel);
        errorRow.Controls.Add(retryButton);

        Controls.Add(body);
        Controls.Add(errorRow);
        Controls.Add(header);

        Splitter.SplitterMoved += (_, _) =>
        {
            Width = Math.Clamp(Width, MinWidth, MaxWidth);
            Save(s => s.RailToolWidth = Width);
        };
    }

    public bool Pinned
    {
        get => pinned;
        set => SetPinned(value, save: true);
    }

    public bool IsOpen(string id) => OpenId == id;

    // The host half of SessionListForm.RegisterRailTool: the icon is already
    // made. A null button (#1127's docs) is a tool with no rail icon, opened
    // only through Open.
    public void Add(string id, string label, Button? button, Func<Control> createContent)
    {
        tools.Add(new Tool(id, label, button, createContent));
        if (button is not null)
        {
            button.AccessibleName ??= label;
            button.Click += (_, _) => Toggle(id);
        }
        if (id == restoreId && button is not null && OpenId is null)
        {
            Open(id);
        }
    }

    public void Toggle(string id)
    {
        if (OpenId == id)
        {
            Close();
        }
        else
        {
            Open(id);
        }
    }

    public void Open(string id)
    {
        var tool = tools.FirstOrDefault(t => t.Id == id);
        if (tool is null || OpenId == id)
        {
            return;
        }
        OpenId = id;
        titleLabel.Text = tool.Label;
        errorRow.Visible = false;
        if (tool.Content is null)
        {
            try
            {
                var content = tool.Create();
                content.Dock = DockStyle.Fill;
                body.Controls.Add(content);
                tool.Content = content;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"ToolPanelHost: couldn't open {tool.Label}. {ex}");
                errorLabel.Text = $"Couldn't open {tool.Label}: {ex.Message}";
                errorRow.Visible = true;
            }
        }
        foreach (var t in tools)
        {
            if (t.Content is not null)
            {
                t.Content.Visible = t == tool;
            }
            t.Button?.Invalidate();
        }
        Visible = true;
        Splitter.Visible = true;
        Save(s => s.RailTool = id);
    }

    public void Close()
    {
        if (OpenId is null)
        {
            return;
        }
        var wasOpen = tools.First(t => t.Id == OpenId);
        OpenId = null;
        Visible = false;
        Splitter.Visible = false;
        wasOpen.Button?.Invalidate();
        Save(s => s.RailTool = null);
    }

    // The chat got focus, or I switched chats. True when it closed.
    public bool CloseUnlessPinned()
    {
        if (OpenId is null || pinned)
        {
            return false;
        }
        Close();
        return true;
    }

    // Ctrl+1...Ctrl+5: the Nth tool in rail order (by where its icon sits,
    // so a tool docked at the bottom with Settings counts last). Moves focus
    // into the tool for keyboard use. True when handled.
    public bool HandleShortcut(Keys keyData)
    {
        var n = (int)keyData - (int)(Keys.Control | Keys.D1);
        if (n < 0 || n > 4)
        {
            return false;
        }
        var tool = tools.Where(t => t.Button is not null).OrderBy(t => t.Button!.Top).ElementAtOrDefault(n);
        if (tool is null)
        {
            return false;
        }
        Open(tool.Id);
        body.SelectNextControl(null, forward: true, tabStopOnly: true, nested: true, wrap: false);
        return true;
    }

    private void SetPinned(bool value, bool save)
    {
        pinned = value;
        pinButton.Text = value ? "Unpin" : "Pin";
        pinButton.Width = value ? 50 : 40;
        pinButton.BackColor = value ? DarkTheme.Accent : DarkTheme.Panel2;
        pinButton.ForeColor = value ? DarkTheme.OnAccent : DarkTheme.Muted;
        pinButton.AccessibleName = value ? "Unpin panel" : "Pin panel open";
        toolTip.SetToolTip(pinButton, value ? "Unpin: close the panel when I click back into the chat" : "Pin: keep the panel open while I chat");
        if (save)
        {
            Save(s => s.RailToolPinned = value);
        }
    }

    private void Save(Action<ManaSettingsStore> change)
    {
        try
        {
            var settings = ManaSettingsStore.Load(settingsPath);
            change(settings);
            settings.Save(settingsPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.WriteLine($"ToolPanelHost: couldn't save the tool panel's state. {ex.Message}");
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            titleFont.Dispose();
        }
        base.Dispose(disposing);
    }
}
