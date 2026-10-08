using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #529/#581/#582: a lean settings surface -- plugins (enable/disable),
// memory facts (view/archive), skills (view/edit/create/delete via
// SkillEditorDialog, #581), the approval-gate queue (approve/deny), and
// (#582) a live backend log tail. Most tabs are still a plain ListView
// with the one or two actions that matter most, not a full editor --
// see each feature issue's own PR description for the full reasoning.
internal sealed class SettingsPanel : UserControl
{
    private readonly ManaBackendClient backendClient;
    private readonly BackendLogBuffer backendLog;
    // Optional: lets the Perf tab request session-scoped token-budget data
    // (see RefreshPerfTabAsync) -- null in the one caller that doesn't have
    // a session concept (there isn't one today; kept optional so a future
    // caller isn't forced to plumb a session id it may not have).
    private readonly Func<string?>? getCurrentSessionId;
    private readonly ListeningPause? listeningPause; // #922
    private CancellationTokenSource? enrolmentCancel; // #922: set while teaching Mana my voice
    private readonly ListView pluginsList = new();
    private readonly RowList factsList = new();
    // #688: search boxes over the last-loaded plugins/facts.
    private readonly TextBox pluginsSearch = new() { Dock = DockStyle.Fill, PlaceholderText = "Search plugins", AccessibleName = "Search plugins" };
    private readonly TextBox factsSearch = new() { Dock = DockStyle.Top, PlaceholderText = "Search memory", AccessibleName = "Search memory" };
    private System.Collections.Generic.IReadOnlyList<ManaPlugin> plugins = Array.Empty<ManaPlugin>();
    private System.Collections.Generic.IReadOnlyList<ManaMemoryFact> facts = Array.Empty<ManaMemoryFact>();
    // #935: Memory Facts' vault row.
    private readonly Label vaultStatusLabel = new() { AutoSize = true, MaximumSize = new Size(640, 0), ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };
    private readonly LinkLabel vaultSyncButton = new() { Text = "Sync now", AutoSize = true, Enabled = false };
    private readonly RowList skillsList = new() { NameWidth = 160 };
    // Q20: Settings > Skills' "Imported skills" choice, in node-bot's order.
    private static readonly string[] ImportedSkillUseModes = { "free", "each", "first" };
    private readonly ComboBox importedSkillUseBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 180 };
    private readonly ListView approvalsList = new();
    // #1154: remembered always/never answers, with Forget.
    private readonly ListView rememberedList = new() { AccessibleName = "Remembered answers" };
    // #669: index-aligned with ToolApprovalModes below.
    private readonly ComboBox toolApprovalModeCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 320 };
    private static readonly string[] ToolApprovalModes = { "smart", "ask", "off" };
    // #1191: "Git and GitHub" approval, one choice per tier; each combo is
    // index-aligned with GitApprovalModes.
    private static readonly string[] GitApprovalTiers = { "local", "github", "danger" };
    private static readonly string[] GitApprovalModes = { "ask", "once", "off" };
    private readonly ComboBox[] gitApprovalCombos = Array.ConvertAll(GitApprovalTiers, tier => new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 240, AccessibleName = $"Git approval: {tier}" });
    private readonly Label gitDangerWarning = new() { AutoSize = true, MaximumSize = new Size(640, 0), ForeColor = Color.OrangeRed, AccessibleName = "Git danger warning" };
    // #1265: Mana's daily Folio update PRs, through "GitHub writes".
    private readonly CheckBox keepFolioCheck = new() { Text = "Keep Folio up to date (a PR when Folio main moves on, merged once every check passes)", AutoSize = true, ForeColor = DarkTheme.Text, AccessibleName = "Keep Folio up to date" };
    private readonly Label folioStatusLabel = new() { AutoSize = true, ForeColor = DarkTheme.Muted, Margin = new Padding(3, 8, 3, 3), AccessibleName = "Folio check result" };
    private readonly ComboBox voiceProviderCombo = new();
    private readonly TextBox logsTextBox = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill };
    private readonly System.Windows.Forms.Timer logRefreshTimer = new() { Interval = 1000 };
    private readonly Label perfSummaryLabel = new() { AutoSize = true };
    private readonly Label gamingStatusLabel = SettingsRows.Status();
    private readonly SettingsSwitch gamingModeCheck = new() { AccessibleName = "Gaming mode" };
    private readonly ListView perfOperationsList = new();
    private readonly RowList presetsList = new() { NameWidth = 160 };
    // #681: which preset replies actually use ("None" = index 0).
    private readonly ComboBox activePresetCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
    private bool populatingPresets;
    private readonly ListView mobileDevicesList = new();
    private readonly ListView accountsList = new();
    private readonly ListView mcpServersList = new();
    private readonly ListView hooksList = new();
    private bool populatingPlugins;
    private bool populatingHooks;

    // #572: Model tab controls -- kept as fields (unlike most other tabs'
    // plain local variables in their Build*Tab methods) because Refresh
    // needs to repopulate them from a fresh GetModelStatusAsync call, the
    // same reason pluginsList/factsList/etc. above are fields too.
    private readonly ComboBox modelProfileCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200 };
    private readonly Label selectedModelLabel = new() { AutoSize = true };
    private readonly TextBox visionModelPathBox = new() { Width = 300 };
    private readonly TextBox visionMmprojPathBox = new() { Width = 300 };
    // #693: llama.cpp build group. Update stays disabled until a check
    // finds a newer build -- nothing downloads without that click.
    private readonly Label llamaBuildLabel = new() { AutoSize = true, MaximumSize = new Size(560, 0) };
    private readonly Button llamaUpdateButton = new() { Text = "Update", Enabled = false };
    private readonly Button llamaRollbackButton = new() { Text = "Roll back", Enabled = false };
    private bool llamaUpdateAvailable;
    private string? llamaCheckNote;

    public SettingsPanel(ManaBackendClient backendClient, BackendLogBuffer backendLog, Func<string?>? getCurrentSessionId = null, Func<HotkeyAction, Keys?, string?>? bindHotkey = null, ListeningPause? listeningPause = null)
    {
        this.bindHotkey = bindHotkey;
        this.listeningPause = listeningPause;
        this.backendClient = backendClient;
        this.backendLog = backendLog;
        this.getCurrentSessionId = getCurrentSessionId;
        Dock = DockStyle.Fill;
        BackColor = DarkTheme.Background;
        ForeColor = DarkTheme.Text;

        // #1426: nine groups in a sidebar, each holding the pages that used to
        // be tabs of their own, and a search over every page's words. This is
        // stage 1 of the redesign: the pages are regrouped as they are, and
        // stage 2 redraws each group as one page of rows (General, Voice, Check-ins, Memory and Models so far).
        var backendPage = BuildConnectionTab(out var localOnlyPage);
        var timingsPage = BuildPerfTab();
        var privacyPage = BuildPrivacyTab();
        privacyPage.Text = "Your data";
        AddGroup("general", "General", BuildGeneralPage());
        AddGroup("voice", "Voice", BuildVoicePage());
        AddGroup("checkins", "Check-ins", BuildCheckInsPage());
        AddGroup("memory", "Memory", BuildMemoryPage());
        AddGroup("models", "Models", BuildModelsPage());
        AddGroup("permissions", "Permissions", BuildApprovalsTab(),
            new TabPage("Desktop folders") { Controls = { new DesktopFoldersPanel() } }, // #997
            BuildPendingEditsTab());
        AddGroup("privacy", "Privacy", localOnlyPage, privacyPage); // #1336
        AddGroup("connections", "Connections", BuildMailCalendarTab(), BuildMobileDevicesTab(), BuildAccountsTab(), BuildPluginsTab(), BuildMcpServersTab());
        AddGroup("advanced", "Advanced", backendPage, BuildHooksTab(), BuildLogsTab(), timingsPage, BuildDeveloperTab());

        content.Dock = DockStyle.Fill;
        content.BackColor = DarkTheme.Background;
        foreach (var group in groups)
        {
            content.Controls.Add(group.Tabs);
        }
        searchResults.Dock = DockStyle.Fill;
        searchResults.View = View.Details;
        searchResults.FullRowSelect = true;
        searchResults.HeaderStyle = ColumnHeaderStyle.Nonclickable;
        searchResults.Columns.Add("Setting", 300);
        searchResults.Columns.Add("Where", 220);
        searchResults.AccessibleName = "Search results";
        searchResults.Visible = false;
        DarkTheme.ApplyListView(searchResults);
        searchResults.ItemActivate += (_, _) => OpenResult(searchResults.FocusedItem);
        searchResults.MouseClick += (_, e) => OpenResult(searchResults.GetItemAt(e.X, e.Y));
        content.Controls.Add(searchResults);
        content.Controls.Add(BuildUndoBar());
        // Last added docks first: the header and its page pills sit above the page.
        content.Controls.Add(pagePills);
        content.Controls.Add(BuildHeader());
        Controls.Add(content);
        Controls.Add(BuildSidebar());

        // #922: leaving the Voice group mid-enrolment cancels it, like closing Settings.
        GroupChanged += previous =>
        {
            if (previous == "voice")
            {
                enrolmentCancel?.Cancel();
            }
        };
        // #1119: so does Settings being hidden.
        VisibleChanged += (_, _) =>
        {
            if (!Visible)
            {
                enrolmentCancel?.Cancel();
                changes.Clear(); // Ctrl+Z reaches back to when Settings opened
                undoBar.Visible = false;
            }
        };
        DarkTheme.Changed += UpdateNav;
        Disposed += (_, _) =>
        {
            DarkTheme.Changed -= UpdateNav;
            groupFont.Dispose();
            activeGroupFont.Dispose();
            descriptionFont.Dispose();
            titleFont.Dispose();
        };
        ShowGroup("general");
    }

    internal sealed record SettingsGroup(string Id, string Label, string Description, TabControl Tabs);

    private readonly List<SettingsGroup> groups = new();
    private readonly Panel content = new();
    private readonly ListView nav = new();
    private readonly ImageList navRowHeight = new();
    private readonly TextBox searchBox = new();
    private readonly ListView searchResults = new();
    private readonly Label titleLabel = new();
    private readonly Label descriptionLabel = new();
    private readonly FlowLayoutPanel pagePills = new();
    // #1426: the chat window's sidebar fonts, so its rows read the same.
    private readonly Font groupFont = new("Segoe UI", 9.75f);
    private readonly Font activeGroupFont = new("Segoe UI Semibold", 9.75f);
    private readonly Font descriptionFont = new("Segoe UI", 9f);
    private readonly Font titleFont = new("Segoe UI Semibold", 10.5f);
    private bool showingNav;

    internal IReadOnlyList<SettingsGroup> Groups => groups; // tests
    internal TextBox SearchBox => searchBox; // tests
    internal ListView SearchResults => searchResults; // tests
    internal ListView Nav => nav; // tests
    internal FlowLayoutPanel PagePills => pagePills; // tests
    internal string CurrentGroup { get; private set; } = "";

    // The group that was showing, each time another one opens.
    internal event Action<string>? GroupChanged;

    // A few words people search for that no label on the page says.
    private static readonly Dictionary<string, string> PageKeywords = new()
    {
        ["Approvals"] = "permission ask allow deny git github",
        ["Desktop folders"] = "files tidy move rename",
        ["Local-only"] = "offline cloud privacy",
        ["Your data"] = "export delete wipe backup",
        ["Plugins"] = "addon add-on extension",
        ["MCP Clients"] = "mcp servers tools",
        ["Backend"] = "url port server admin token",
        ["Timings"] = "performance perf speed",
        ["Pending edits"] = "proposals approve changes",
        ["Developer"] = "project folder revert pr",
    };

    // What each group is for, under its name in the sidebar and the header.
    private static readonly Dictionary<string, string> GroupDescriptions = new()
    {
        ["general"] = "How Mana starts and looks",
        ["voice"] = "How she listens and answers",
        ["checkins"] = "When she speaks up on her own",
        ["memory"] = "What she knows and how she replies",
        ["models"] = "Which brain she uses, and the cost",
        ["permissions"] = "What she may do without asking",
        ["privacy"] = "What happens to your data",
        ["connections"] = "Accounts, devices and services",
        ["advanced"] = "Backend and diagnostics",
    };

    private void AddGroup(string id, string label, params TabPage[] pages)
    {
        var tabs = new TabControl { Dock = DockStyle.Fill, Visible = false, AccessibleName = label };
        DarkTheme.ApplyTabControl(tabs);
        foreach (var page in pages)
        {
            page.BackColor = DarkTheme.Background;
            page.AutoScroll = true;
            tabs.TabPages.Add(page);
        }
        // The pills under the header pick the page, so the strip folds away.
        tabs.SizeMode = TabSizeMode.Fixed;
        tabs.ItemSize = new Size(0, 1);
        tabs.SelectedIndexChanged += (_, _) => UpdatePills();
        groups.Add(new SettingsGroup(id, label, GroupDescriptions.GetValueOrDefault(id, ""), tabs));
    }

    // #1426: the chat window's sidebar: its glass search field, then the
    // groups as its rows are drawn (a name over a muted line, the open one
    // on a card), under "Settings" and "More" headers.
    private Control BuildSidebar()
    {
        var sidebar = new Panel { Dock = DockStyle.Left, Width = 230, BackColor = DarkTheme.Background, Padding = new Padding(10) };
        searchBox.Dock = DockStyle.Top;
        searchBox.PlaceholderText = "Search settings";
        searchBox.AccessibleName = "Search settings";
        searchBox.BackColor = DarkTheme.IsLight ? Color.White : DarkTheme.Panel2;
        searchBox.ForeColor = DarkTheme.Text;
        searchBox.TextChanged += (_, _) => Search(searchBox.Text);
        searchBox.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Enter && searchResults.Items.Count > 0)
            {
                OpenResult(searchResults.Items[0]);
                e.SuppressKeyPress = true;
            }
            else if (e.KeyCode == Keys.Escape)
            {
                searchBox.Clear();
                e.SuppressKeyPress = true;
            }
        };
        var searchField = GlassSurface.Field(searchBox, new Padding(10, 8, 10, 0));
        searchField.Dock = DockStyle.Top;
        searchField.Height = 32;

        nav.Dock = DockStyle.Fill;
        nav.View = View.Details;
        nav.HeaderStyle = ColumnHeaderStyle.None;
        nav.FullRowSelect = true;
        nav.HideSelection = false;
        nav.MultiSelect = false;
        nav.BorderStyle = BorderStyle.None;
        nav.BackColor = DarkTheme.Background;
        nav.ForeColor = DarkTheme.Text;
        nav.AccessibleName = "Settings groups";
        nav.Columns.Add("Group", 200);
        nav.OwnerDraw = true;
        nav.DrawItem += OnDrawGroupItem;
        nav.ClientSizeChanged += (_, _) => nav.Columns[0].Width = nav.ClientSize.Width;
        navRowHeight.ImageSize = new Size(1, LogicalToDeviceUnits(48));
        nav.SmallImageList = navRowHeight;
        var main = new ListViewGroup("main", "Settings");
        var more = new ListViewGroup("more", "More");
        nav.Groups.Add(main);
        nav.Groups.Add(more);
        foreach (var group in groups)
        {
            nav.Items.Add(new ListViewItem(new[] { group.Label, group.Description }, group.Id == "advanced" ? more : main) { Tag = group.Id });
        }
        nav.SelectedIndexChanged += (_, _) =>
        {
            if (!showingNav && nav.SelectedItems.Count > 0 && nav.SelectedItems[0].Tag is string id)
            {
                ShowGroup(id);
            }
        };

        sidebar.Controls.Add(nav);
        sidebar.Controls.Add(new Panel { Dock = DockStyle.Top, Height = 8, BackColor = Color.Transparent });
        sidebar.Controls.Add(searchField);
        return sidebar;
    }

    // As SessionListForm.OnDrawSessionItem draws a chat: glass card under the
    // open group in the Mana preset, an accent tint elsewhere.
    private void OnDrawGroupItem(object? sender, DrawListViewItemEventArgs e)
    {
        var g = e.Graphics;
        var bounds = e.Bounds with { Width = nav.ClientSize.Width };
        var card = Rectangle.Inflate(bounds, 0, -1);
        var active = (string?)e.Item.Tag == CurrentGroup && !searchResults.Visible;
        if (DarkTheme.IsGlass)
        {
            GlassSurface.PaintGlowBehind(g, nav, bounds);
            if (active)
            {
                using var fill = new SolidBrush(Color.FromArgb(179, 255, 255, 255));
                g.FillRectangle(fill, card);
                GlassSurface.PaintGlassEdges(g, card, null);
            }
        }
        else
        {
            using var back = new SolidBrush(nav.BackColor);
            g.FillRectangle(back, bounds);
            if (active)
            {
                using var tint = new SolidBrush(Color.FromArgb(56, DarkTheme.Accent));
                g.FillRectangle(tint, card);
            }
        }
        var pad = LogicalToDeviceUnits(10);
        var font = active ? activeGroupFont : groupFont;
        var gap = LogicalToDeviceUnits(2);
        var top = card.Y + (card.Height - font.Height - gap - descriptionFont.Height) / 2;
        const TextFormatFlags flags = TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;
        TextRenderer.DrawText(g, e.Item.Text, font, new Rectangle(card.X + pad, top, card.Width - pad * 2, font.Height), active && !DarkTheme.IsGlass ? DarkTheme.Accent : DarkTheme.Text, flags);
        TextRenderer.DrawText(g, e.Item.SubItems[1].Text, descriptionFont, new Rectangle(card.X + pad, top + font.Height + gap, card.Width - pad * 2, descriptionFont.Height), DarkTheme.Muted, flags);
        if (e.Item.Focused && nav.Focused && GlassSurface.ShowsFocusCues(nav))
        {
            ControlPaint.DrawFocusRectangle(g, Rectangle.Inflate(card, -2, -1));
        }
    }

    // #1426: the chat window's 36px header: the group's name in its title
    // font, what it's for beside it, a hairline under.
    private Control BuildHeader()
    {
        var header = new Panel { Dock = DockStyle.Top, Height = 36, BackColor = DarkTheme.Background, Padding = new Padding(12, 4, 12, 4) };
        header.Paint += (_, e) =>
        {
            using var line = new Pen(DarkTheme.IsGlass ? Color.FromArgb(36, 106, 95, 184) : DarkTheme.Border);
            e.Graphics.DrawLine(line, 0, header.Height - 1, header.Width, header.Height - 1);
        };
        titleLabel.Dock = DockStyle.Left;
        titleLabel.AutoSize = true;
        titleLabel.Font = titleFont;
        titleLabel.ForeColor = DarkTheme.Text;
        titleLabel.Padding = new Padding(0, 5, 8, 0);
        descriptionLabel.Dock = DockStyle.Fill;
        descriptionLabel.TextAlign = ContentAlignment.MiddleLeft;
        descriptionLabel.ForeColor = DarkTheme.Muted;
        descriptionLabel.AutoEllipsis = true;
        header.Controls.Add(descriptionLabel);
        header.Controls.Add(titleLabel);

        pagePills.Dock = DockStyle.Top;
        pagePills.AutoSize = true;
        pagePills.WrapContents = true;
        pagePills.Padding = new Padding(10, 8, 10, 2);
        pagePills.BackColor = DarkTheme.Background;
        pagePills.AccessibleName = "Pages";
        return header;
    }

    // One pill per page of the open group; none when it has one page.
    private void UpdatePills()
    {
        var group = groups.Find(g => g.Id == CurrentGroup);
        pagePills.SuspendLayout();
        foreach (Control old in pagePills.Controls.Cast<Control>().ToList())
        {
            old.Dispose();
        }
        if (group is not null && group.Tabs.TabCount > 1 && !searchResults.Visible)
        {
            foreach (TabPage page in group.Tabs.TabPages)
            {
                var on = group.Tabs.SelectedTab == page;
                var pill = new Button
                {
                    Text = page.Text,
                    AutoSize = true,
                    UseMnemonic = false,
                    Margin = new Padding(0, 0, 6, 6),
                    Padding = new Padding(8, 2, 8, 2),
                    AccessibleDescription = on ? "Showing" : null,
                };
                DarkTheme.ApplyButton(pill);
                if (on)
                {
                    pill.ForeColor = DarkTheme.Accent;
                    pill.FlatAppearance.BorderColor = DarkTheme.Accent;
                }
                var target = page;
                pill.Click += (_, _) => group.Tabs.SelectedTab = target;
                pagePills.Controls.Add(pill);
            }
        }
        pagePills.Visible = pagePills.Controls.Count > 0;
        pagePills.ResumeLayout();
    }

    internal void ShowGroup(string id)
    {
        var group = groups.Find(g => g.Id == id) ?? groups[0];
        if (searchBox.Text.Length > 0)
        {
            searchBox.Text = ""; // closes the results
        }
        var previous = CurrentGroup;
        CurrentGroup = group.Id;
        // Showing a group can create the sidebar's handle, which replays its
        // old selection; that isn't a click.
        showingNav = true;
        foreach (var g in groups)
        {
            g.Tabs.Visible = g == group;
        }
        showingNav = false;
        searchResults.Visible = false;
        UpdateNav();
        if (previous != group.Id && previous.Length > 0)
        {
            GroupChanged?.Invoke(previous);
        }
    }

    private void UpdateNav()
    {
        var group = groups.Find(g => g.Id == CurrentGroup);
        titleLabel.Text = searchResults.Visible ? "Search" : group?.Label ?? "";
        descriptionLabel.Text = searchResults.Visible ? "Settings whose words match" : group?.Description ?? "";
        showingNav = true;
        foreach (ListViewItem item in nav.Items)
        {
            item.Selected = (string?)item.Tag == CurrentGroup && !searchResults.Visible;
        }
        showingNav = false;
        nav.Invalidate();
        UpdatePills();
    }

    // Every word a page shows (labels, checkboxes, buttons, box titles,
    // list columns) plus its keywords, matched as you type.
    internal void Search(string query)
    {
        var q = query.Trim();
        searchResults.BeginUpdate();
        searchResults.Items.Clear();
        if (q.Length > 0)
        {
            var seen = new HashSet<string>();
            foreach (var group in groups)
            {
                foreach (TabPage page in group.Tabs.TabPages)
                {
                    var where = group.Tabs.TabCount > 1 ? $"{group.Label} › {page.Text}" : group.Label;
                    foreach (var (text, matches, control) in SearchableTexts(page))
                    {
                        if (matches.Contains(q, StringComparison.OrdinalIgnoreCase) && seen.Add(where + "|" + text))
                        {
                            searchResults.Items.Add(new ListViewItem(new[] { text, where }) { Tag = (group.Id, page, control) });
                        }
                    }
                }
            }
            if (searchResults.Items.Count == 0)
            {
                searchResults.Items.Add(new ListViewItem(new[] { $"Nothing matches \"{q}\". Try a shorter word.", "" }) { ForeColor = DarkTheme.Muted });
            }
        }
        searchResults.EndUpdate();
        // Results take the group's place while there's a search.
        searchResults.Visible = q.Length > 0;
        foreach (var g in groups)
        {
            g.Tabs.Visible = !searchResults.Visible && g.Id == CurrentGroup;
        }
        UpdateNav();
    }

    // What a result shows, what it's matched against, and where it points.
    // A page's keywords match as the page itself.
    private static IEnumerable<(string Text, string Matches, Control Control)> SearchableTexts(TabPage page)
    {
        yield return (page.Text, page.Text + " " + PageKeywords.GetValueOrDefault(page.Text, ""), page);
        foreach (var control in Descendants(page))
        {
            if (control is SettingsRow row)
            {
                yield return (row.Title, row.SearchText, row);
                continue;
            }
            var text = control switch
            {
                Label or CheckBox or RadioButton or Button or GroupBox => control.Text,
                _ => control.AccessibleName,
            };
            if (!string.IsNullOrWhiteSpace(text))
            {
                var shown = text.Trim().ReplaceLineEndings(" ");
                yield return (shown, shown, control);
            }
            if (control is ListView list)
            {
                foreach (ColumnHeader column in list.Columns)
                {
                    yield return (column.Text, column.Text, list);
                }
            }
        }
    }

    private static IEnumerable<Control> Descendants(Control parent)
    {
        foreach (Control child in parent.Controls)
        {
            yield return child;
            if (child is SettingsRow)
            {
                continue; // matched as a whole
            }
            foreach (var grandchild in Descendants(child))
            {
                yield return grandchild;
            }
        }
    }

    // A result opens its group and page and points at the control.
    internal void OpenResult(ListViewItem? item)
    {
        if (item?.Tag is not ValueTuple<string, TabPage, Control> target)
        {
            return;
        }
        var (groupId, page, control) = target;
        ShowGroup(groupId);
        var tabs = groups.Find(g => g.Id == groupId)!.Tabs;
        tabs.SelectedTab = page;
        if (control == page)
        {
            return;
        }
        page.ScrollControlIntoView(control);
        if (control is SettingsRow row)
        {
            row.Flash();
            return;
        }
        if (control.CanFocus)
        {
            control.Focus();
        }
        var fore = control.ForeColor;
        control.ForeColor = DarkTheme.Accent;
        var timer = new System.Windows.Forms.Timer { Interval = 1500 };
        timer.Tick += (_, _) =>
        {
            timer.Dispose();
            if (!control.IsDisposed)
            {
                control.ForeColor = fore;
            }
        };
        timer.Start();
    }

    // #1119: Settings > Presets' active choice, as it's saved, so a
    // non-modal Settings applies it to the next reply.
    public Action<string?>? ActivePresetChanged { get; set; }

    public async Task RefreshAllAsync()
    {
        await RefreshPluginsAsync();
        await RefreshMemoryFactsAsync();
        await RefreshSkillsAsync();
        await RefreshApprovalsAsync();
        await RefreshRememberedAsync();
        await RefreshToolApprovalModeAsync();
        await RefreshGitApprovalModesAsync();
        await RefreshVoiceTabAsync();
        await (refreshSpeechWords?.Invoke() ?? Task.CompletedTask);
        await (refreshBriefing?.Invoke() ?? Task.CompletedTask);
        await (proactive?.ReloadAsync() ?? Task.CompletedTask);
        await (heartbeat?.ReloadAsync() ?? Task.CompletedTask);
        await (relationships?.ReloadAsync() ?? Task.CompletedTask);
        await RefreshPerfTabAsync();
        await RefreshPresetsAsync();
        await RefreshModelTabAsync();
        await RefreshCodingModeAsync();
        await RefreshGroupModeAsync();
        await RefreshLlamaBuildAsync();
        await RefreshMobileDevicesAsync();
        await RefreshAccountsAsync();
        await RefreshMailCalendarAsync();
        await RefreshMcpServersAsync();
        await RefreshHooksAsync();
    }

    // #529 review: a failed load left its list untouched -- on first
    // open that renders as an empty list indistinguishable from "really
    // nothing here" (e.g. the memory-facts endpoint requires an admin
    // token when node-bot has MANA_ADMIN_SECRET configured, which this
    // client doesn't send -- there's no settings UI yet to enter one).
    // One visible placeholder row beats a silent, misleading empty state.
    private static void ShowLoadFailure(ListView list, string message)
    {
        list.Items.Clear();
        list.Items.Add(new ListViewItem($"Failed to load: {message}") { ForeColor = Color.Firebrick });
    }

    // #565: the backend URL and admin token are read straight from
    // ManaSettingsStore rather than threaded in through SessionListForm/
    // SettingsDialog's constructors -- both ManaBackendClient and
    // TrayNotificationClient only read this file once, at app startup,
    // so a change here can't take effect live regardless; reading/writing
    // the same small file directly here is simpler than plumbing a store
    // reference through two more constructors for a value nothing else
    // needs mid-session.
    private TabPage BuildConnectionTab(out TabPage localOnlyPage)
    {
        var settings = ManaSettingsStore.Load();

        var urlLabel = new Label { Text = "Backend URL", AutoSize = true, ForeColor = DarkTheme.Text };
        var urlBox = new TextBox { Text = settings.BackendBaseUrl, Width = 320, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
        var tokenLabel = new Label { Text = "Admin token", AutoSize = true, ForeColor = DarkTheme.Text };
        var tokenHint = new Label { Text = "Only needed when Mana's backend runs separately from this launcher, like on another PC. It's the ADMIN_TOKEN in node-bot/.env.", AutoSize = true, MaximumSize = new Size(420, 0), ForeColor = DarkTheme.Muted };
        var tokenBox = new TextBox { Text = settings.AdminToken ?? "", Width = 320, UseSystemPasswordChar = true, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, BorderStyle = BorderStyle.FixedSingle };
        var statusLabel = new Label { AutoSize = true, ForeColor = DarkTheme.Muted };

        var saveButton = new Button { Text = "Save" };
        DarkTheme.ApplyButton(saveButton);
        saveButton.Click += (_, _) =>
        {
            var url = urlBox.Text.Trim();
            // A malformed value saved here would throw on the *next*
            // launch (ManaBackendClient's constructor does `new Uri(...)`
            // with no try/catch of its own) -- rejecting it here, before
            // it's ever persisted, is cheaper than a crash-on-startup bug
            // report from a single typo.
            if (!Uri.TryCreate(url, UriKind.Absolute, out var parsed) || (parsed.Scheme != "http" && parsed.Scheme != "https"))
            {
                statusLabel.ForeColor = Color.Firebrick;
                statusLabel.Text = "Backend URL must be a valid http:// or https:// address.";
                return;
            }

            // #681: reload rather than save the copy read when this tab was
            // built -- the Presets tab may have changed ActivePresetId since.
            var latest = ManaSettingsStore.Load();
            latest.BackendBaseUrl = url;
            latest.AdminToken = string.IsNullOrWhiteSpace(tokenBox.Text) ? null : tokenBox.Text.Trim();
            latest.Save();
            statusLabel.ForeColor = DarkTheme.Muted;
            statusLabel.Text = "Saved -- restart Mana for this to take effect.";
        };

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            AutoSize = true,
            Padding = new Padding(12),
        };
        layout.Controls.Add(urlLabel);
        layout.Controls.Add(urlBox);
        layout.Controls.Add(tokenLabel);
        layout.Controls.Add(tokenHint);
        layout.Controls.Add(tokenBox);
        layout.Controls.Add(saveButton);
        layout.Controls.Add(statusLabel);
        localOnlyPage = OneRowPage("Local-only", BuildLocalOnlyRow(settings.LocalOnly));
        return new TabPage("Backend") { Controls = { layout } };
    }

    // #1426: a page holding one row that used to sit on another tab.
    private static TabPage OneRowPage(string title, Control row)
    {
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, AutoSize = true, Padding = new Padding(12) };
        layout.Controls.Add(row);
        return new TabPage(title) { Controls = { layout } };
    }

    // #1426: moved here from the tray. Starts or stops the 14B coding
    // engine (#1343); it can't run while a game does.
    private readonly SettingsSwitch codingModeCheck = new() { AccessibleName = "Coding mode" };
    private readonly Label codingModeStatus = SettingsRows.Status();
    private bool loadingCodingMode;


    private async Task RefreshCodingModeAsync()
    {
        try
        {
            var status = await backendClient.GetCodingSessionStatusAsync();
            loadingCodingMode = true;
            codingModeCheck.Checked = status.Active;
            codingModeCheck.Enabled = !status.IsGaming;
            codingModeStatus.Text = status.IsGaming ? $"Locked out while {status.Game ?? "a game"} is running."
                : status.Active ? "On: the 14B engine is loaded." : "Off.";
        }
        catch (Exception ex)
        {
            codingModeStatus.Text = $"Couldn't load: {BackendError.Describe(ex)}";
        }
        finally
        {
            loadingCodingMode = false;
        }
    }

    // #1426: moved here from the tray (#849). The launcher applies it live
    // through DictateAnywhereChanged.
    public Action<bool>? DictateAnywhereChanged { get; set; }


    private readonly SettingsSwitch groupModeCheck = new() { AccessibleName = "Group mode" };
    private readonly ComboBox groupPartnerCombo = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 200, AccessibleName = "Group mode partner" };
    private readonly Label groupModeStatus = new() { AutoSize = true };
    private bool loadingGroupMode;

    internal CheckBox GroupModeCheck => groupModeCheck; // tests
    internal ComboBox GroupPartnerCombo => groupPartnerCombo; // tests
    internal Label GroupModeStatus => groupModeStatus; // tests


    private sealed record GroupPartner(string Id, string Name);

    internal async Task RefreshGroupModeAsync()
    {
        try
        {
            var (active, characters, group) = await backendClient.GetCharactersAsync();
            loadingGroupMode = true;
            groupPartnerCombo.Items.Clear();
            foreach (var (id, name) in characters.Where(c => c.Id != active))
            {
                groupPartnerCombo.Items.Add(new GroupPartner(id, name));
            }
            var partners = groupPartnerCombo.Items.Cast<GroupPartner>().ToList();
            groupPartnerCombo.SelectedItem = partners.FirstOrDefault(p => p.Id == group.Partner) ?? partners.FirstOrDefault();
            groupModeCheck.Checked = group.On;
            groupModeCheck.Enabled = groupPartnerCombo.Enabled = partners.Count > 0;
            var partnerName = (groupPartnerCombo.SelectedItem as GroupPartner)?.Name ?? "her partner";
            groupModeStatus.Text = partners.Count == 0 ? "Add another character in Characters to use group mode."
                : !group.On ? "Off."
                : group.Paused ? $"Paused while a game runs; {partnerName} is back when it ends."
                : $"On: {partnerName} replies too.";
        }
        catch (Exception ex)
        {
            groupModeStatus.Text = $"Couldn't load: {BackendError.Describe(ex)}";
        }
        finally
        {
            loadingGroupMode = false;
        }
    }

    private async Task SaveGroupModeAsync()
    {
        if (loadingGroupMode)
        {
            return;
        }
        try
        {
            await backendClient.SetGroupAsync(groupModeCheck.Checked, (groupPartnerCombo.SelectedItem as GroupPartner)?.Id);
        }
        catch (Exception ex)
        {
            groupModeStatus.Text = $"Couldn't switch it: {BackendError.Describe(ex)}";
            return;
        }
        await RefreshGroupModeAsync();
    }

    // #1426: what Settings asks the launcher to do -- apply the avatar's
    // settings live, revert a merged PR. Set through SessionListForm.
    public Action? AvatarSettingsChanged { get; set; }
    public Action? RevertMergedPr { get; set; }

    private static readonly (string Id, string Label)[] Framings = [("full", "Full body"), ("upperHalf", "Upper half"), ("bust", "Bust")];

    // #1426 stage 2: General as one page of rows -- startup, appearance, the
    // avatar (moved here from the tray), games and hotkeys. Each saves as
    // it's changed, the launcher applies it live, and Undo puts it back.
    private TabPage BuildGeneralPage()
    {
        var saved = ManaSettingsStore.Load();
        void SaveAvatar(Action<ManaSettingsStore> change)
        {
            var latest = ManaSettingsStore.Load();
            change(latest);
            latest.Save();
            AvatarSettingsChanged?.Invoke();
        }

        var presets = DarkTheme.Presets.ToArray();
        void ApplyTheme(string preset, string? accentHex)
        {
            var theme = ManaThemeSettings.Load();
            theme.Preset = preset;
            theme.AccentHex = accentHex;
            theme.Save();
            DarkTheme.ApplyPresetLive(preset, accentHex); // every open window, no restart (#688)
        }
        var themeRow = ChoiceRow("Theme", "Colours for every Mana window", "dark light color colour preset",
            Array.ConvertAll(presets, p => p.Label), Math.Max(0, Array.FindIndex(presets, p => p.Id == ManaThemeSettings.Load().Preset)),
            i => ApplyTheme(presets[i].Id, ManaThemeSettings.Load().AccentHex));

        var accentNow = SettingsRows.Status();
        void ShowAccent() => accentNow.Text = ManaThemeSettings.Load().AccentHex ?? "Theme's own";
        void SetAccent(string? hex)
        {
            var theme = ManaThemeSettings.Load();
            var before = theme.AccentHex;
            if (before == hex)
            {
                return;
            }
            ApplyTheme(theme.Preset, hex);
            ShowAccent();
            Changed(hex is null ? "Accent colour back to the theme's" : $"Accent colour {hex}", () => SetAccent(before));
        }
        ShowAccent();
        var accentRow = new SettingsRow("Accent colour", "Your own highlight colour instead of the theme's", "color accent highlight", accentNow,
            SettingsRows.Action("Pick…", () =>
            {
                using var picker = new ColorDialog { FullOpen = true, Color = DarkTheme.Accent };
                if (picker.ShowDialog(this) == DialogResult.OK)
                {
                    SetAccent($"#{picker.Color.R:x2}{picker.Color.G:x2}{picker.Color.B:x2}");
                }
            }),
            SettingsRows.Action("Default", () => SetAccent(null)));

        gamingModeCheck.Checked = saved.GamingModeDetection;
        var gamingRow = SwitchRow("Gaming mode", "Goes quiet and frees memory while a game is running", "game fullscreen detection", saved.GamingModeDetection, on =>
        {
            var latest = ManaSettingsStore.Load();
            latest.GamingModeDetection = on;
            latest.Save(); // the launcher's 5s poll picks it up
            _ = RefreshPerfTabAsync();
        }, gamingStatusLabel, gamingModeCheck);

        var parts = new List<Control>
        {
            SettingsRows.Section("Startup"),
            BuildStartWithWindowsRow(changed: Changed),
            SettingsRows.Section("Appearance"),
            themeRow,
            accentRow,
            SettingsRows.Section("Avatar"),
            SwitchRow("Hide with the chat window", "She leaves the desktop while the chat window is open", "overlay hide",
                saved.AvatarHidesWithChat, on => SaveAvatar(s => s.AvatarHidesWithChat = on)),
            SwitchRow("Click-through", "The mouse passes through her", "click through overlay mouse",
                saved.AvatarClickThrough, on => SaveAvatar(s => s.AvatarClickThrough = on)),
            ChoiceRow("Framing", "How much of her shows", "body bust upper half crop",
                Array.ConvertAll(Framings, f => f.Label), Array.FindIndex(Framings, f => f.Id == (saved.OverlayFraming ?? "upperHalf")),
                i => SaveAvatar(s => s.OverlayFraming = Framings[i].Id)),
            ChoiceRow("Size", "How big she is on the desktop", "scale zoom bigger smaller",
                Array.ConvertAll(AvatarOverlayForm.OverlayScales, scale => $"{scale * 100:0}%"), Array.IndexOf(AvatarOverlayForm.OverlayScales, saved.OverlayScale ?? 1.5f),
                i => SaveAvatar(s => s.OverlayScale = AvatarOverlayForm.OverlayScales[i])),
            SwitchRow("Captions", "What she says, written under her", "subtitles text",
                saved.CaptionsShown(), on => SaveAvatar(s => s.Captions = on)),
            SwitchRow("Chat bubbles", "Her replies in bubbles beside her", "speech bubble",
                saved.ChatBubbles, on => SaveAvatar(s =>
                {
                    s.Captions ??= s.CaptionsShown(); // keep captions as they're showing now
                    s.ChatBubbles = on;
                })),
            new SettingsRow("VTube Studio", "Drive her model in VTube Studio", "vtube vts live2d model",
                SettingsRows.Action("Open…", () => new VTubeStudioForm(backendClient).Show())),
            SettingsRows.Section("Games"),
            gamingRow,
            SettingsRows.Section("Hotkeys"),
        };
        foreach (var action in HotkeyBindings.Actions)
        {
            parts.Add(BuildHotkeyRow(action));
        }
        parts.Add(SettingsRows.Note("Click a box and press the new keys (Ctrl or Alt plus a key). Backspace turns a hotkey off."));
        return SettingsRows.Page("General", parts.ToArray());
    }

    // A row with a switch that saves on each flip; Undo flips it back.
    private SettingsRow SwitchRow(string name, string explanation, string keywords, bool value, Action<bool> save, Control? status = null, SettingsSwitch? flip = null)
    {
        flip ??= new SettingsSwitch { AccessibleName = name };
        flip.Checked = value;
        var control = flip;
        control.CheckedChanged += (_, _) =>
        {
            if (loadingRows)
            {
                return;
            }
            save(control.Checked);
            Changed($"{name} {(control.Checked ? "on" : "off")}", () => control.Checked = !control.Checked);
        };
        return status is null ? new SettingsRow(name, explanation, keywords, control) : new SettingsRow(name, explanation, keywords, status, control);
    }

    // #1426 stage 2: Memory as one page of rows -- the facts she keeps about
    // you, each character's own notes (#914), group mode, skills, presets
    // and the memory tools. Character cards and "Tell Mana what to remember"
    // come in their own PRs.
    private RelationshipPanel? relationships;

    private TabPage BuildMemoryPage()
    {
        relationships = new RelationshipPanel(backendClient, loadNow: false);
        var parts = new List<Control>
        {
            SettingsRows.Section("What she knows"),
            BuildFactsRow(),
            SettingsRows.Section("Characters"),
        };
        parts.AddRange(relationships.Rows);
        parts.AddRange(BuildGroupModeRows());
        parts.Add(SettingsRows.Section("Skills"));
        parts.AddRange(BuildSkillsRows());
        parts.Add(SettingsRows.Section("Presets"));
        parts.AddRange(BuildPresetsRows());
        parts.Add(SettingsRows.Section("Tools"));
        parts.Add(new SettingsRow("Memory graph", "How what she knows connects", "graph map links",
            SettingsRows.Action("Open…", () => new MemoryGraphForm(backendClient).Show())));
        parts.Add(new SettingsRow("Edit snapshots", "Her edits, kept so you can roll one back", "snapshots undo rollback history",
            SettingsRows.Action("Open…", () => new SnapshotsForm(backendClient).Show())));
        return SettingsRows.Page("Memory", parts.ToArray());
    }

    // #1426: the facts she keeps about you, like Claude's memory tab: a
    // rounded search and pills to filter by state (with counts) over the
    // facts grouped by what they're about, one line each, the picked one's
    // actions as icons at its end. Facts sync both ways with the Obsidian
    // vault (#935), whose state is the quiet line under the list.
    private static readonly (string State, string Label)[] FactFilters = [("active", "Active"), ("pending", "Waiting"), ("archived", "Archived")];
    private string factFilter = "active";
    private readonly List<SettingsPill> factChips = new();
    private readonly LinkLabel openVaultLink = new() { Text = "Open vault", AutoSize = true };
    private readonly VaultDot vaultDot = new();
    private ManaVaultStatus? vault;

    internal RowList FactsList => factsList; // tests
    internal IReadOnlyList<SettingsPill> FactChips => factChips; // tests

    // #1426: node-bot's FACT_CATEGORIES, in the order the list shows them.
    internal static readonly (string Id, string Label)[] FactCategories =
        [("about-you", "About you"), ("projects", "Projects"), ("hobbies", "Games and hobbies"), ("people", "People"), ("other", "Other")];

    internal static string FactState(ManaMemoryFact fact) => fact.Status is "pending" or "archived" ? fact.Status : "active";

    // "Today", "3 Oct", or "3 Oct 2025" from another year.
    internal static string UpdatedText(string? iso, DateTimeOffset now)
    {
        if (!DateTimeOffset.TryParse(iso, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var at))
        {
            return "";
        }
        var local = at.ToOffset(now.Offset);
        return local.Date == now.Date ? "Today" : local.Year == now.Year ? local.ToString("d MMM", System.Globalization.CultureInfo.InvariantCulture) : local.ToString("d MMM yyyy", System.Globalization.CultureInfo.InvariantCulture);
    }

    // The vault line: whether the sync works and when it last ran.
    internal static string VaultLine(ManaVaultStatus status, DateTimeOffset now) =>
        status.VaultDir is null ? "Obsidian sync is off"
        : status.Error is not null ? "Obsidian · sync failed"
        : status.LastSyncAt is { } at ? $"Obsidian · synced {Ago(now - at)}"
        : "Obsidian · not synced yet";

    private static string Ago(TimeSpan span) =>
        span.TotalMinutes < 1 ? "just now"
        : span.TotalHours < 1 ? $"{(int)span.TotalMinutes} min ago"
        : span.TotalDays < 1 ? $"{(int)span.TotalHours} h ago"
        : $"{(int)span.TotalDays} d ago";

    private SettingsRow BuildFactsRow()
    {
        factsList.Height = 230; // about seven facts and their groups; the list scrolls, the page doesn't grow
        factsList.ActionsFor = FactActionsFor;
        factsList.ItemActivate += async (_, _) =>
        {
            if (SelectedFact is { } fact && FactState(fact) != "archived")
            {
                await EditSelectedFactAsync();
            }
        };

        StyleSearchBox(factsSearch);
        factsSearch.Dock = DockStyle.Fill;
        factsSearch.PlaceholderText = "Search facts";
        factsSearch.TextChanged += (_, _) => ShowFacts();
        var search = SettingsRows.RoundField(factsSearch, 200);
        var top = SettingsRows.Line(search);
        top.Margin = Padding.Empty;
        foreach (var (state, label) in FactFilters)
        {
            var chip = new SettingsPill { Text = label, Tag = (state, label), Checked = state == factFilter, Margin = new Padding(6, 0, 0, 0) };
            chip.CheckedChanged += (_, _) =>
            {
                if (chip.Checked)
                {
                    factFilter = state;
                    ShowFacts();
                }
            };
            factChips.Add(chip);
            top.Controls.Add(chip);
        }
        var add = SettingsRows.Action("+ Add", () => _ = AddFactAsync());
        SettingsRows.MakePrimary(add);
        add.Margin = new Padding(10, 0, 0, 0);
        top.Controls.Add(add);

        // #935: the vault's state, opening it, and a sync right now.
        LinkLabel Link(LinkLabel link)
        {
            link.LinkColor = link.ActiveLinkColor = DarkTheme.Accent;
            link.DisabledLinkColor = DarkTheme.Muted;
            link.LinkBehavior = LinkBehavior.HoverUnderline;
            link.BackColor = Color.Transparent;
            link.Margin = new Padding(6, 1, 0, 0);
            link.Enabled = false;
            return link;
        }
        Link(openVaultLink).LinkClicked += (_, _) =>
        {
            if (vault?.VaultDir is not { } dir)
            {
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo($"obsidian://open?path={Uri.EscapeDataString(dir)}") { UseShellExecute = true });
            }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
            {
                vaultStatusLabel.Text = $"Couldn't open Obsidian: {ex.Message}";
            }
        };
        Link(vaultSyncButton).LinkClicked += async (_, _) =>
        {
            vaultSyncButton.Enabled = false;
            try
            {
                ShowVaultStatus(await backendClient.SyncMemoryVaultAsync());
                await RefreshMemoryFactsAsync();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"SettingsPanel: vault sync failed. {ex.Message}");
                if (!IsDisposed)
                {
                    vaultStatusLabel.Text = $"Obsidian · sync failed: {BackendError.Describe(ex)}";
                    vaultSyncButton.Enabled = true;
                }
            }
        };
        vaultStatusLabel.BackColor = Color.Transparent;
        vaultStatusLabel.MaximumSize = new Size(420, 0);
        vaultStatusLabel.Margin = new Padding(2, 1, 0, 0);
        var listPanel = SettingsRows.RoundPanel(factsList);
        return new SettingsRow("Facts about you", "Shared by every character. Pinned ones go into every reply", "memory remember knowledge facts obsidian vault pin",
            below: true, top, listPanel, SettingsRows.Line(vaultDot, vaultStatusLabel, openVaultLink, vaultSyncButton));
    }

    private ManaMemoryFact? SelectedFact => factsList.SelectedItems.Count > 0 ? factsList.SelectedItems[0].Tag as ManaMemoryFact : null;

    // What can be done with a fact, by its state: the icons on its row and
    // its right-click menu.
    private IReadOnlyList<RowList.RowAction> FactActionsFor(object value)
    {
        if (value is not ManaMemoryFact fact)
        {
            return [];
        }
        RowList.RowAction Act(string glyph, string name, Func<Task> run) => new(glyph, name, run);
        var move = Act("", "Move to…", () => ShowMoveMenu(fact));
        return FactState(fact) switch
        {
            "pending" => [Act("", "Confirm", ConfirmSelectedFactAsync), Act("", "Edit", EditSelectedFactAsync), move, Act("", "Not true", DeleteSelectedFactAsync)],
            "archived" => [Act("", "Restore", RestoreSelectedFactAsync), Act("", "Delete", DeleteSelectedFactAsync)],
            _ => new[]
            {
                Act("", "Edit", EditSelectedFactAsync),
                Act(fact.Pinned ? "" : "", fact.Pinned ? "Unpin" : "Pin", TogglePinSelectedFactAsync),
                fact.Trigger == "" ? null : Act(fact.Paused ? "" : "", fact.Paused ? "Resume reminder" : "Pause reminder", TogglePauseSelectedFactAsync),
                move,
                Act("", "Archive", ArchiveSelectedFactAsync),
                Act("", "Delete", DeleteSelectedFactAsync),
            }.OfType<RowList.RowAction>().ToArray(),
        };
    }

    // #1426: moves the fact to another group, picked from a menu at the pointer.
    private Task ShowMoveMenu(ManaMemoryFact fact)
    {
        var menu = new ContextMenuStrip();
        foreach (var (id, label) in FactCategories)
        {
            var item = new ToolStripMenuItem(label) { Checked = id == fact.Category };
            item.Click += async (_, _) => await MoveFactAsync(fact, id);
            menu.Items.Add(item);
        }
        menu.Closed += (_, _) => BeginInvoke(menu.Dispose);
        menu.Show(Cursor.Position);
        return Task.CompletedTask;
    }

    internal async Task MoveFactAsync(ManaMemoryFact fact, string category)
    {
        if (category == fact.Category)
        {
            return;
        }
        try
        {
            await backendClient.SetMemoryFactCategoryAsync(fact.Key, category);
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                vaultStatusLabel.Text = $"Couldn't move \"{fact.Key}\": {BackendError.Describe(ex)}";
            }
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    private async Task RestoreSelectedFactAsync()
    {
        if (SelectedFact is not { } fact)
        {
            return;
        }
        try
        {
            await backendClient.RestoreMemoryFactAsync(fact.Key);
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                vaultStatusLabel.Text = $"Couldn't restore \"{fact.Key}\": {BackendError.Describe(ex)}";
            }
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    // #1426: group mode (#914) moved here from the tray: a second character
    // replies alongside the active one, and her avatar stands beside Mana's.
    private Control[] BuildGroupModeRows()
    {
        groupModeStatus.ForeColor = DarkTheme.Muted;
        groupModeStatus.BackColor = Color.Transparent;
        groupModeStatus.MaximumSize = new Size(260, 0);
        groupPartnerCombo.BackColor = DarkTheme.Panel;
        groupPartnerCombo.ForeColor = DarkTheme.Text;
        groupPartnerCombo.DisplayMember = nameof(GroupPartner.Name);
        groupModeCheck.CheckedChanged += async (_, _) => await SaveGroupModeAsync();
        groupPartnerCombo.SelectedIndexChanged += async (_, _) =>
        {
            if (groupModeCheck.Checked)
            {
                await SaveGroupModeAsync();
            }
        };
        return new Control[]
        {
            new SettingsRow("Group mode", "On casual chat a second character adds a short reply in her own voice. It pauses while a game runs", "group partner duo evil mana second character",
                groupModeStatus, groupModeCheck),
            new SettingsRow("Partner", "Who replies alongside her", "group partner", groupPartnerCombo),
        };
    }

    private Control[] BuildSkillsRows()
    {
        skillsList.Height = 170;
        skillsList.ActionsFor = _ =>
        [
            new("\uE70F", "Edit", EditSelectedSkillAsync),
            new("\uE74D", "Delete", DeleteSelectedSkillAsync),
        ];
        skillsList.ItemActivate += async (_, _) => await EditSelectedSkillAsync();
        return new Control[]
        {
            new SettingsRow("Her skills", "Know-how every character shares. One you write is approved at once unless it looks risky", "skills know-how abilities",
                below: true, SettingsRows.RoundPanel(skillsList), SettingsRows.Line(
                    SettingsRows.Action("New…", () => _ = CreateSkillAsync()),
                    SettingsRows.Action("Import folder…", () => _ = ImportSkillFolderAsync()),
                    SettingsRows.Action("Import zip…", () => _ = ImportSkillZipAsync()),
                    SettingsRows.Action("Import link…", () => _ = ImportSkillLinkAsync()))),
            // Q20: how Mana may use imported skills (default: ask the first time).
            ChoiceRow("Imported skills", "How she may use a skill you import", "import skill openclaw agentskills",
                new[] { "Use freely", "Ask each time", "Ask the first time" }, 2, i => _ = SaveImportedSkillUseAsync(i), importedSkillUseBox),
        };
    }

    private async Task SaveImportedSkillUseAsync(int index)
    {
        try
        {
            await backendClient.SetImportedSkillUseAsync(ImportedSkillUseModes[index]);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to save the imported-skills setting. {ex.Message}");
        }
    }

    // #573: full CRUD -- New and Edit share PresetDialog, Edit pre-filled
    // from the item's ManaPreset (its Tag). #681: the active one reaches
    // every reply.
    private Control[] BuildPresetsRows()
    {
        presetsList.Height = 110;
        presetsList.ActionsFor = _ =>
        [
            new("\uE70F", "Edit", EditSelectedPresetAsync),
            new("\uE74D", "Delete", DeleteSelectedPresetAsync),
        ];
        presetsList.ItemActivate += async (_, _) => await EditSelectedPresetAsync();

        activePresetCombo.BackColor = DarkTheme.Panel;
        activePresetCombo.ForeColor = DarkTheme.Text;
        activePresetCombo.AccessibleName = "Active preset";
        activePresetCombo.SelectedIndexChanged += (_, _) =>
        {
            if (!populatingPresets)
            {
                SaveActivePresetId((activePresetCombo.SelectedItem as ManaPreset)?.Id);
            }
        };
        return new Control[]
        {
            new SettingsRow("Active preset", "Extra instructions added to every reply", "preset style persona instructions", activePresetCombo),
            new SettingsRow("Presets", "Sets of instructions you can switch between", "presets instructions",
                below: true, SettingsRows.RoundPanel(presetsList), SettingsRows.Line(
                    SettingsRows.Action("New…", () => _ = CreatePresetAsync()))),
        };
    }

    // A row with a dropdown that saves on each pick; Undo picks the one before.
    // combo: one the page keeps to show a fresh load in (inside loadingRows).
    private SettingsRow ChoiceRow(string name, string explanation, string keywords, string[] options, int index, Action<int> save, ComboBox? combo = null, Control? status = null)
    {
        var box = SettingsRows.Choice(name, options, index, combo);
        var previous = box.SelectedIndex;
        box.SelectedIndexChanged += (_, _) =>
        {
            var before = previous;
            previous = box.SelectedIndex;
            if (loadingRows || before == box.SelectedIndex)
            {
                return;
            }
            save(box.SelectedIndex);
            Changed($"{name} {box.Text}", () => box.SelectedIndex = before);
        };
        return status is null ? new SettingsRow(name, explanation, keywords, box) : new SettingsRow(name, explanation, keywords, status, box);
    }

    private bool loadingRows; // showing what the backend has, not a change

    // #1426 stage 2: Voice as one page of rows. The microphone's settings
    // are read each time listening starts; the vocabulary applies to the
    // next thing you say. Camera and voice clips sit here until the
    // Permissions and Privacy groups are redrawn.
    private TabPage BuildVoicePage()
    {
        var saved = ManaSettingsStore.Load();
        var inv = System.Globalization.CultureInfo.InvariantCulture;
        void Save(Action<ManaSettingsStore> change)
        {
            var latest = ManaSettingsStore.Load();
            change(latest);
            latest.Save();
        }

        var parts = new List<Control>
        {
            SettingsRows.Note("Changes here apply the next time listening starts."),
            SettingsRows.Section("Microphone"),
            SwitchRow("Echo cancellation", "Stops her hearing herself through your speakers", "aec feedback speakers",
                saved.EchoCancellation ?? true, on => Save(s => s.EchoCancellation = on), EnvironmentWins("MANA_VOICE_AEC")),
            SettingsRows.Section("Listening"),
            ChoiceRow("Wake-word filter", "Ignores speech that doesn't sound like her name. Applies next launch", "wake word hotword prefilter",
                new[] { "Off", "Loose", "Normal" }, Math.Max(0, Array.IndexOf(WakePrefilterModes, saved.WakePrefilter)),
                i => Save(s => s.WakePrefilter = i == 0 ? null : WakePrefilterModes[i]), status: EnvironmentWins("MANA_WAKE_PREFILTER")),
            SliderRow("Speech detection", "What counts as you talking", "threshold vad sensitivity noise",
                0.05, 0.95, 0.05, SileroVadRunner.ResolveThreshold(null, saved.VadThreshold), SileroVadRunner.ResolveThreshold(null, null),
                "Hears whispers", "Ignores noise", v => v.ToString("0.00", inv), v => Save(s => s.VadThreshold = (float)v), EnvironmentWins("MANA_VAD_THRESHOLD")),
            SwitchRow("Dictate anywhere", "Hold Right Ctrl and speak to type into any app", "dictation dictate type right ctrl",
                saved.DictateAnywhere, on =>
                {
                    Save(s => s.DictateAnywhere = on);
                    DictateAnywhereChanged?.Invoke(on);
                }),
            SettingsRows.Section("Answering"),
            SliderRow("Pause before answering", "How long she waits after you stop talking", "silence delay timeout end of turn",
                0.3, 10, 0.1, RecordingSegmenter.ResolveSilenceBufferMs(null, saved.SilenceBufferMs) / 1000.0, RecordingSegmenter.ResolveSilenceBufferMs(null, null) / 1000.0,
                "Answers quickly", "Waits for you", v => v.ToString("0.0 s", inv), v => Save(s => s.SilenceBufferMs = (long)Math.Round(v * 1000)), EnvironmentWins("MANA_SILENCE_BUFFER_MS")),
            ChoiceRow("Talking over Mana", "Whether she stops when you start speaking", "interrupt barge in",
                new[] { "After two words", "Straight away", "Never, she finishes first" }, (int)BargeInPolicy.Resolve(null, saved.BargeInMode),
                i => Save(s => s.BargeInMode = i == 0 ? null : BargeInModes[i]), status: EnvironmentWins("MANA_BARGE_IN_MODE")),
            ChoiceRow("Voice engine", "Which voice she speaks with", "tts text to speech fish kokoro sovits",
                TtsProviderLabels, 0, i => _ = SaveVoiceProviderAsync(i), voiceProviderCombo),
            SettingsRows.Section("Your voice"),
            ChoiceRow("Only your voice can", "Other people's speech is ignored for these", "voiceprint speaker gate only me",
                new[] { "Nothing, anyone can", "Wake her", "Wake her or talk over her", "Wake her, talk over her or give commands" },
                (int)SpeakerGate.ResolveMode(null, saved.VoiceprintGate),
                i => Save(s => s.VoiceprintGate = i == 0 ? null : SpeakerGate.ModeNames[i]), status: EnvironmentWins("MANA_SPEAKER_GATE")),
            BuildVoiceprintRow(),
            BuildVoiceMatchRow(saved),
            SettingsRows.Section("Vocabulary"),
        };
        parts.AddRange(BuildSpeechWordsRows());
        parts.Add(SettingsRows.Section("Camera"));
        parts.Add(SwitchRow("Camera snapshots", "She can take a photo when you ask her to look at something", "camera webcam photo look",
            saved.CameraSnapshots, on => Save(s => s.CameraSnapshots = on)));
        parts.Add(BuildSnapshotFolderRow());
        parts.Add(SettingsRows.Section("Voice clips"));
        parts.AddRange(BuildVoiceClipsRows());
        parts.Add(SettingsRows.Section("Troubleshooting"));
        parts.Add(BuildSpeechLogRow());
        return SettingsRows.Page("Voice", parts.ToArray());
    }

    // What a row says when Mana's environment sets the value instead.
    private static Label? EnvironmentWins(string name)
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(name)))
        {
            return null;
        }
        var status = SettingsRows.Status();
        status.Text = "Set in Mana's environment, which wins";
        return status;
    }

    // #965: how close to my voiceprint speech has to be (SpeakerGate), with
    // the recent match scores beside it to pick it by, re-read each second
    // while the page shows.
    private SettingsRow BuildVoiceMatchRow(ManaSettingsStore saved)
    {
        var recent = SettingsRows.Status();
        recent.Text = SpeakerScoresText();
        logRefreshTimer.Tick += (_, _) =>
        {
            if (recent.Visible)
            {
                recent.Text = SpeakerScoresText();
            }
        };
        return SliderRow("Voice match", "How close to your voice speech has to be", "speaker threshold voiceprint",
            0.10, 0.90, 0.01, SpeakerGate.ResolveThreshold(null, saved.SpeakerThreshold), SpeakerGate.ResolveThreshold(null),
            "Anyone close", "Only you", v => v.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture),
            v =>
            {
                var latest = ManaSettingsStore.Load();
                latest.SpeakerThreshold = (float)v;
                latest.Save();
            }, EnvironmentWins("MANA_SPEAKER_THRESHOLD") ?? recent);
    }

    internal static string SpeakerScoresText(string? logPath = null)
    {
        var scores = VoiceDebugLog.RecentSpeakerScores(path: logPath);
        return scores.Count == 0 ? "" : $"Recent: {string.Join(", ", scores.Select(s => s.ToString("F2", System.Globalization.CultureInfo.InvariantCulture)))}";
    }

    // #962: where "save that" puts a snapshot; blank = Pictures\Mana.
    private static SettingsRow BuildSnapshotFolderRow()
    {
        var folder = new TextBox
        {
            Width = 200,
            PlaceholderText = @"Pictures\Mana",
            Text = ManaSettingsStore.Load().CameraSnapshotFolder ?? "",
            BackColor = DarkTheme.Panel,
            ForeColor = DarkTheme.Text,
            AccessibleName = "Snapshot folder",
        };
        folder.TextChanged += (_, _) =>
        {
            var latest = ManaSettingsStore.Load();
            latest.CameraSnapshotFolder = string.IsNullOrWhiteSpace(folder.Text) ? null : folder.Text.Trim();
            latest.Save();
        };
        var browse = SettingsRows.Action("Browse…", () =>
        {
            using var dialog = new FolderBrowserDialog { Description = "Where Mana saves snapshots you ask her to keep", UseDescriptionForTitle = true };
            if (dialog.ShowDialog() == DialogResult.OK)
            {
                folder.Text = dialog.SelectedPath;
            }
        });
        return new SettingsRow("Snapshot folder", "Where photos you ask her to keep are saved", "camera folder save pictures", folder, browse);
    }

    // #682: what the wake-word filter and voice match decided, for fixing problems.
    private static SettingsRow BuildSpeechLogRow()
    {
        var status = SettingsRows.Status();
        var open = SettingsRows.Action("Open", () =>
        {
            if (!File.Exists(VoiceDebugLog.DefaultPath))
            {
                status.Text = "No speech log yet. It's only written while speech debugging is on.";
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo(VoiceDebugLog.DefaultPath) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                status.Text = $"Couldn't open it: {ex.Message}";
            }
        });
        return new SettingsRow("Speech log", "What she heard and decided, for fixing problems", "debug log speech", status, open);
    }

    // A row with a slider: plain words at each end, the value in real units,
    // and Default. Saves as it moves; one drag or key press is one Undo.
    internal SettingsRow SliderRow(string name, string explanation, string keywords, double min, double max, double step, double value, double fallback,
        string low, string high, Func<double, string> format, Action<double> save, Control? status = null)
    {
        int Ticks(double v) => (int)Math.Round((Math.Clamp(v, min, max) - min) / step);
        double ValueAt(int ticks) => Math.Round(min + (ticks * step), 6);
        var slider = new TrackBar
        {
            Minimum = 0,
            Maximum = Ticks(max),
            Value = Ticks(value),
            TickStyle = TickStyle.None,
            AutoSize = false,
            Size = new Size(150, 26),
            SmallChange = 1,
            LargeChange = Math.Max(1, Ticks(max) / 10),
            BackColor = DarkTheme.Panel2,
            AccessibleName = name,
        };
        Label Words(string text, Color color) => new() { Text = text, AutoSize = true, ForeColor = color, BackColor = Color.Transparent, Anchor = AnchorStyles.Left, UseMnemonic = false };
        var shown = Words(format(ValueAt(slider.Value)), DarkTheme.Text);
        shown.MinimumSize = new Size(44, 0);
        var committed = slider.Value;
        slider.ValueChanged += (_, _) =>
        {
            shown.Text = format(ValueAt(slider.Value));
            save(ValueAt(slider.Value));
        };
        void Commit()
        {
            if (slider.Value == committed)
            {
                return;
            }
            var before = committed;
            committed = slider.Value;
            Changed($"{name} {shown.Text}", () =>
            {
                slider.Value = before;
                committed = before;
            });
        }
        slider.MouseUp += (_, _) => Commit();
        slider.KeyUp += (_, _) => Commit();
        // The wheel scrolls the page, not the slider under the pointer.
        slider.MouseWheel += (_, e) => ((HandledMouseEventArgs)e).Handled = true;
        var reset = SettingsRows.Action("Default", () =>
        {
            slider.Value = Ticks(fallback);
            Commit();
        });
        var controls = new List<Control>();
        if (status is not null)
        {
            controls.Add(status);
        }
        controls.AddRange(new Control[] { Words(low, DarkTheme.Muted), slider, Words(high, DarkTheme.Muted), shown, reset });
        return new SettingsRow(name, explanation, keywords, controls.ToArray());
    }


    // #1426: changes save as they're made. The bar under the page says what
    // was saved and offers Undo until the next change; Ctrl+Z steps back
    // through every change since Settings opened.
    private readonly List<(string What, Action Undo)> changes = new();
    private bool undoing;
    private readonly Panel undoBar = new() { Dock = DockStyle.Bottom, Height = 30, Visible = false, Padding = new Padding(14, 0, 14, 0) };
    private readonly Label undoText = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true, UseMnemonic = false };
    private readonly LinkLabel undoLink = new() { Text = "Undo", Dock = DockStyle.Right, AutoSize = true, TextAlign = ContentAlignment.MiddleRight, Padding = new Padding(0, 7, 6, 0) };
    private readonly Label undoHint = new() { Text = "Ctrl+Z", Dock = DockStyle.Right, AutoSize = true, Padding = new Padding(0, 8, 0, 0) };

    internal Label UndoText => undoText; // tests

    private Control BuildUndoBar()
    {
        undoBar.BackColor = DarkTheme.Panel;
        undoText.ForeColor = DarkTheme.Text;
        undoHint.ForeColor = DarkTheme.Muted;
        undoLink.LinkColor = undoLink.ActiveLinkColor = DarkTheme.Accent;
        undoLink.LinkBehavior = LinkBehavior.HoverUnderline;
        undoLink.AccessibleName = "Undo the last change";
        undoLink.LinkClicked += (_, _) => Undo();
        undoBar.Paint += (_, e) =>
        {
            using var line = new Pen(DarkTheme.Border);
            e.Graphics.DrawLine(line, 0, 0, undoBar.Width, 0);
        };
        undoBar.Controls.Add(undoText);
        undoBar.Controls.Add(undoLink);
        undoBar.Controls.Add(undoHint);
        return undoBar;
    }

    internal void Changed(string what, Action undo)
    {
        if (undoing)
        {
            return;
        }
        changes.Add((what, undo));
        ShowUndo($"Saved · {what}");
    }

    internal void Undo()
    {
        if (changes.Count == 0)
        {
            return;
        }
        var (what, undo) = changes[^1];
        changes.RemoveAt(changes.Count - 1);
        undoing = true;
        try
        {
            undo();
        }
        finally
        {
            undoing = false;
        }
        ShowUndo(changes.Count > 0 ? $"Undone: {what}" : $"Undone: {what}. Nothing else to undo.");
    }

    private void ShowUndo(string text)
    {
        undoText.Text = text;
        undoLink.Visible = undoHint.Visible = changes.Count > 0;
        undoBar.Visible = true;
    }

    // Ctrl+Z anywhere in Settings but a text box, which keeps its own undo
    // (and the hotkey boxes, where it's a combination to bind).
    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == (Keys.Control | Keys.Z) && ActiveControl is not TextBoxBase && changes.Count > 0)
        {
            Undo();
            return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    // #1426: a page of buttons that open a window -- what the tray's Tools
    // used to hold, each beside the settings it belongs with.
    private static TabPage ButtonsPage(string title, string hint, params (string Text, Action Click)[] buttons)
    {
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, AutoSize = true, Padding = new Padding(12) };
        layout.Controls.Add(new Label { Text = hint, AutoSize = true, MaximumSize = new Size(460, 0), ForeColor = DarkTheme.Muted, Margin = new Padding(3, 0, 3, 8) });
        var row = new FlowLayoutPanel { AutoSize = true, BackColor = DarkTheme.Background };
        foreach (var (text, click) in buttons)
        {
            var button = new Button { Text = text, AutoSize = true, UseMnemonic = false };
            DarkTheme.ApplyButton(button);
            button.Click += (_, _) => click();
            row.Controls.Add(button);
        }
        layout.Controls.Add(row);
        return new TabPage(title) { Controls = { layout } };
    }

    private TabPage BuildPendingEditsTab() => ButtonsPage("Pending edits",
        "Changes she has proposed, waiting for your OK. The chat window opens this when one arrives.",
        ("Review pending edits…", () => new ProposalsForm(backendClient).Show()));

    private TabPage BuildDeveloperTab() => ButtonsPage("Developer",
        "For working on Mana herself.",
        ("Open project folder", () => Process.Start(new ProcessStartInfo { FileName = ManaApplicationContext.FindRootDirectory(), UseShellExecute = true })),
        ("Revert a merged PR…", () => RevertMergedPr?.Invoke()));

    // Saved at once, straight to the Run key (StartWithWindows).
    internal static SettingsRow BuildStartWithWindowsRow(string runKeyPath = StartWithWindows.RunKeyPath, Action<string, Action>? changed = null)
    {
        var flip = new SettingsSwitch { Checked = StartWithWindows.IsOn(runKeyPath), AccessibleName = "Start with Windows" };
        var status = SettingsRows.Status();
        flip.CheckedChanged += (_, _) =>
        {
            try
            {
                StartWithWindows.Set(flip.Checked, StartWithWindows.LauncherExe, runKeyPath);
                status.Text = "";
                changed?.Invoke($"Start with Windows {(flip.Checked ? "on" : "off")}", () => flip.Checked = !flip.Checked);
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException)
            {
                status.Text = $"Couldn't change it: {ex.Message}";
            }
        };
        return new SettingsRow("Start with Windows", "Mana opens in the tray when you sign in", "login boot startup sign in", status, flip);
    }

    // #670: saved at once like the Voice tab's checkboxes; the backend
    // reads it when the launcher next starts it.
    private static FlowLayoutPanel BuildLocalOnlyRow(bool localOnly)
    {
        var check = new CheckBox
        {
            Text = "Local-only mode (nothing leaves this PC and your local network)",
            AutoSize = true,
            ForeColor = DarkTheme.Text,
            Checked = localOnly,
        };
        var status = new Label { AutoSize = true, ForeColor = DarkTheme.Muted, Anchor = AnchorStyles.Left };
        check.CheckedChanged += (_, _) =>
        {
            var latest = ManaSettingsStore.Load();
            latest.LocalOnly = check.Checked;
            latest.Save();
            status.Text = "Saved -- restart Mana for this to take effect. MANA_LOCAL_ONLY=1 in node-bot/.env keeps it on.";
        };

        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        row.Controls.Add(check);
        row.Controls.Add(status);
        return row;
    }

    private TabPage BuildPluginsTab()
    {
        pluginsList.Dock = DockStyle.Fill;
        pluginsList.View = View.Details;
        pluginsList.CheckBoxes = true;
        pluginsList.FullRowSelect = true;
        pluginsList.Columns.Add("Plugin", 220);
        pluginsList.Columns.Add("Description", 300);
        pluginsList.ItemChecked += OnPluginChecked;
        DarkTheme.ApplyListView(pluginsList);

        // #688: search, and "+ Add" -> the guide listing plugins and how to
        // add one (no installer, same as Electron).
        StyleSearchBox(pluginsSearch);
        pluginsSearch.TextChanged += (_, _) => ShowPlugins();
        var addButton = new Button { Text = "+ Add", Dock = DockStyle.Right, Width = 70 };
        DarkTheme.ApplyButton(addButton);
        addButton.Click += (_, _) => OpenPluginGuide();
        var searchRow = new Panel { Dock = DockStyle.Top, Height = 26, BackColor = DarkTheme.Background };
        searchRow.Controls.Add(pluginsSearch);
        searchRow.Controls.Add(addButton);

        var page = new TabPage("Plugins");
        page.Controls.Add(pluginsList);
        page.Controls.Add(searchRow);
        return page;
    }

    private static void StyleSearchBox(TextBox box)
    {
        box.BorderStyle = BorderStyle.FixedSingle;
        box.BackColor = DarkTheme.Panel2;
        box.ForeColor = DarkTheme.Text;
    }

    // #688: case-insensitive match of the search text in any field; blank matches all.
    internal static bool MatchesSearch(string query, params string?[] fields) =>
        string.IsNullOrWhiteSpace(query) || fields.Any(f => f?.Contains(query.Trim(), StringComparison.OrdinalIgnoreCase) == true);

    private void OpenPluginGuide() => OpenRepoDoc("plugins", "README.md");

    // #1127: a Mana doc (a path under the repo), drawn by Folio in the chat
    // window's tool panel -- or its own window when nothing set OpenDoc.
    public Action<string>? OpenDoc { get; set; }

    private void OpenRepoDoc(params string[] parts)
    {
        var root = ManaApplicationContext.FindRootDirectory();
        var doc = Path.Combine([root, .. parts]);
        if (OpenDoc is { } open)
        {
            open(doc);
        }
        else
        {
            DocsPanel.OpenWindow(root, doc);
        }
    }

    private async void OnPluginChecked(object? sender, ItemCheckedEventArgs e)
    {
        // Suppressed while RefreshPluginsAsync is setting each item's
        // initial Checked state from the server's own value -- without
        // this, populating the list would fire one spurious
        // SetPluginEnabledAsync call per plugin, re-sending the value
        // that was just read.
        if (populatingPlugins)
        {
            return;
        }
        var key = (string)e.Item.Tag!;
        try
        {
            await backendClient.SetPluginEnabledAsync(key, e.Item.Checked);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to toggle plugin '{key}'. {ex.Message}");
        }
    }

    private async Task RefreshPluginsAsync()
    {
        try
        {
            plugins = await backendClient.GetPluginsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load plugins. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(pluginsList, BackendError.Describe(ex));
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        ShowPlugins();
    }

    private void ShowPlugins()
    {
        populatingPlugins = true;
        try
        {
            pluginsList.Items.Clear();
            foreach (var plugin in plugins.Where(p => MatchesSearch(pluginsSearch.Text, p.Name, p.Description, p.Key)))
            {
                var item = new ListViewItem(plugin.Name) { Tag = plugin.Key, Checked = plugin.Enabled };
                item.SubItems.Add(plugin.Description ?? "");
                pluginsList.Items.Add(item);
            }
        }
        finally
        {
            populatingPlugins = false;
        }
    }


    private async Task TogglePinSelectedFactAsync()
    {
        // The "Failed to load" row has no fact behind it.
        if (factsList.SelectedItems.Count == 0 || factsList.SelectedItems[0].Tag is not ManaMemoryFact fact)
        {
            return;
        }
        try
        {
            await backendClient.SetMemoryFactPinnedAsync(fact.Key, !fact.Pinned);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to pin fact '{fact.Key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    // #1331: type a fact in yourself; a reminder also gets a "when" part.
    private async Task AddFactAsync()
    {
        using var keyDialog = new TextPromptDialog("Add fact", "Name (a short key, e.g. favorite-color):", "");
        if (keyDialog.ShowDialog(this) != DialogResult.OK || keyDialog.Value.Trim() == "")
        {
            return;
        }
        using var textDialog = new TextPromptDialog("Add fact", "Fact:", "");
        if (textDialog.ShowDialog(this) != DialogResult.OK || textDialog.Value.Trim() == "")
        {
            return;
        }
        using var whenDialog = new TextPromptDialog("Add fact", "Optional -- only bring it up when this comes up:", "");
        if (whenDialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }
        try
        {
            await backendClient.CreateMemoryFactAsync(keyDialog.Value.Trim(), textDialog.Value.Trim(), whenDialog.Value.Trim());
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to add fact '{keyDialog.Value.Trim()}'. {ex.Message}");
            if (!IsDisposed)
            {
                MessageBox.Show(this, $"Couldn't add that fact (is the name already used?): {ex.Message}", "Add Fact", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    // #1331: asks once, then really removes the fact (Archive keeps it).
    private async Task DeleteSelectedFactAsync()
    {
        if (factsList.SelectedItems.Count == 0 || factsList.SelectedItems[0].Tag is not ManaMemoryFact fact)
        {
            return;
        }
        var confirmed = MessageBox.Show(
            this,
            $"Delete the fact \"{fact.Key}\"? This removes it completely and cannot be undone. (Archive keeps it instead.)",
            "Delete Fact",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }
        try
        {
            await backendClient.DeleteMemoryFactAsync(fact.Key);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to delete fact '{fact.Key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    private async Task EditSelectedFactAsync()
    {
        if (factsList.SelectedItems.Count == 0 || factsList.SelectedItems[0].Tag is not ManaMemoryFact fact)
        {
            return;
        }
        string? trigger = null;
        if (fact.Trigger != "")
        {
            using var whenDialog = new TextPromptDialog("Edit reminder", "When this comes up:", fact.Trigger);
            if (whenDialog.ShowDialog(this) != DialogResult.OK || whenDialog.Value.Trim() == "")
            {
                return;
            }
            trigger = whenDialog.Value.Trim();
        }
        using var textDialog = new TextPromptDialog("Edit fact", fact.Trigger == "" ? "Fact:" : "Mention:", fact.Text);
        if (textDialog.ShowDialog(this) != DialogResult.OK || textDialog.Value.Trim() == "")
        {
            return;
        }
        try
        {
            await backendClient.UpdateMemoryFactAsync(fact.Key, textDialog.Value.Trim(), trigger);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to edit fact '{fact.Key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    private async Task TogglePauseSelectedFactAsync()
    {
        if (factsList.SelectedItems.Count == 0 || factsList.SelectedItems[0].Tag is not ManaMemoryFact fact || fact.Trigger == "")
        {
            return;
        }
        try
        {
            await backendClient.SetMemoryFactPausedAsync(fact.Key, !fact.Paused);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to pause reminder '{fact.Key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    private async Task ConfirmSelectedFactAsync()
    {
        if (factsList.SelectedItems.Count == 0 || factsList.SelectedItems[0].Tag is not ManaMemoryFact fact)
        {
            return;
        }
        try
        {
            await backendClient.ConfirmMemoryFactAsync(fact.Key);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to confirm fact '{fact.Key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    private async Task ArchiveSelectedFactAsync()
    {
        if (factsList.SelectedItems.Count == 0 || factsList.SelectedItems[0].Tag is not ManaMemoryFact fact)
        {
            return;
        }
        var key = fact.Key;
        try
        {
            await backendClient.ArchiveMemoryFactAsync(key);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to archive fact '{key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMemoryFactsAsync();
        }
    }

    private async Task RefreshVaultStatusAsync()
    {
        try
        {
            ShowVaultStatus(await backendClient.GetMemoryVaultStatusAsync());
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load the vault status. {ex.Message}");
            if (!IsDisposed)
            {
                vaultStatusLabel.Text = "Obsidian · couldn't check the sync";
                vaultDot.Color = DarkTheme.Muted;
            }
        }
    }

    private void ShowVaultStatus(ManaVaultStatus status)
    {
        if (IsDisposed)
        {
            return;
        }
        vault = status;
        vaultStatusLabel.Text = VaultLine(status, DateTimeOffset.Now);
        // The full story (the folder, notes skipped and why) on hover.
        railTips.SetToolTip(vaultStatusLabel, DescribeVault(status, DateTimeOffset.Now));
        vaultDot.Color = status.VaultDir is null ? DarkTheme.Muted : status.Error is not null ? Color.IndianRed : DarkTheme.Green;
        vaultSyncButton.Enabled = openVaultLink.Enabled = status.VaultDir is not null;
    }

    // #935: the Memory Facts tab's vault line, in Doctor's terms.
    private readonly ToolTip railTips = new();

    internal static string DescribeVault(ManaVaultStatus status, DateTimeOffset now)
    {
        if (status.VaultDir is null)
        {
            return "Obsidian vault sync is off. Set MANA_VAULT_DIR in node-bot/.env to turn it on.";
        }
        var mode = status.Mode switch
        {
            "watching" => "watching for changes",
            "polling" => "file watcher down, checking every 60 s",
            _ => "not running",
        };
        var last = status.LastSyncAt is { } at ? $"last sync {Math.Max(0, (int)(now - at).TotalSeconds)} s ago" : "not synced yet";
        var text = $"Vault: {status.VaultDir} -- {mode}, {status.Notes} notes, {last}.";
        if (status.Error is not null)
        {
            text += $"\nError: {status.Error}";
        }
        if (status.Skipped.Count > 0)
        {
            text += $"\nSkipped {status.Skipped.Count}: " + string.Join("; ", status.Skipped.Select(s => $"{s.File} ({s.Reason})"));
        }
        return text;
    }

    internal async Task RefreshMemoryFactsAsync()
    {
        await RefreshVaultStatusAsync();
        try
        {
            facts = await backendClient.GetMemoryFactsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load memory facts. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(factsList, BackendError.Describe(ex));
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        ShowFacts();
    }

    private void ShowFacts()
    {
        foreach (var chip in factChips)
        {
            var (state, label) = ((string, string))chip.Tag!;
            chip.Text = $"{label} {facts.Count(f => FactState(f) == state)}";
        }
        var keep = SelectedFact?.Key;
        var now = DateTimeOffset.Now;
        var shown = facts
            .Where(f => FactState(f) == factFilter && MatchesSearch(factsSearch.Text, f.Key, f.Text, f.Trigger))
            .Select(f => new RowList.Entry(f, f.Key, f.Text + (f.Paused ? " (paused)" : ""), UpdatedText(f.UpdatedAt, now),
                Tag: f.Trigger == "" ? null : f.Trigger.Length > 24 ? f.Trigger[..23] + "…" : f.Trigger,
                Pinned: f.Pinned, Group: f.Category));
        factsList.ShowEntries(shown, FactCategories, factsSearch.Text.Trim().Length > 0 ? "Nothing matches" : "Nothing here", v => ((ManaMemoryFact)v).Key == keep);
    }


    private async Task ImportSkillFolderAsync()
    {
        using var dialog = new FolderBrowserDialog { Description = "Pick a skill folder (one with a SKILL.md in it)", UseDescriptionForTitle = true };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            await SubmitSkillImportAsync(dialog.SelectedPath);
        }
    }

    private async Task ImportSkillZipAsync()
    {
        using var dialog = new OpenFileDialog { Title = "Pick a zipped skill (a SKILL.md folder)", Filter = "Zip files (*.zip)|*.zip" };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            await SubmitSkillImportAsync(dialog.FileName);
        }
    }

    private async Task ImportSkillLinkAsync()
    {
        using var dialog = new TextPromptDialog("Import Skill", "Link (github.com or clawhub.ai):", "");
        if (dialog.ShowDialog(this) == DialogResult.OK && !string.IsNullOrWhiteSpace(dialog.Value))
        {
            await SubmitSkillImportAsync(dialog.Value.Trim());
        }
    }

    private async Task SubmitSkillImportAsync(string path)
    {
        string? error;
        try
        {
            error = await backendClient.ImportSkillAsync(path);
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }
        if (IsDisposed)
        {
            return;
        }
        if (error is null)
        {
            MessageBox.Show(this, "Import submitted -- review and approve it from the Approvals tab. Nothing in it runs.", "Import Skill", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        else
        {
            MessageBox.Show(this, $"Couldn't import that skill: {error}", "Import Skill", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task CreateSkillAsync()
    {
        using var dialog = new SkillEditorDialog("New Skill", isNew: true);
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        // #688: a skill you typed in yourself that neither the content scan
        // nor Guardian flagged is approved straight away; a flagged one
        // waits in Approvals.
        string? note = null;
        try
        {
            var result = await backendClient.CreateSkillAsync(dialog.SkillName, dialog.Description, dialog.Body, dialog.Category);
            if (!result.Created && result.PendingId is { } id && result.Flags.Count == 0)
            {
                try
                {
                    await backendClient.DecideApprovalAsync(id, "allow-once");
                }
                catch (Exception ex)
                {
                    note = $"Skill submitted, but approving it failed ({ex.Message}) -- approve it from the Approvals tab.";
                }
            }
            else if (!result.Created)
            {
                note = result.Flags.Count > 0
                    ? $"Flagged: {string.Join(", ", result.Flags)}. Review and approve it from the Approvals tab."
                    : "Skill submitted -- approve it from the Approvals tab.";
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to create skill: {ex.Message}", "New Skill", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        if (note is not null)
        {
            MessageBox.Show(this, note, "New Skill", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        await RefreshSkillsAsync();
    }

    private async Task EditSelectedSkillAsync()
    {
        if (skillsList.SelectedItems.Count == 0)
        {
            return;
        }
        var name = (string)skillsList.SelectedItems[0].Tag!;

        ManaSkillDetail detail;
        try
        {
            detail = await backendClient.GetSkillDetailAsync(name);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to load skill: {ex.Message}", "Edit Skill", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        using var dialog = new SkillEditorDialog("Edit Skill", isNew: false, detail.Name, detail.Description, detail.Body, detail.Category);
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            await backendClient.UpdateSkillAsync(name, dialog.Description, dialog.Body, dialog.Category);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to update skill: {ex.Message}", "Edit Skill", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshSkillsAsync();
        }
    }

    private async Task DeleteSelectedSkillAsync()
    {
        if (skillsList.SelectedItems.Count == 0)
        {
            return;
        }
        var name = (string)skillsList.SelectedItems[0].Tag!;
        var confirmed = MessageBox.Show(
            this,
            $"Delete skill \"{name}\"? This cannot be undone.",
            "Delete Skill",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }

        try
        {
            await backendClient.DeleteSkillAsync(name);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to delete skill '{name}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshSkillsAsync();
        }
    }

    private async Task RefreshSkillsAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaSkill> skills;
        try
        {
            skills = await backendClient.GetSkillsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load skills. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(skillsList, BackendError.Describe(ex));
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        try
        {
            var mode = Array.IndexOf(ImportedSkillUseModes, await backendClient.GetImportedSkillUseAsync());
            if (!IsDisposed && mode >= 0)
            {
                loadingRows = true;
                importedSkillUseBox.SelectedIndex = mode;
                loadingRows = false;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load the imported-skills setting. {ex.Message}");
        }
        if (IsDisposed)
        {
            return;
        }

        skillsList.ShowEntries(skills.Select(s => new RowList.Entry(s.Name, s.Name, s.Description ?? "", s.Status ?? "")), null, "No skills yet");
    }

    private TabPage BuildApprovalsTab()
    {
        approvalsList.Dock = DockStyle.Fill;
        approvalsList.View = View.Details;
        approvalsList.FullRowSelect = true;
        approvalsList.Columns.Add("Type", 120);
        approvalsList.Columns.Add("Summary", 300);
        DarkTheme.ApplyListView(approvalsList);

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        var allowButton = new Button { Text = "Allow once" };
        // #669: an in-memory grant that ends when Mana restarts.
        var sessionButton = new Button { Text = "Allow for session", AutoSize = true };
        var alwaysAllowButton = new Button { Text = "Always allow" };
        var denyButton = new Button { Text = "Deny" };
        // #1154: a deny that's remembered (e.g. never act on this site).
        var neverButton = new Button { Text = "Never" };
        DarkTheme.ApplyButton(allowButton);
        DarkTheme.ApplyButton(sessionButton);
        DarkTheme.ApplyButton(alwaysAllowButton);
        DarkTheme.ApplyButton(denyButton);
        DarkTheme.ApplyButton(neverButton);

        // All four share one guard -- a decision resolves the request
        // server-side, so a second click (this button or a different
        // one) while the first is still in flight would just 404 there
        // instead of doing anything useful.
        async Task DecideAsync(string decision)
        {
            allowButton.Enabled = false;
            sessionButton.Enabled = false;
            alwaysAllowButton.Enabled = false;
            denyButton.Enabled = false;
            neverButton.Enabled = false;
            try
            {
                await DecideSelectedApprovalAsync(decision);
            }
            finally
            {
                if (!IsDisposed)
                {
                    allowButton.Enabled = true;
                    sessionButton.Enabled = true;
                    alwaysAllowButton.Enabled = true;
                    denyButton.Enabled = true;
                    neverButton.Enabled = true;
                }
            }
        }
        allowButton.Click += async (_, _) => await DecideAsync("allow-once");
        sessionButton.Click += async (_, _) => await DecideAsync("allow-session");
        alwaysAllowButton.Click += async (_, _) => await DecideAsync("always-allow");
        denyButton.Click += async (_, _) => await DecideAsync("deny");
        neverButton.Click += async (_, _) => await DecideAsync("never");
        buttonRow.Controls.Add(allowButton);
        buttonRow.Controls.Add(sessionButton);
        buttonRow.Controls.Add(alwaysAllowButton);
        buttonRow.Controls.Add(denyButton);
        buttonRow.Controls.Add(neverButton);

        rememberedList.Dock = DockStyle.Fill;
        rememberedList.View = View.Details;
        rememberedList.FullRowSelect = true;
        rememberedList.Columns.Add("Remembered", 300);
        rememberedList.Columns.Add("Answer", 80);
        DarkTheme.ApplyListView(rememberedList);
        var forgetButton = new Button { Text = "Forget", Dock = DockStyle.Bottom, AccessibleName = "Forget: ask again next time" };
        DarkTheme.ApplyButton(forgetButton);
        forgetButton.Click += async (_, _) => await ForgetSelectedAsync();
        var rememberedPanel = new Panel { Dock = DockStyle.Bottom, Height = 150, BackColor = DarkTheme.Background };
        rememberedPanel.Controls.Add(rememberedList);
        rememberedPanel.Controls.Add(forgetButton);
        rememberedPanel.Controls.Add(new Label { Text = "Remembered answers (always / never)", Dock = DockStyle.Top, Height = 20, ForeColor = DarkTheme.Muted });

        toolApprovalModeCombo.Items.AddRange(new object[]
        {
            "Smart -- ask unless it's read-only or a small change like the volume",
            "Ask for every tool call",
            "Only destructive commands",
        });
        toolApprovalModeCombo.BackColor = DarkTheme.Panel2;
        toolApprovalModeCombo.ForeColor = DarkTheme.Text;
        // SelectionChangeCommitted: user picks only, not Refresh's.
        toolApprovalModeCombo.SelectionChangeCommitted += async (_, _) => await SaveToolApprovalModeAsync();
        var modeRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        modeRow.Controls.Add(new Label { Text = "Ask before tool calls:", AutoSize = true, ForeColor = DarkTheme.Text, Margin = new Padding(3, 6, 3, 3) });
        modeRow.Controls.Add(toolApprovalModeCombo);
        var modePanel = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = DarkTheme.Background };
        modePanel.Controls.Add(modeRow);
        modePanel.Controls.Add(new Label { Text = "Destructive commands (rm -rf, registry edits, download-and-run...) always ask, in every mode.", AutoSize = true, ForeColor = DarkTheme.Muted });

        // #1191: Mana's own git and GitHub actions. Reads never ask; a game
        // running, the secret scan and "never" still apply in every mode.
        modePanel.Controls.Add(new Label { Text = "Git and GitHub", AutoSize = true, ForeColor = DarkTheme.Text, Margin = new Padding(3, 12, 3, 3) });
        string[] tierNames =
        {
            "Local changes (branch, commit, merge main in):",
            "GitHub writes (push a branch, PRs, issues, comments):",
            "Merge a PR, push to main, force-push, delete branches, rewrite history:",
        };
        for (var i = 0; i < gitApprovalCombos.Length; i++)
        {
            var combo = gitApprovalCombos[i];
            var tier = GitApprovalTiers[i];
            combo.Items.AddRange(new object[] { "Ask every time", "Ask once, then always allow", "No approval" });
            combo.BackColor = DarkTheme.Panel2;
            combo.ForeColor = DarkTheme.Text;
            combo.SelectionChangeCommitted += async (_, _) => await SaveGitApprovalModeAsync(tier, combo);
            var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
            row.Controls.Add(new Label { Text = tierNames[i], AutoSize = true, ForeColor = DarkTheme.Text, Margin = new Padding(3, 6, 3, 3) });
            row.Controls.Add(combo);
            modePanel.Controls.Add(row);
        }
        keepFolioCheck.Click += async (_, _) => await SaveKeepFolioAsync();
        var checkFolioButton = new Button { Text = "Check now", AutoSize = true, AccessibleName = "Check Folio now" };
        DarkTheme.ApplyButton(checkFolioButton);
        checkFolioButton.Click += async (_, _) =>
        {
            folioStatusLabel.Text = "Checking...";
            string text;
            try
            {
                text = await backendClient.CheckFolioNowAsync();
            }
            catch (Exception ex)
            {
                text = $"Couldn't check: {ex.Message}";
            }
            if (!IsDisposed)
            {
                folioStatusLabel.Text = text;
            }
        };
        var folioRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        folioRow.Controls.Add(keepFolioCheck);
        folioRow.Controls.Add(checkFolioButton);
        folioRow.Controls.Add(folioStatusLabel);
        modePanel.Controls.Add(folioRow);
        modePanel.Controls.Add(gitDangerWarning);

        var page = new TabPage("Approvals");
        page.Controls.Add(approvalsList);
        page.Controls.Add(buttonRow);
        page.Controls.Add(rememberedPanel);
        page.Controls.Add(modePanel);
        return page;
    }

    internal async Task RefreshRememberedAsync()
    {
        IReadOnlyList<ManaRememberedApproval> remembered;
        try
        {
            remembered = await backendClient.GetRememberedApprovalsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load remembered approvals. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(rememberedList, BackendError.Describe(ex));
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        rememberedList.Items.Clear();
        foreach (var entry in remembered)
        {
            var item = new ListViewItem(entry.Label) { Tag = entry.Key };
            item.SubItems.Add(entry.Answer == "never" ? "Never" : "Always");
            rememberedList.Items.Add(item);
        }
    }

    private async Task ForgetSelectedAsync()
    {
        if (rememberedList.SelectedItems.Count == 0)
        {
            return;
        }
        var key = (string)rememberedList.SelectedItems[0].Tag!;
        try
        {
            await backendClient.ForgetApprovalAsync(key);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to forget '{key}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshRememberedAsync();
        }
    }

    private async Task RefreshToolApprovalModeAsync()
    {
        string? mode;
        try
        {
            mode = await backendClient.GetToolApprovalModeAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load the tool approval mode. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            toolApprovalModeCombo.SelectedIndex = Array.IndexOf(ToolApprovalModes, mode);
        }
    }

    internal async Task RefreshGitApprovalModesAsync()
    {
        IReadOnlyDictionary<string, string> modes;
        try
        {
            modes = await backendClient.GetGitApprovalModesAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load the git approval modes. {ex.Message}");
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        for (var i = 0; i < GitApprovalTiers.Length; i++)
        {
            gitApprovalCombos[i].SelectedIndex = modes.TryGetValue(GitApprovalTiers[i], out var mode) ? Array.IndexOf(GitApprovalModes, mode) : -1;
        }
        UpdateGitDangerWarning();
        try
        {
            var keep = await backendClient.GetKeepFolioUpdatedAsync();
            if (!IsDisposed)
            {
                keepFolioCheck.Checked = keep;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load Keep Folio up to date. {ex.Message}");
        }
    }

    private async Task SaveKeepFolioAsync()
    {
        try
        {
            await backendClient.SetKeepFolioUpdatedAsync(keepFolioCheck.Checked);
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                MessageBox.Show(this, $"Failed to save Keep Folio up to date: {ex.Message}", "Approvals", MessageBoxButtons.OK, MessageBoxIcon.Error);
                await RefreshGitApprovalModesAsync();
            }
        }
    }

    private void UpdateGitDangerWarning()
    {
        var off = gitApprovalCombos[Array.IndexOf(GitApprovalTiers, "danger")].SelectedIndex == Array.IndexOf(GitApprovalModes, "off");
        gitDangerWarning.Text = off
            ? "Warning: Mana can merge PRs, push to main, force-push and delete branches without asking you. Each one is still logged."
            : "";
    }

    private async Task SaveGitApprovalModeAsync(string tier, ComboBox combo)
    {
        if (combo.SelectedIndex < 0)
        {
            return;
        }
        UpdateGitDangerWarning();
        try
        {
            await backendClient.SetGitApprovalModeAsync(tier, GitApprovalModes[combo.SelectedIndex]);
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                MessageBox.Show(this, $"Failed to save the git approval setting: {ex.Message}", "Approvals", MessageBoxButtons.OK, MessageBoxIcon.Error);
                await RefreshGitApprovalModesAsync();
            }
        }
    }

    private async Task SaveToolApprovalModeAsync()
    {
        if (toolApprovalModeCombo.SelectedIndex < 0)
        {
            return;
        }
        try
        {
            await backendClient.SetToolApprovalModeAsync(ToolApprovalModes[toolApprovalModeCombo.SelectedIndex]);
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                MessageBox.Show(this, $"Failed to save the approval mode: {ex.Message}", "Approvals", MessageBoxButtons.OK, MessageBoxIcon.Error);
                await RefreshToolApprovalModeAsync();
            }
        }
    }

    private async Task DecideSelectedApprovalAsync(string decision)
    {
        if (approvalsList.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)approvalsList.SelectedItems[0].Tag!;
        try
        {
            // #838: an ACP agent request is decided once; there are no
            // session or standing grants for it.
            if (id.StartsWith(PendingWriteTag, StringComparison.Ordinal))
            {
                if (decision is not ("allow-once" or "deny"))
                {
                    MessageBox.Show(this, "This request from the coding agent can only be allowed once or denied.", "Approvals", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                await backendClient.DecidePendingWriteAsync(id[PendingWriteTag.Length..], decision == "allow-once");
            }
            else
            {
                await backendClient.DecideApprovalAsync(id, decision);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to decide approval '{id}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshApprovalsAsync();
            await RefreshRememberedAsync();
        }
    }

    private async Task RefreshApprovalsAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaPendingApproval> pending;
        try
        {
            pending = await backendClient.GetPendingApprovalsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load pending approvals. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(approvalsList, BackendError.Describe(ex));
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        IReadOnlyList<ManaPendingWrite> writes = [];
        try
        {
            writes = await backendClient.GetPendingWritesAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load pending agent writes. {ex.Message}");
        }
        if (IsDisposed)
        {
            return;
        }

        approvalsList.Items.Clear();
        foreach (var approval in pending)
        {
            var item = new ListViewItem(approval.ActionType) { Tag = approval.Id };
            item.SubItems.Add(approval.Summary);
            approvalsList.Items.Add(item);
        }
        foreach (var write in writes)
        {
            var item = new ListViewItem(write.Kind) { Tag = PendingWriteTag + write.Id };
            item.SubItems.Add(write.Summary);
            approvalsList.Items.Add(item);
        }
    }

    // Marks an approvals-list row as an ACP agent pending write (#838).
    private const string PendingWriteTag = "write:";

    // #583: "Auto" (null override) plus the 4 providers server.js's
    // TTS_OVERRIDE_PROVIDERS allow-lists -- selecting it clears the
    // override rather than sending an invalid 5th value.
    private const string AutoProviderLabel = "Auto (gaming-based)";
    private static readonly string[] TtsProviders = { AutoProviderLabel, "fish", "kokoro", "gpt_sovits", "cli" };
    private static readonly string[] TtsProviderLabels = { "Automatic", "Fish Speech", "Kokoro", "GPT-SoVITS", "Command line" };

    private readonly Func<HotkeyAction, Keys?, string?>? bindHotkey;

    // #689: each global hotkey's combination -- click the box and press the
    // new one (Backspace turns it off). A combination another Mana hotkey
    // or another app already uses is refused. Rebinds live when the
    // launcher wired bindHotkey; saved either way.

    private SettingsRow BuildHotkeyRow(HotkeyAction action)
    {
        var box = new TextBox { ReadOnly = true, Width = 140, BackColor = DarkTheme.Panel, ForeColor = DarkTheme.Text, AccessibleName = $"{action.Label} hotkey", ShortcutsEnabled = false };
        var status = SettingsRows.Status();
        var current = HotkeyBindings.Resolve(ManaSettingsStore.Load().Hotkeys, action);
        box.Text = HotkeyBindings.Format(current);

        void Apply(Keys? keys)
        {
            if (keys == current)
            {
                return;
            }
            var settings = ManaSettingsStore.Load();
            if (keys is Keys k && HotkeyBindings.ConflictFor(settings.Hotkeys, action, k) is { } other)
            {
                status.Text = $"Already used for \"{other.Label}\"";
                return;
            }
            if (bindHotkey?.Invoke(action, keys) is { } error)
            {
                // The old combination is off now too; put it back.
                bindHotkey(action, HotkeyBindings.Resolve(settings.Hotkeys, action));
                status.Text = error;
                return;
            }
            settings.Hotkeys ??= new();
            settings.Hotkeys[action.Key] = keys is Keys set ? HotkeyBindings.Format(set) : "";
            settings.Save();
            var before = current;
            current = keys;
            box.Text = HotkeyBindings.Format(keys);
            status.Text = bindHotkey is null ? "Applies next launch" : "";
            Changed($"{action.Label} {(keys is null ? "off" : HotkeyBindings.Format(keys))}", () => Apply(before));
        }

        box.KeyDown += (_, e) =>
        {
            e.SuppressKeyPress = true;
            e.Handled = true;
            if (e.KeyData is Keys.Back or Keys.Delete)
            {
                Apply(null);
            }
            else if (HotkeyBindings.IsValid(e.KeyData))
            {
                Apply(e.KeyData);
            }
            else if ((e.KeyCode & Keys.KeyCode) is not (Keys.ControlKey or Keys.ShiftKey or Keys.Menu))
            {
                status.Text = "Use Ctrl or Alt plus a key";
            }
        };
        return new SettingsRow(action.Label, null, "hotkey shortcut keyboard keys", status, box, SettingsRows.Action("Default", () => Apply(action.Default)));
    }


    // #907: node-bot's daily briefing (GET/POST /briefing). "Brief me" in
    // chat gives it on demand whatever's set here.
    private static readonly (string Key, string Label, string Explanation)[] BriefingSections =
    {
        ("reminders", "Reminders", "What's due today"),
        ("memory", "What's coming up", "Things she remembers are coming up"),
        ("news", "News", "On your news topics, below"),
        ("games", "Game news", "Patches and maintenance for your games, below"),
        ("calendar", "Calendar and mail", "Once they're connected"),
    };
    private Func<Task>? refreshBriefing;

    // #1426 stage 2: Check-ins as one page of rows -- the daily briefing,
    // when she speaks up on her own (#697, #700) and her background checks
    // (#699). What the backend holds loads with the rest of Settings.
    private ProactivePanel? proactive;
    private HeartbeatPanel? heartbeat;

    private TabPage BuildCheckInsPage()
    {
        proactive = new ProactivePanel(backendClient, loadNow: false, Changed);
        heartbeat = new HeartbeatPanel(backendClient, loadNow: false);
        var parts = new List<Control> { SettingsRows.Section("Daily briefing") };
        parts.AddRange(BuildBriefingRows());
        parts.Add(SettingsRows.Section("Speaking up"));
        // Part of #700: the backend reads it when the launcher next starts it.
        parts.Add(SwitchRow("Check in when you seem down", "At most once a day. Applies next time Mana starts", "mood sad check in wellbeing",
            !ManaSettingsStore.Load().NoCheckIns, on =>
            {
                var latest = ManaSettingsStore.Load();
                latest.NoCheckIns = !on;
                latest.Save();
            }));
        parts.AddRange(proactive.Rows);
        parts.Add(SettingsRows.Section("Background checks"));
        parts.AddRange(heartbeat.Rows);
        return SettingsRows.Page("Check-ins", parts.ToArray());
    }

    // Each switch saves the whole briefing at once; a box saves when it's left changed.
    private Control[] BuildBriefingRows()
    {
        var time = SettingsRows.Box("Briefing time", 50, "09:00");
        var topics = SettingsRows.Box("News topics", 240, "Comma-separated");
        var games = SettingsRows.Box("Games", 240, "Comma-separated");
        var status = SettingsRows.Status();
        var enabled = new SettingsSwitch { AccessibleName = "Daily briefing" };
        var sections = BriefingSections.Select(s => new SettingsSwitch { AccessibleName = s.Label, Tag = s.Key }).ToArray();
        ManaBriefingSettings? shown = null;

        void Render(ManaBriefingSettings settings)
        {
            if (enabled.IsDisposed)
            {
                return;
            }
            shown = settings;
            loadingRows = true;
            try
            {
                enabled.Checked = settings.Enabled;
                foreach (var check in sections)
                {
                    check.Checked = settings.Sections.Contains((string)check.Tag!);
                }
            }
            finally
            {
                loadingRows = false;
            }
            time.Text = settings.Time;
            topics.Text = settings.Topics;
            games.Text = settings.Games;
        }

        async Task SaveAsync()
        {
            try
            {
                Render(await backendClient.UpdateBriefingAsync(new ManaBriefingSettings
                {
                    Enabled = enabled.Checked,
                    Time = time.Text.Trim(),
                    Sections = sections.Where(c => c.Checked).Select(c => (string)c.Tag!).ToList(),
                    Topics = topics.Text,
                    Games = games.Text,
                }));
                status.Text = "";
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                if (!status.IsDisposed)
                {
                    status.Text = $"Couldn't save: {BackendError.Describe(ex)}";
                }
            }
        }
        foreach (var box in new[] { time, topics, games })
        {
            box.Leave += (_, _) =>
            {
                if (shown is { } now && (time.Text.Trim() != now.Time || topics.Text != now.Topics || games.Text != now.Games))
                {
                    _ = SaveAsync();
                }
            };
        }
        refreshBriefing = async () =>
        {
            try
            {
                Render(await backendClient.GetBriefingAsync());
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                Console.WriteLine($"SettingsPanel: failed to load the briefing settings. {ex.Message}");
            }
        };

        var rows = new List<Control>
        {
            SwitchRow("Daily briefing", "The first time you're at the PC after this time, as a toast and in her voice. Say \"brief me\" for it any time", "briefing morning summary",
                false, on => _ = SaveAsync(), SettingsRows.Line(status, SettingsRows.Words("After"), time), enabled),
        };
        for (var i = 0; i < sections.Length; i++)
        {
            var (key, label, explanation) = BriefingSections[i];
            rows.Add(SwitchRow(label, explanation, $"briefing {key}", false, on => _ = SaveAsync(), flip: sections[i]));
        }
        rows.Add(new SettingsRow("News topics", "What the news part covers", "briefing news topics", topics));
        rows.Add(new SettingsRow("Games", "Whose patches and maintenance to include", "briefing games patch", games));
        return rows.ToArray();
    }


    // #923/#925/#926: node-bot's speech words (whisper listens for them),
    // mishearing fixes (applied to every transcript) and whisper's language,
    // through GET/POST /speech. Each change is saved at once and applies to
    // the next thing I say.
    private Func<Task>? refreshSpeechWords;

    private Control[] BuildSpeechWordsRows()
    {
        TextBox Box(string placeholder, int width) => SettingsRows.Box(placeholder, width, placeholder);
        var words = SettingsRows.List("Speech words");
        var word = Box("Word or name", 160);
        var addWord = SettingsRows.Action("Add", () => { });
        var removeWord = SettingsRows.Action("Remove", () => { });
        var fixes = SettingsRows.List("Mishearing fixes");
        var fixKeys = new List<string>();
        var heard = Box("She heard", 100);
        var meant = Box("You said", 100);
        var addFix = SettingsRows.Action("Add", () => { });
        var removeFix = SettingsRows.Action("Remove", () => { });
        var language = new ComboBox();
        var status = SettingsRows.Status();

        void Render(ManaSpeechVocabulary speech)
        {
            if (words.IsDisposed)
            {
                return;
            }
            words.Items.Clear();
            words.Items.AddRange(speech.Words.ToArray<object>());
            fixes.Items.Clear();
            fixKeys.Clear();
            foreach (var (from, to) in speech.Corrections)
            {
                fixes.Items.Add($"{from} → {to}");
                fixKeys.Add(from);
            }
            loadingRows = true;
            language.SelectedIndex = speech.Language == "auto" ? 1 : 0;
            loadingRows = false;
            language.Enabled = speech.EnvLanguage is null;
            status.Text = speech.EnvLanguage is null ? "" : "Set in Mana's environment, which wins";
        }

        // confirmed: the same change with confirm = true, offered when
        // node-bot says heard may be an ordinary word.
        async Task<bool> Save(object change, object? confirmed = null)
        {
            try
            {
                Render(await backendClient.UpdateSpeechAsync(change));
                return true;
            }
            catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.Conflict && confirmed is not null)
            {
                return !IsDisposed
                    && MessageBox.Show(this, $"{ex.Message}.\n\nAdd the fix anyway?", "Mishearing fixes", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes
                    && await Save(confirmed);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                if (!status.IsDisposed)
                {
                    status.Text = $"Couldn't save: {BackendError.Describe(ex)}";
                }
                return false;
            }
        }

        addWord.Click += async (_, _) =>
        {
            if (await Save(new { addWord = word.Text }))
            {
                word.Clear();
            }
        };
        removeWord.Click += async (_, _) =>
        {
            if (words.SelectedItem is string selected)
            {
                await Save(new { removeWord = selected });
            }
        };
        addFix.Click += async (_, _) =>
        {
            if (await Save(new { heard = heard.Text, term = meant.Text }, new { heard = heard.Text, term = meant.Text, confirm = true }))
            {
                heard.Clear();
                meant.Clear();
            }
        };
        removeFix.Click += async (_, _) =>
        {
            if (fixes.SelectedIndex >= 0)
            {
                await Save(new { removeCorrection = fixKeys[fixes.SelectedIndex] });
            }
        };
        refreshSpeechWords = async () =>
        {
            try
            {
                Render(await backendClient.GetSpeechAsync());
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                Console.WriteLine($"SettingsPanel: failed to load speech words. {ex.Message}");
            }
        };

        return new Control[]
        {
            ChoiceRow("Speech language", "The language she listens for", "whisper language english auto detect",
                new[] { "English only", "Detect it" }, 0, i => _ = Save(new { language = i == 1 ? "auto" : "en" }), language, status),
            new SettingsRow("Words she should know", "Names and terms she mishears", "vocabulary names words",
                SettingsRows.Editor(words, word, addWord, removeWord)),
            new SettingsRow("Mishearing fixes", "What she keeps hearing, and what you said", "corrections mishear",
                SettingsRows.Editor(fixes, heard, meant, addFix, removeFix)),
        };
    }

    // #1107: keep my real spoken turns (VoiceData) for a Whisper fine-tune
    // later; off by default, read at each turn. The count and delete cover
    // #1112's training lines too, which "Record lines" records with
    // listening paused, like the enrolment.
    private Control[] BuildVoiceClipsRows()
    {
        var totals = SettingsRows.Status();
        (int Clips, double Minutes) Totals()
        {
            var all = VoiceData.AllFolders.Select(VoiceData.Totals).ToList();
            return (all.Sum(t => t.Clips), all.Sum(t => t.Minutes));
        }
        void ShowTotals()
        {
            var (clips, minutes) = Totals();
            totals.Text = $"{clips} clips, {minutes:F1} min";
        }
        ShowTotals();

        var record = SettingsRows.Action("Record lines…", () =>
        {
            listeningPause?.Pause();
            try
            {
                using var form = new TrainingLinesForm(backendClient);
                form.ShowDialog(FindForm());
            }
            finally
            {
                listeningPause?.Resume();
            }
            ShowTotals();
        });
        var delete = SettingsRows.Action("Delete…", () =>
        {
            var (clips, _) = Totals();
            if (clips == 0
                || MessageBox.Show(this, $"Delete all {clips} of your voice clips? This can't be undone.", "Voice clips", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
            {
                return;
            }
            try
            {
                foreach (var folder in VoiceData.AllFolders)
                {
                    VoiceData.Delete(folder);
                }
                ShowTotals();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                totals.Text = $"Couldn't delete them all: {ex.Message}";
            }
        });
        var clipsRow = new SettingsRow("Your voice clips", "Kept on this PC only, never uploaded", "voice data training whisper fine-tune", totals, record, delete);
        clipsRow.VisibleChanged += (_, _) =>
        {
            if (clipsRow.Visible)
            {
                ShowTotals();
            }
        };
        return new Control[]
        {
            SwitchRow("Keep voice clips", "Saves what you say, to train her hearing later", "voice data training record keep",
                ManaSettingsStore.Load().KeepVoiceClips, on =>
                {
                    var latest = ManaSettingsStore.Load();
                    latest.KeepVoiceClips = on;
                    latest.Save();
                }),
            clipsRow,
        };
    }

    // #678: which speech has to be my voice (SpeakerGate), and teaching Mana
    // my voice: each prompt is recorded for EnrollClipMs from the default
    // mic, embedded, and the average saved as ManaSettingsStore.Voiceprint.
    // Read each time listening starts; MANA_SPEAKER_GATE overrides the mode.
    // #922: listening pauses while it records, until it ends, I leave the
    // Voice tab (which cancels it, nothing saved) or Settings closes.
    private static readonly string[] EnrollPrompts =
    {
        "The quick brown fox jumps over the lazy dog.",
        "Could you remind me about the meeting tomorrow morning?",
        "I'd like a cup of tea and some toast, please.",
        "Seven silver swans swam slowly down the river.",
        "Let's put some music on and check the weather later.",
    };
    private const int EnrollClipMs = 5000;

    private SettingsRow BuildVoiceprintRow()
    {
        var teach = SettingsRows.Action("Teach her", () => { });
        var forget = SettingsRows.Action("Delete", () => { });
        var row = new SettingsRow("Your voice", "", "voiceprint enrol teach speaker", teach, forget);
        var status = row.Explanation!;
        void ShowEnrolled() => status.Text = ManaSettingsStore.Load().Voiceprint is null
            ? "Not taught yet, so \"Only your voice can\" does nothing"
            : "Saved on this PC";
        ShowEnrolled();

        forget.Click += (_, _) =>
        {
            var latest = ManaSettingsStore.Load();
            latest.Voiceprint = null;
            latest.Save();
            status.Text = "Deleted";
        };
        teach.Click += async (_, _) =>
        {
            var modelPath = SpeakerEmbedder.ResolveModelPath(ManaApplicationContext.FindRootDirectory());
            if (!File.Exists(modelPath))
            {
                status.Text = "The speaker model isn't installed";
                return;
            }
            using var cancel = new CancellationTokenSource();
            enrolmentCancel = cancel;
            bool Stopped()
            {
                if (status.IsDisposed)
                {
                    return true; // Settings closed mid-way: nothing saved
                }
                if (cancel.IsCancellationRequested)
                {
                    status.Text = "Stopped when you left Voice, nothing saved";
                }
                return cancel.IsCancellationRequested;
            }
            teach.Enabled = forget.Enabled = false;
            try
            {
                listeningPause?.Pause();
                using var embedder = await Task.Run(() => new SpeakerEmbedder(modelPath));
                var embeddings = new List<float[]>();
                for (var i = 0; i < EnrollPrompts.Length; i++)
                {
                    status.Text = $"{i + 1}/{EnrollPrompts.Length}: read aloud now, \"{EnrollPrompts[i]}\"";
                    var clip = await RecordAsync(EnrollClipMs, cancel.Token);
                    if (Stopped())
                    {
                        return;
                    }
                    var (boosted, _) = SpeechFilters.ApplySpeechGain(clip, SpeechFilters.GainTargetPeak, SpeechFilters.GainMaxBoost);
                    if (SpeechFilters.GetSpeechRejectReason(boosted, SpeechFilters.MinSpeechRms, SpeechFilters.MinSpeechPeak, SpeechFilters.MaxClickyZcr) is { } reason)
                    {
                        status.Text = $"I couldn't hear you clearly ({reason}). Check the mic and try again.";
                        return;
                    }
                    embeddings.Add(await Task.Run(() => embedder.Embed(SpeakerGate.SpeechSpan(clip))));
                }
                if (Stopped())
                {
                    return;
                }
                var latest = ManaSettingsStore.Load();
                latest.Voiceprint = SpeakerGate.Voiceprint(embeddings);
                latest.Save();
                status.Text = "Learned your voice";
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                status.Text = $"Couldn't learn your voice: {ex.Message}";
            }
            finally
            {
                enrolmentCancel = null;
                listeningPause?.Resume();
                if (!teach.IsDisposed)
                {
                    teach.Enabled = forget.Enabled = true;
                }
            }
        };
        row.Disposed += (_, _) =>
        {
            enrolmentCancel?.Cancel();
            listeningPause?.Resume();
        };
        return row;
    }

    // 16kHz mono from the default mic, like VoiceLoop's segments.
    private static async Task<short[]> RecordAsync(int ms, CancellationToken cancel)
    {
        var samples = new List<short>();
        using var waveIn = new NAudio.Wave.WaveInEvent { DeviceNumber = -1, WaveFormat = new NAudio.Wave.WaveFormat(SileroVadRunner.SampleRate, 16, 1) };
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        waveIn.DataAvailable += (_, e) =>
        {
            lock (samples)
            {
                for (var i = 0; i + 1 < e.BytesRecorded; i += 2)
                {
                    samples.Add(BitConverter.ToInt16(e.Buffer, i));
                }
            }
        };
        waveIn.RecordingStopped += (_, e) =>
        {
            if (e.Exception is { } ex)
            {
                stopped.TrySetException(ex);
            }
            else
            {
                stopped.TrySetResult();
            }
        };
        waveIn.StartRecording();
        try
        {
            await Task.Delay(ms, cancel);
        }
        catch (OperationCanceledException)
        {
            // #922: cut short; the caller discards the clip.
        }
        waveIn.StopRecording();
        await stopped.Task;
        lock (samples)
        {
            return samples.ToArray();
        }
    }


    // #665: what talking over Mana does (BargeInPolicy), read each time
    // listening starts; MANA_BARGE_IN_MODE overrides it.
    private static readonly string[] BargeInModes = { "minWords", "always", "notWhileSpeaking" };







    // #682: the #342 acoustic wake-word pre-filter (read once at startup,
    // so it applies on next launch; MANA_WAKE_PREFILTER overrides it) and
    // a shortcut to speech-debug.log, which shows what it decided.
    private static readonly string[] WakePrefilterModes = { "off", "loose", "normal" };


    private async Task SaveVoiceProviderAsync(int index)
    {
        try
        {
            await backendClient.SetTtsOverrideAsync(index == 0 ? null : TtsProviders[index]);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Couldn't change her voice: {BackendError.Describe(ex)}", "Voice", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task RefreshVoiceTabAsync()
    {
        string? overrideProvider;
        try
        {
            overrideProvider = await backendClient.GetTtsOverrideAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load voice provider override. {ex.Message}");
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        loadingRows = true;
        voiceProviderCombo.SelectedIndex = Math.Max(0, Array.IndexOf(TtsProviders, overrideProvider ?? AutoProviderLabel));
        loadingRows = false;
    }

    // #582: "live" -- a self-driving 1s timer, not just a refresh-on-open
    // snapshot like every other tab here, since the whole point of a log
    // tail is watching it update while the dialog stays open. The buffer
    // itself (BackendLogBuffer, fed by ManaProcessManager) only has
    // content when this launcher actually spawned the backend process --
    // an externally-already-running backend has nothing to redirect from.
    private TabPage BuildLogsTab()
    {
        logsTextBox.BackColor = DarkTheme.Panel2;
        logsTextBox.ForeColor = DarkTheme.Text;
        logsTextBox.Font = new Font(FontFamily.GenericMonospace, 9);

        RefreshLogsTab();
        // Only while it's in view: Settings in the tool panel lives as long as the app (#1119).
        logRefreshTimer.Tick += (_, _) =>
        {
            if (logsTextBox.Visible)
            {
                RefreshLogsTab();
            }
        };
        logRefreshTimer.Start();

        return new TabPage("Logs") { Controls = { logsTextBox } };
    }

    private void RefreshLogsTab()
    {
        if (IsDisposed)
        {
            return;
        }
        var lines = backendLog.Snapshot();
        logsTextBox.Text = lines.Count == 0
            ? "(no backend log output captured -- the backend may already have been running before Mana started it)"
            : string.Join(Environment.NewLine, lines);
        logsTextBox.SelectionStart = logsTextBox.Text.Length;
        logsTextBox.ScrollToCaret();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            logRefreshTimer.Stop();
            logRefreshTimer.Dispose();
        }
        base.Dispose(disposing);
    }


    // #575: Operations is free-form per node-bot's own perfMetrics.operations
    // (see GetPerformanceStatusAsync's own comment) -- shown as raw JSON per
    // row rather than parsed into specific fields, since this tab only
    // needs to display it, not act on it.
    private TabPage BuildPerfTab()
    {
        perfSummaryLabel.Dock = DockStyle.Top;
        perfSummaryLabel.Padding = new Padding(8);
        perfSummaryLabel.ForeColor = DarkTheme.Text;

        perfOperationsList.Dock = DockStyle.Fill;
        perfOperationsList.View = View.Details;
        perfOperationsList.FullRowSelect = true;
        perfOperationsList.Columns.Add("Operation", 180);
        perfOperationsList.Columns.Add("Details", 340);
        DarkTheme.ApplyListView(perfOperationsList);

        var page = new TabPage("Timings");
        page.Controls.Add(perfOperationsList);
        page.Controls.Add(perfSummaryLabel);
        return page;
    }

    // #688: like Electron's gaming status line.
    internal static string GamingStatusText(bool enabled, bool running, IReadOnlyList<string> processes) =>
        !enabled ? "Off"
        : running ? $"Active: {string.Join(", ", processes)}"
        : "No watched game running";

    private async Task RefreshPerfTabAsync()
    {
        ManaPerformanceStatus status;
        try
        {
            status = await backendClient.GetPerformanceStatusAsync(getCurrentSessionId?.Invoke());
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load performance status. {ex.Message}");
            if (!IsDisposed)
            {
                perfSummaryLabel.Text = $"Failed to load: {BackendError.Describe(ex)}";
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        var uptime = TimeSpan.FromSeconds(status.UptimeSeconds);
        var summary =
            $"Uptime: {uptime:d\\.hh\\:mm\\:ss}\n" +
            $"Memory: {status.TotalMemoryMb} MB    TTS: {status.TtsProvider}    Game detected: {status.GamingAppRunning}\n" +
            $"Whisper threads: {status.WhisperThreads}    Llama threads: {status.LlamaThreads}    Llama max tokens: {status.LlamaMaxTokens}\n" +
            $"Screen context: {(status.ScreenContextEnabled ? "enabled" : "disabled")}";

        // Issue #421 (backend): only present when remote AI is on for a
        // real session -- a local-only session has no cost to meter, so
        // the backend omits "tokenUsage" entirely rather than sending
        // zeros, and this line stays omitted here too rather than showing
        // a misleading "0 tokens".
        if (status.TokenUsage is { } usage)
        {
            var thresholdText = usage.WarnThreshold is { } warn || usage.StopThreshold is { } stop
                ? $" (warn at {usage.WarnThreshold?.ToString() ?? "-"}, stop at {usage.StopThreshold?.ToString() ?? "-"})"
                : "";
            var exceededText = usage.StopExceeded ? " -- STOP THRESHOLD EXCEEDED"
                : usage.WarnExceeded ? " -- warn threshold exceeded"
                : "";
            summary +=
                $"\nSession tokens: {usage.TotalTokens} total ({usage.PromptTokens} prompt + {usage.CompletionTokens} completion, {usage.Calls} calls){thresholdText}{exceededText}";
        }

        perfSummaryLabel.Text = summary;
        gamingStatusLabel.Text = GamingStatusText(gamingModeCheck.Checked, status.GamingAppRunning, status.MatchedProcesses);

        perfOperationsList.Items.Clear();
        foreach (var (name, details) in status.Operations)
        {
            var item = new ListViewItem(name);
            item.SubItems.Add(details);
            perfOperationsList.Items.Add(item);
        }
    }


    private void SaveActivePresetId(string? presetId)
    {
        var settings = ManaSettingsStore.Load();
        if (settings.ActivePresetId == presetId)
        {
            return;
        }
        settings.ActivePresetId = presetId;
        settings.Save();
        ActivePresetChanged?.Invoke(presetId);
    }

    private async Task CreatePresetAsync()
    {
        using var dialog = new PresetDialog("New Preset");
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            await backendClient.CreatePresetAsync(dialog.PresetName, dialog.Instructions);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to create preset: {ex.Message}", "New Preset", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshPresetsAsync();
        }
    }

    private async Task EditSelectedPresetAsync()
    {
        if (presetsList.SelectedItems.Count == 0)
        {
            return;
        }
        var preset = (ManaPreset)presetsList.SelectedItems[0].Tag!;
        using var dialog = new PresetDialog("Edit Preset", preset.Name, preset.Instructions);
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            await backendClient.UpdatePresetAsync(preset.Id, dialog.PresetName, dialog.Instructions);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to update preset: {ex.Message}", "Edit Preset", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshPresetsAsync();
        }
    }

    private async Task DeleteSelectedPresetAsync()
    {
        if (presetsList.SelectedItems.Count == 0)
        {
            return;
        }
        var preset = (ManaPreset)presetsList.SelectedItems[0].Tag!;
        var confirmed = MessageBox.Show(
            this,
            $"Delete preset \"{preset.Name}\"? This cannot be undone.",
            "Delete Preset",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }

        try
        {
            await backendClient.DeletePresetAsync(preset.Id);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to delete preset '{preset.Id}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshPresetsAsync();
        }
    }

    private async Task RefreshPresetsAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaPreset> presets;
        try
        {
            presets = await backendClient.GetPresetsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load presets. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(presetsList, BackendError.Describe(ex));
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        // #681: a stored id that no longer exists (deleted) falls back to
        // None and is cleared, same as windows-launcher's renderPresetSelect.
        var activeId = ManaSettingsStore.Load().ActivePresetId;
        presetsList.ShowEntries(presets.Select(p => new RowList.Entry(p, p.Name, p.Instructions.ReplaceLineEndings(" "), p.Id == activeId ? "Active" : "")), null, "No presets yet");
        populatingPresets = true;
        try
        {
            activePresetCombo.Items.Clear();
            activePresetCombo.Items.Add("None");
            object selected = "None";
            foreach (var preset in presets)
            {
                activePresetCombo.Items.Add(preset);
                if (preset.Id == activeId)
                {
                    selected = preset;
                }
            }
            activePresetCombo.SelectedItem = selected;
        }
        finally
        {
            populatingPresets = false;
        }
        SaveActivePresetId((activePresetCombo.SelectedItem as ManaPreset)?.Id);
    }

    // #572: the largest tab in this batch -- 4 grouped sections
    // (profile/local model/brain provider/vision) in one AutoScroll
    // panel rather than sub-tabs, keeping this a single Settings tab per
    // the issue's own scope, matching windows-launcher's own single
    // "Model" settings panel covering the same 4 concerns.
    // #1426 stage 2: Models as one page of rows -- the providers (each API
    // account once), what uses them (the main model, the cloud fallback,
    // self-work escalation), this PC's own model, what it has cost, and the
    // engine underneath.
    private ProvidersPanel? providersPanel;
    private readonly ComboBox mainSource = new() { AccessibleName = "Main model" };
    private readonly TextBox mainModelBox = SettingsRows.Box("Main model's name", 180, "Its model name");
    private readonly Button mainSwitch = SettingsRows.Action("Switch", () => { });
    private readonly Label mainStatus = SettingsRows.Status();
    private readonly ComboBox fallbackSource = new() { AccessibleName = "Cloud fallback" };
    private readonly TextBox fallbackModelBox = SettingsRows.Box("Cloud fallback's model", 180, "Its model name");
    private readonly ComboBox fallbackWait = new() { AccessibleName = "Fall back" };
    private readonly Label fallbackStatus = SettingsRows.Status();
    private readonly ComboBox escalationSource = new() { AccessibleName = "Self-work escalation" };
    private readonly Label escalationStatus = SettingsRows.Status();
    private readonly RowList scanResults = new() { Height = 190, NameWidth = 260, AccessibleName = "Models found on this PC" };
    private Control? scanRow;
    private static readonly int[] FallbackWaits = [10, 30, 60, 0];
    private ManaModelStatus? modelStatus;

    internal ProvidersPanel? ProvidersPanel => providersPanel; // tests
    internal ComboBox MainSource => mainSource; // tests
    internal ComboBox FallbackSource => fallbackSource; // tests
    internal ComboBox EscalationSource => escalationSource; // tests

    // A use's choice: "this PC" / "off", or one of the providers.
    private sealed record Source(string? ProviderId, string Label)
    {
        public override string ToString() => Label;
    }

    private TabPage BuildModelsPage()
    {
        providersPanel = new ProvidersPanel(backendClient);
        providersPanel.Changed += () => _ = RefreshModelTabAsync();

        foreach (var combo in new[] { mainSource, fallbackSource, escalationSource, modelProfileCombo })
        {
            combo.DropDownStyle = ComboBoxStyle.DropDownList;
            combo.BackColor = DarkTheme.Panel;
            combo.ForeColor = DarkTheme.Text;
            combo.Width = 190;
        }
        modelProfileCombo.AccessibleName = "This PC's model";
        mainSource.SelectedIndexChanged += (_, _) => ShowMainFields();
        mainSwitch.Click += async (_, _) => await SwitchMainModelAsync();
        SettingsRows.MakePrimary(mainSwitch);

        fallbackSource.SelectionChangeCommitted += async (_, _) => await SaveFallbackAsync(askFirst: true);
        fallbackModelBox.Leave += async (_, _) =>
        {
            if (modelStatus is { } now && fallbackModelBox.Text.Trim() != now.Fallback.Model)
            {
                await SaveFallbackAsync(askFirst: false);
            }
        };
        var wait = SettingsRows.Choice("Fall back", ["After 10 seconds", "After 30 seconds", "After 60 seconds", "Only when it fails"], 3, fallbackWait);
        wait.SelectionChangeCommitted += async (_, _) => await SaveFallbackAsync(askFirst: false);
        escalationSource.SelectionChangeCommitted += async (_, _) => await SaveEscalationAsync();

        // This PC's model file: found on its own, picked, or found by a scan.
        selectedModelLabel.ForeColor = DarkTheme.Muted;
        selectedModelLabel.BackColor = Color.Transparent;
        selectedModelLabel.MaximumSize = new Size(300, 0);
        scanResults.ActionsFor = _ => [new("", "Use this one", () => SetModelPathAsync((scanResults.SelectedItems.Count > 0 ? scanResults.SelectedItems[0].Tag as ManaGgufFile : null)?.Path))];
        scanResults.ItemActivate += async (_, _) => await SetModelPathAsync((scanResults.SelectedItems.Count > 0 ? scanResults.SelectedItems[0].Tag as ManaGgufFile : null)?.Path);
        scanRow = new SettingsRow("Models found on this PC", "Pick one to use it", "scan gguf found", below: true, SettingsRows.RoundPanel(scanResults)) { Visible = false };

        var vram = new SettingsSwitch { AccessibleName = "Load into VRAM" };
        loadIntoVramSwitch = vram;
        vram.CheckedChanged += async (_, _) =>
        {
            if (!loadingRows)
            {
                await SaveLoadIntoVramAsync();
            }
        };

        visionModelPathBox.Width = visionMmprojPathBox.Width = 240;
        StyleTextBox(visionModelPathBox);
        StyleTextBox(visionMmprojPathBox);
        visionModelPathBox.ReadOnly = visionMmprojPathBox.ReadOnly = true;
        visionModelPathBox.PlaceholderText = visionMmprojPathBox.PlaceholderText = "Found on its own";

        var spending = new ApiSpendingPanel(backendClient, loadNow: false, showEscalation: false) { Dock = DockStyle.None, AutoSize = true, AutoScroll = false };
        apiSpending = spending;

        llamaBuildLabel.ForeColor = DarkTheme.Muted;
        llamaBuildLabel.BackColor = Color.Transparent;
        llamaBuildLabel.MaximumSize = new Size(320, 0);
        llamaUpdateButton.Click += async (_, _) => await UpdateLlamaBuildAsync(allowMissingDigest: false);
        llamaRollbackButton.Click += async (_, _) => await RollBackLlamaBuildAsync();
        DarkTheme.ApplyButton(llamaUpdateButton);
        DarkTheme.ApplyButton(llamaRollbackButton);
        llamaUpdateButton.AutoSize = llamaRollbackButton.AutoSize = true;

        codingModeStatus.ForeColor = DarkTheme.Muted;
        codingModeStatus.BackColor = Color.Transparent;
        codingModeCheck.CheckedChanged += async (_, _) => await SwitchCodingModeAsync();

        var parts = new List<Control> { SettingsRows.Section("Providers") };
        parts.AddRange(providersPanel.Rows);
        parts.Add(SettingsRows.Section("Uses"));
        parts.Add(new SettingsRow("Main model", "Who answers your chats. Switching restarts the model", "model brain local gguf qwen remote profile",
            mainStatus, mainSource, modelProfileCombo, mainModelBox, mainSwitch));
        parts.Add(new SettingsRow("Cloud fallback", "Used when this PC's model can't answer in time. Provider charges may apply", "fallback cloud remote",
            fallbackStatus, fallbackSource, fallbackModelBox));
        parts.Add(new SettingsRow("Fall back", "How long this PC's model gets first", "fallback wait timeout", wait));
        parts.Add(new SettingsRow("Self-work escalation", "Tried when her own attempts at an issue fail: DeepSeek Flash, then Pro, 5 runs a day, held at peak price", "escalation self-work deepseek",
            escalationStatus, escalationSource));
        parts.Add(SettingsRows.Section("This PC's model"));
        parts.Add(new SettingsRow("Model file", "Which file this PC's model loads", "gguf file local model scan browse",
            selectedModelLabel,
            SettingsRows.Action("Browse…", () => _ = BrowseForModelAsync()),
            SettingsRows.Action("Find on this PC", () => _ = ScanForModelsAsync()),
            SettingsRows.Action("Automatic", () => _ = SetModelPathAsync(null))));
        parts.Add(scanRow);
        parts.Add(new SettingsRow("Load straight into VRAM", "Saves about 4 GB of RAM. Applies next time the model loads", "gpu memory ram vram mmap", vram));
        parts.Add(new SettingsRow("Vision model", "What she sees your screen with", "vision eyes screen gguf",
            visionModelPathBox, SettingsRows.Action("Browse…", () => _ = PickVisionAsync(visionModelPathBox))));
        parts.Add(new SettingsRow("Vision projector", "The vision model's mmproj file", "vision mmproj projector",
            visionMmprojPathBox, SettingsRows.Action("Browse…", () => _ = PickVisionAsync(visionMmprojPathBox))));
        parts.Add(SettingsRows.Section("Spending"));
        parts.Add(new SettingsRow("API spending", "What her API use has cost", "spending cost money balance tokens price", below: true, spending));
        parts.Add(SettingsRows.Section("Engine"));
        parts.Add(new SettingsRow("Coding mode", "Loads the bigger 14B engineering model for coding work, and unloads it when you switch this off", "coding 14b engineering code programming",
            codingModeStatus, codingModeCheck));
        parts.Add(new SettingsRow("llama.cpp", "The engine her local models run on", "llama cpp build update rollback",
            llamaBuildLabel, SettingsRows.Action("Check for update", () => _ = CheckLlamaBuildAsync()), llamaUpdateButton, llamaRollbackButton));
        parts.Add(SettingsRows.Section("Tools"));
        parts.Add(new SettingsRow("Compare models", "Two models side by side on the same prompt", "compare models",
            SettingsRows.Action("Open…", () => new CompareModeForm(backendClient).Show())));
        parts.Add(new SettingsRow("Model web page", "llama.cpp's own page for this PC's model", "web ui llama",
            SettingsRows.Action("Open", ManaApplicationContext.OpenModelWebUi)));
        ShowMainFields();
        return SettingsRows.Page("Models", parts.ToArray());
    }

    private SettingsSwitch? loadIntoVramSwitch;
    private ApiSpendingPanel? apiSpending;

    // This PC's model picks a profile; a provider's needs a model name.
    private void ShowMainFields()
    {
        var local = (mainSource.SelectedItem as Source)?.ProviderId is null;
        modelProfileCombo.Visible = local;
        mainModelBox.Visible = !local;
    }

    // Each use's list: its "none" choice, then every provider added (for
    // escalation, only DeepSeek's).
    private static void FillSources(ComboBox combo, string none, IEnumerable<ManaProvider> providers, string? selected)
    {
        var choices = providers.Select(p => new Source(p.Id, p.Label)).Prepend(new Source(null, none)).ToList();
        combo.Items.Clear();
        combo.Items.AddRange(choices.ToArray<object>());
        combo.SelectedIndex = Math.Max(0, choices.FindIndex(c => c.ProviderId == selected));
        combo.Width = Math.Max(190, choices.Max(c => TextRenderer.MeasureText(c.Label, combo.Font).Width) + 30);
    }

    private async Task SwitchMainModelAsync()
    {
        var source = mainSource.SelectedItem as Source;
        try
        {
            if (source?.ProviderId is { } providerId)
            {
                if (mainModelBox.Text.Trim().Length == 0)
                {
                    mainStatus.Text = "Type the model's name first";
                    return;
                }
                await backendClient.SetMainModelAsync(providerId, mainModelBox.Text.Trim());
            }
            else
            {
                await backendClient.SetMainModelAsync(null, "");
                if (modelProfileCombo.SelectedItem is string profile && profile != modelStatus?.ActiveProfile)
                {
                    await backendClient.SetActiveProfileAsync(profile);
                }
            }
            mainStatus.Text = "Switched";
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            mainStatus.Text = BackendError.Describe(ex);
            return;
        }
        await RefreshModelTabAsync();
    }

    // Saved as it's picked. Picking a provider where it was off asks first:
    // a failed reply's chat goes to it.
    private async Task SaveFallbackAsync(bool askFirst)
    {
        if (modelStatus is null)
        {
            return;
        }
        var providerId = (fallbackSource.SelectedItem as Source)?.ProviderId;
        if (providerId is not null && fallbackModelBox.Text.Trim().Length == 0)
        {
            fallbackStatus.Text = "Type the model to use";
            fallbackModelBox.Focus();
            return;
        }
        if (askFirst && providerId is not null && !modelStatus.Fallback.Enabled
            && MessageBox.Show(FindForm(), $"When this PC's model can't answer in time, send the chat to {fallbackSource.Text}? Provider charges may apply.", "Cloud fallback", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
        {
            await RefreshModelTabAsync();
            return;
        }
        try
        {
            await backendClient.SetCloudFallbackProviderAsync(providerId, fallbackModelBox.Text.Trim(), FallbackWaits[Math.Max(0, fallbackWait.SelectedIndex)]);
            fallbackStatus.Text = "";
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            fallbackStatus.Text = BackendError.Describe(ex);
            return;
        }
        await RefreshModelTabAsync();
    }

    private async Task SaveEscalationAsync()
    {
        var providerId = (escalationSource.SelectedItem as Source)?.ProviderId;
        if (providerId is not null
            && MessageBox.Show(FindForm(), $"Let Mana send her failed self-work issues (the issue, what failed, and the code she reads) to {escalationSource.Text}? It costs money; spending shows below.", "Self-work escalation", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
        {
            await RefreshModelTabAsync();
            return;
        }
        try
        {
            await backendClient.SetEscalationAsync(providerId is not null, null, providerId);
            escalationStatus.Text = "";
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            escalationStatus.Text = BackendError.Describe(ex);
            return;
        }
        await RefreshModelTabAsync();
    }

    private async Task PickVisionAsync(TextBox target)
    {
        using var dialog = new OpenFileDialog { Filter = "GGUF models (*.gguf)|*.gguf", CheckFileExists = true };
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }
        target.Text = dialog.FileName;
        await SaveVisionSettingsAsync();
    }

    private async Task SwitchCodingModeAsync()
    {
        if (loadingCodingMode)
        {
            return;
        }
        try
        {
            if (codingModeCheck.Checked)
            {
                await backendClient.StartCodingSessionAsync();
            }
            else
            {
                await backendClient.StopCodingSessionAsync();
            }
        }
        catch (Exception ex)
        {
            codingModeStatus.Text = $"Couldn't switch it: {BackendError.Describe(ex)}";
            return;
        }
        await RefreshCodingModeAsync();
    }


    private static GroupBox NewGroup(string title)
    {
        var group = new GroupBox { Text = title, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(8), Margin = new Padding(8), BackColor = DarkTheme.Background, ForeColor = DarkTheme.Text };
        return group;
    }

    private static void StyleTextBox(TextBox box)
    {
        box.BackColor = DarkTheme.Panel2;
        box.ForeColor = DarkTheme.Text;
    }




    private async Task SaveLoadIntoVramAsync()
    {
        var loadIntoVram = loadIntoVramSwitch?.Checked == true;
        try
        {
            await backendClient.SetLoadIntoVramAsync(loadIntoVram);
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                loadingRows = true;
                loadIntoVramSwitch!.Checked = !loadIntoVram;
                loadingRows = false;
                MessageBox.Show(this, $"Failed to save the model loading setting: {ex.Message}", "Model", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    private async Task BrowseForModelAsync()
    {
        using var dialog = new OpenFileDialog { Filter = "GGUF models (*.gguf)|*.gguf", CheckFileExists = true };
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }
        await SetModelPathAsync(dialog.FileName);
    }

    private async Task ScanForModelsAsync()
    {
        ManaGgufScanResult result;
        try
        {
            result = await backendClient.ScanForModelsAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Scan failed: {ex.Message}", "Model", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        scanResults.ShowEntries(result.Files.Select(f => new RowList.Entry(f, System.IO.Path.GetFileName(f.Path), System.IO.Path.GetDirectoryName(f.Path) ?? "", ModelFitPill(f.Fit)?.Text ?? "")),
            null, "No model files found");
        scanRow!.Visible = true;
        if (result.Truncated)
        {
            MessageBox.Show(this, "The scan hit its time/directory budget and may not have covered everything.", "Model", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    // #625: node-bot's estimateModelFit value -> pill text/color; null
    // (unknown size or hardware) draws no pill rather than guessing.
    internal static (string Text, Color Color)? ModelFitPill(string? fit) => fit switch
    {
        "fits" => ("Fits", DarkTheme.Green),
        "slow" => ("May be slow", DarkTheme.Warn),
        "wont_fit" => ("Won't fit", Color.Firebrick),
        _ => null,
    };



    private async Task SetModelPathAsync(string? path)
    {
        try
        {
            await backendClient.SetModelPathAsync(path);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to set model path: {ex.Message}", "Model", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshModelTabAsync();
        }
    }








    private async Task SaveVisionSettingsAsync()
    {
        try
        {
            await backendClient.SetVisionSettingsAsync(visionModelPathBox.Text.Trim(), visionMmprojPathBox.Text.Trim());
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to save vision settings: {ex.Message}", "Model", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshModelTabAsync();
        }
    }


    // #693: the group's text -- current build, then the one most relevant
    // thing that happened: an update in progress, a failed update, an
    // automatic rollback, or a finished update.
    internal static string DescribeLlamaBuild(ManaLlamaBuildStatus status)
    {
        var current = status.CurrentBuild is int build
            ? $"Current build: b{build} ({status.CurrentVariant})"
            : $"Current build: unknown. {status.CurrentError}";
        var detail = status.JobState switch
        {
            "running" => $"Updating to {status.JobTag}: {status.JobStep}...",
            "failed" => $"Update to {status.JobTag} failed: {status.JobError}",
            _ when status.LastRollbackFrom is not null =>
                $"Rolled back automatically: {System.IO.Path.GetFileName(status.LastRollbackFrom)} failed to start ({status.LastRollbackReason}).",
            "done" => $"Updated to {status.JobTag}. llama-server restarts on it with the next reply.",
            _ => null,
        };
        return detail is null ? current : current + Environment.NewLine + detail;
    }

    // Returns null when the status couldn't be loaded (or the panel closed).
    private async Task<ManaLlamaBuildStatus?> RefreshLlamaBuildAsync()
    {
        ManaLlamaBuildStatus status;
        try
        {
            status = await backendClient.GetLlamaBuildStatusAsync();
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                llamaBuildLabel.Text = $"Failed to load: {BackendError.Describe(ex)}";
            }
            return null;
        }
        if (IsDisposed)
        {
            return null;
        }
        var running = status.JobState == "running";
        llamaBuildLabel.Text = DescribeLlamaBuild(status) + (llamaCheckNote is null ? "" : Environment.NewLine + llamaCheckNote);
        llamaUpdateButton.Enabled = llamaUpdateAvailable && !running;
        llamaRollbackButton.Enabled = status.Previous is not null && !running;
        return status;
    }

    private async Task CheckLlamaBuildAsync()
    {
        llamaBuildLabel.Text = "Checking GitHub for a newer llama.cpp build...";
        ManaLlamaBuildCheck check;
        try
        {
            check = await backendClient.CheckLlamaBuildUpdateAsync();
        }
        catch (Exception ex)
        {
            check = new ManaLlamaBuildCheck { Error = ex.Message };
        }
        if (IsDisposed)
        {
            return;
        }
        llamaUpdateAvailable = check.UpdateAvailable;
        llamaCheckNote = check.Error is not null
            ? $"Check failed: {check.Error}"
            : check.UpdateAvailable
                ? $"{check.LatestTag} is available." + (check.DigestAvailable ? "" : " It has no published checksum.")
                : $"Up to date (newest is {check.LatestTag}).";
        await RefreshLlamaBuildAsync();
    }

    private async Task UpdateLlamaBuildAsync(bool allowMissingDigest)
    {
        // Against a double click while the request is in flight; restored
        // below whenever this doesn't end up starting an update.
        llamaUpdateButton.Enabled = false;
        ManaLlamaBuildActionResult result;
        try
        {
            result = await backendClient.StartLlamaBuildUpdateAsync(allowMissingDigest);
        }
        catch (Exception ex)
        {
            result = new ManaLlamaBuildActionResult { Error = ex.Message };
        }
        if (IsDisposed)
        {
            return;
        }
        if (!result.Ok)
        {
            llamaUpdateButton.Enabled = llamaUpdateAvailable;
            if (result.Code == "digest_missing" && !allowMissingDigest)
            {
                var answer = MessageBox.Show(this, $"{result.Error}\n\nInstall it anyway, without checksum verification?", "llama.cpp update", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                if (answer == DialogResult.Yes && !IsDisposed)
                {
                    await UpdateLlamaBuildAsync(allowMissingDigest: true);
                }
                return;
            }
            MessageBox.Show(this, $"Update failed: {result.Error}", "llama.cpp update", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        llamaUpdateAvailable = false;
        llamaCheckNote = null;
        // The download/install runs in node-bot's background; poll its job
        // until it settles.
        ManaLlamaBuildStatus? status;
        do
        {
            status = await RefreshLlamaBuildAsync();
            if (status?.JobState != "running")
            {
                break;
            }
            await Task.Delay(1500);
        } while (!IsDisposed);
    }

    private async Task RollBackLlamaBuildAsync()
    {
        var answer = MessageBox.Show(this, "Switch back to the previous llama.cpp build? llama-server restarts on it with the next reply.", "llama.cpp", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (answer != DialogResult.Yes)
        {
            return;
        }
        ManaLlamaBuildActionResult result;
        try
        {
            result = await backendClient.RollBackLlamaBuildAsync();
        }
        catch (Exception ex)
        {
            result = new ManaLlamaBuildActionResult { Error = ex.Message };
        }
        if (IsDisposed)
        {
            return;
        }
        if (!result.Ok)
        {
            MessageBox.Show(this, $"Roll back failed: {result.Error}", "llama.cpp", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        await RefreshLlamaBuildAsync();
    }

    private async Task RefreshModelTabAsync()
    {
        ManaModelStatus status;
        ManaEscalationSettings escalation;
        try
        {
            status = await backendClient.GetModelStatusAsync();
            escalation = await backendClient.GetEscalationAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load model status. {ex.Message}");
            if (!IsDisposed)
            {
                mainStatus.Text = $"Couldn't load: {BackendError.Describe(ex)}";
            }
            return;
        }
        await (providersPanel?.ReloadAsync() ?? Task.CompletedTask);
        if (IsDisposed)
        {
            return;
        }
        modelStatus = status;
        var providers = providersPanel?.Providers ?? [];
        loadingRows = true;
        try
        {
            modelProfileCombo.Items.Clear();
            foreach (var key in status.Profiles.Keys)
            {
                modelProfileCombo.Items.Add(key);
            }
            if (status.ActiveProfile is not null && modelProfileCombo.Items.Contains(status.ActiveProfile))
            {
                modelProfileCombo.SelectedItem = status.ActiveProfile;
            }
            FillSources(mainSource, "This PC's model", providers, status.BrainType == "openai_compatible" ? status.BrainProviderId : null);
            mainModelBox.Text = status.BrainModel;
            FillSources(fallbackSource, "Off", providers, status.Fallback.Enabled ? status.Fallback.ProviderId : null);
            fallbackModelBox.Text = status.Fallback.Model;
            fallbackWait.SelectedIndex = Array.IndexOf(FallbackWaits, status.Fallback.TimeoutSeconds) is var wait and >= 0 ? wait : 3;
            FillSources(escalationSource, "Off", providers.Where(p => p.Preset == "deepseek"), escalation.Enabled ? escalation.ProviderId : null);
            if (loadIntoVramSwitch is not null)
            {
                loadIntoVramSwitch.Checked = status.LoadIntoVram;
            }
        }
        finally
        {
            loadingRows = false;
        }
        ShowMainFields();
        // #625: the hardware-based suggestion, while it's this PC's model.
        mainStatus.Text = status.BrainType != "openai_compatible" && status.RecommendedProfile is { } suggested && suggested != status.ActiveProfile
            ? $"Suggested here: {suggested}"
            : "";
        selectedModelLabel.Text = string.IsNullOrEmpty(status.SelectedModelPath) ? "Found on its own" : System.IO.Path.GetFileName(status.SelectedModelPath);
        railTips.SetToolTip(selectedModelLabel, status.SelectedModelPath ?? "");
        fallbackSource.Enabled = fallbackModelBox.Enabled = !status.LocalOnly;
        fallbackStatus.Text = status.LocalOnly ? "Off in local-only mode"
            : status.Fallback.Enabled && !status.Fallback.Active ? "Can't reach it right now"
            : "";
        escalationSource.Enabled = !escalation.LocalOnly;
        escalationStatus.Text = escalation.LocalOnly ? "Off in local-only mode"
            : !providers.Any(p => p.Preset == "deepseek") ? "Add DeepSeek above to use it"
            : "";
        visionModelPathBox.Text = status.VisionModelPath;
        visionMmprojPathBox.Text = status.VisionMmprojPath;
        await (apiSpending?.ReloadAsync() ?? Task.CompletedTask);
    }

    // #569: TOTP secret enrollment has no API endpoint at all
    // (mobile-routes.js reads MOBILE_TOTP_SECRET straight from the
    // environment) -- this tab covers pairing-code generation and device
    // management only, matching what the backend actually exposes.
    private TabPage BuildMobileDevicesTab()
    {
        mobileDevicesList.Dock = DockStyle.Fill;
        mobileDevicesList.View = View.Details;
        mobileDevicesList.FullRowSelect = true;
        mobileDevicesList.Columns.Add("Name", 140);
        mobileDevicesList.Columns.Add("Created", 140);
        mobileDevicesList.Columns.Add("Last seen", 140);
        mobileDevicesList.Columns.Add("Status", 70);
        DarkTheme.ApplyListView(mobileDevicesList);

        var pairButton = new Button { Text = "Generate Pairing Code" };
        var rotateButton = new Button { Text = "Rotate Token" };
        var revokeButton = new Button { Text = "Revoke" };
        DarkTheme.ApplyButton(pairButton);
        DarkTheme.ApplyButton(rotateButton);
        DarkTheme.ApplyButton(revokeButton);
        pairButton.Click += async (_, _) => await GeneratePairingCodeAsync();
        rotateButton.Click += async (_, _) => await RotateSelectedDeviceTokenAsync();
        revokeButton.Click += async (_, _) => await RevokeSelectedDeviceAsync();

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(pairButton);
        buttonRow.Controls.Add(rotateButton);
        buttonRow.Controls.Add(revokeButton);

        var page = new TabPage("Mobile Devices");
        page.Controls.Add(mobileDevicesList);
        page.Controls.Add(buttonRow);
        return page;
    }

    private async Task GeneratePairingCodeAsync()
    {
        (string Code, long ExpiresAtMs) result;
        try
        {
            result = await backendClient.RequestPairingCodeAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to generate a pairing code: {ex.Message}", "Generate Pairing Code", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        var expiresAt = DateTimeOffset.FromUnixTimeMilliseconds(result.ExpiresAtMs).ToLocalTime();
        MessageBox.Show(
            this,
            $"Pairing code: {result.Code}\n\nEnter this in the Mana mobile app. Expires at {expiresAt:T}.",
            "Generate Pairing Code",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    private async Task RotateSelectedDeviceTokenAsync()
    {
        if (mobileDevicesList.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)mobileDevicesList.SelectedItems[0].Tag!;
        var name = mobileDevicesList.SelectedItems[0].Text;
        var confirmed = MessageBox.Show(
            this,
            $"Rotate the token for \"{name}\"? The device will need to be re-paired with the new token.",
            "Rotate Token",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }

        string? token;
        try
        {
            token = await backendClient.RotateMobileDeviceTokenAsync(id);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to rotate token: {ex.Message}", "Rotate Token", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed || token is null)
        {
            return;
        }
        using (var reveal = new MobileTokenRevealDialog(name, token))
        {
            reveal.ShowDialog(this);
        }
        if (!IsDisposed)
        {
            await RefreshMobileDevicesAsync();
        }
    }

    private async Task RevokeSelectedDeviceAsync()
    {
        if (mobileDevicesList.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)mobileDevicesList.SelectedItems[0].Tag!;
        var name = mobileDevicesList.SelectedItems[0].Text;
        var confirmed = MessageBox.Show(
            this,
            $"Revoke \"{name}\"? It will no longer be able to reach Mana.",
            "Revoke Device",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }

        try
        {
            await backendClient.RevokeMobileDeviceAsync(id);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to revoke mobile device '{id}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMobileDevicesAsync();
        }
    }

    private async Task RefreshMobileDevicesAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaMobileDevice> devices;
        try
        {
            devices = await backendClient.GetMobileDevicesAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load mobile devices. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(mobileDevicesList, BackendError.Describe(ex));
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        mobileDevicesList.Items.Clear();
        foreach (var device in devices)
        {
            var item = new ListViewItem(device.Name) { Tag = device.Id };
            item.SubItems.Add(device.CreatedAt ?? "");
            item.SubItems.Add(device.LastSeenAt ?? "never");
            item.SubItems.Add(device.Revoked ? "revoked" : "active");
            mobileDevicesList.Items.Add(item);
        }
    }

    // #568: requires an admin-role API key entered as the Connection
    // tab's admin token (server.js's authMiddleware + requireAdmin) --
    // distinct from the MANA_ADMIN_SECRET value the memory-facts/skills/
    // approvals tabs above check for, since /admin/accounts uses a
    // different gate. A missing/wrong token surfaces the same
    // ShowLoadFailure placeholder those tabs already use.
    private TabPage BuildAccountsTab()
    {
        accountsList.Dock = DockStyle.Fill;
        accountsList.View = View.Details;
        accountsList.FullRowSelect = true;
        accountsList.Columns.Add("Email", 220);
        accountsList.Columns.Add("Role", 80);
        DarkTheme.ApplyListView(accountsList);

        var createButton = new Button { Text = "Create..." };
        var deleteButton = new Button { Text = "Revoke" };
        DarkTheme.ApplyButton(createButton);
        DarkTheme.ApplyButton(deleteButton);
        createButton.Click += async (_, _) => await CreateAccountAsync();
        deleteButton.Click += async (_, _) => await DeleteSelectedAccountAsync();

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(createButton);
        buttonRow.Controls.Add(deleteButton);

        var page = new TabPage("Accounts");
        page.Controls.Add(accountsList);
        page.Controls.Add(buttonRow);
        return page;
    }

    private async Task CreateAccountAsync()
    {
        using var dialog = new CreateAccountDialog();
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        string apiKey;
        try
        {
            apiKey = await backendClient.CreateAccountAsync(dialog.Email, dialog.Role);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to create account: {ex.Message}", "Create Account", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (IsDisposed)
        {
            return;
        }
        using (var reveal = new ApiKeyRevealDialog(dialog.Email, apiKey))
        {
            reveal.ShowDialog(this);
        }
        if (!IsDisposed)
        {
            await RefreshAccountsAsync();
        }
    }

    private async Task DeleteSelectedAccountAsync()
    {
        if (accountsList.SelectedItems.Count == 0)
        {
            return;
        }
        var userId = (string)accountsList.SelectedItems[0].Tag!;
        var email = accountsList.SelectedItems[0].Text;
        var confirmed = MessageBox.Show(
            this,
            $"Revoke account \"{email}\"? This cannot be undone.",
            "Revoke Account",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning) == DialogResult.Yes;
        if (!confirmed)
        {
            return;
        }

        try
        {
            await backendClient.DeleteAccountAsync(userId);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to revoke account '{userId}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshAccountsAsync();
        }
    }

    private async Task RefreshAccountsAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaAccount> accounts;
        try
        {
            accounts = await backendClient.GetAccountsAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load accounts. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(accountsList, BackendError.Describe(ex));
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        accountsList.Items.Clear();
        foreach (var account in accounts)
        {
            var item = new ListViewItem(account.Email) { Tag = account.UserId };
            item.SubItems.Add(account.Role);
            accountsList.Items.Add(item);
        }
    }

    // #950 (#906): the email and calendar accounts Mana reads, through
    // node-bot's /mail-calendar. I type my own app passwords here; node-bot
    // saves them DPAPI-encrypted and never sends them back, so a blank
    // password or calendar address keeps the saved one.
    // docs/mail_calendar_setup.md has the steps per provider.
    private readonly TextBox mailHostBox = new() { Width = 260, PlaceholderText = "imap.gmail.com" };
    private readonly TextBox mailPortBox = new() { Width = 60 };
    private readonly TextBox mailUserBox = new() { Width = 260 };
    private readonly TextBox mailPasswordBox = new() { Width = 260, UseSystemPasswordChar = true };
    private readonly TextBox mailMailboxBox = new() { Width = 260 };
    private readonly Label mailStatusLabel = new() { AutoSize = true, MaximumSize = new Size(520, 0) };
    private readonly TextBox calendarUrlBox = new() { Width = 420 };
    private readonly TextBox calendarUserBox = new() { Width = 260, PlaceholderText = "blank for an iCal feed" };
    private readonly TextBox calendarPasswordBox = new() { Width = 260, UseSystemPasswordChar = true };
    private readonly Label calendarStatusLabel = new() { AutoSize = true, MaximumSize = new Size(520, 0) };

    private TabPage BuildMailCalendarTab()
    {
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, BackColor = DarkTheme.Background };
        layout.Controls.Add(BuildMailCalendarGroup(
            "Email (IMAP, read-only)",
            "email",
            new (string, TextBox)[] { ("Server", mailHostBox), ("Port", mailPortBox), ("Username", mailUserBox), ("App password", mailPasswordBox), ("Mailbox", mailMailboxBox) },
            mailStatusLabel,
            () => new { kind = "email", host = mailHostBox.Text.Trim(), port = mailPortBox.Text.Trim(), user = mailUserBox.Text.Trim(), password = mailPasswordBox.Text, mailbox = mailMailboxBox.Text.Trim() }));
        layout.Controls.Add(BuildMailCalendarGroup(
            "Calendar (CalDAV, or a Google/Outlook iCal feed)",
            "calendar",
            new (string, TextBox)[] { ("Address", calendarUrlBox), ("Username", calendarUserBox), ("App password", calendarPasswordBox) },
            calendarStatusLabel,
            () => new { kind = "calendar", url = calendarUrlBox.Text.Trim(), user = calendarUserBox.Text.Trim(), password = calendarPasswordBox.Text }));
        layout.Controls.Add(new Label
        {
            Text = "Mana reads these only when I ask, and adds a calendar event only after I approve it. An iCal feed (Google's secret address, Outlook's published calendar) is read-only: leave its Username blank.",
            AutoSize = true,
            MaximumSize = new Size(520, 0),
            ForeColor = DarkTheme.Muted,
            Margin = new Padding(8),
        });
        var guide = new Button { Text = "Setup steps per provider", AutoSize = true, Margin = new Padding(8, 0, 8, 8) };
        DarkTheme.ApplyButton(guide);
        guide.Click += (_, _) => OpenRepoDoc("docs", "mail_calendar_setup.md"); // #1127
        layout.Controls.Add(guide);
        return new TabPage("Calendar & Email") { Controls = { layout } };
    }

    private GroupBox BuildMailCalendarGroup(string title, string kind, (string Label, TextBox Box)[] rows, Label status, Func<object> change)
    {
        var group = NewGroup(title);
        var table = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, BackColor = DarkTheme.Background };
        foreach (var (label, box) in rows)
        {
            StyleTextBox(box);
            box.AccessibleName = label;
            table.Controls.Add(new Label { Text = label, AutoSize = true, ForeColor = DarkTheme.Text, Anchor = AnchorStyles.Left, Margin = new Padding(3, 6, 3, 3) });
            table.Controls.Add(box);
        }
        var saveButton = new Button { Text = "Save and test", AutoSize = true };
        var removeButton = new Button { Text = "Remove", AutoSize = true };
        DarkTheme.ApplyButton(saveButton);
        DarkTheme.ApplyButton(removeButton);
        saveButton.Click += async (_, _) => await SaveMailCalendarAsync(kind, change(), status, test: true);
        removeButton.Click += async (_, _) => await SaveMailCalendarAsync(kind, new { kind, clear = true }, status, test: false);
        var buttonRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(saveButton);
        buttonRow.Controls.Add(removeButton);
        status.ForeColor = DarkTheme.Muted;
        var stack = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, WrapContents = false, BackColor = DarkTheme.Background };
        stack.Controls.Add(table);
        stack.Controls.Add(buttonRow);
        stack.Controls.Add(status);
        group.Controls.Add(stack);
        return group;
    }

    private async Task SaveMailCalendarAsync(string kind, object change, Label status, bool test)
    {
        try
        {
            ShowMailCalendar(await backendClient.UpdateMailCalendarAsync(change));
            if (!test || IsDisposed)
            {
                return;
            }
            status.ForeColor = DarkTheme.Muted;
            status.Text = "Saved. Testing...";
            var (ok, error) = await backendClient.TestMailCalendarAsync(kind);
            if (!IsDisposed)
            {
                status.ForeColor = ok ? DarkTheme.Green : Color.Firebrick;
                status.Text = ok ? "Saved and connected." : $"Saved, but the test failed: {error}";
            }
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                status.ForeColor = Color.Firebrick;
                status.Text = $"Failed: {ex.Message}";
            }
        }
    }

    private async Task RefreshMailCalendarAsync()
    {
        try
        {
            ShowMailCalendar(await backendClient.GetMailCalendarAsync());
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                mailStatusLabel.Text = calendarStatusLabel.Text = $"Failed to load: {BackendError.Describe(ex)}";
            }
        }
    }

    // Fills in what node-bot sends back (never a password or feed address)
    // and says what's set up.
    private void ShowMailCalendar(ManaMailCalendar state)
    {
        if (IsDisposed)
        {
            return;
        }
        const string unreadable = "The saved settings can't be read on this Windows account: enter them again.";
        var email = state.Email;
        mailHostBox.Text = email?.Host ?? "";
        mailPortBox.Text = email is { Port: > 0 } ? email.Port.ToString() : "993";
        mailUserBox.Text = email?.User ?? "";
        mailMailboxBox.Text = email?.Mailbox ?? "INBOX";
        mailPasswordBox.Clear();
        mailPasswordBox.PlaceholderText = email?.PasswordSet == true ? "saved (blank keeps it)" : "";
        mailStatusLabel.ForeColor = DarkTheme.Muted;
        mailStatusLabel.Text = email is null ? "Not set up." : email.Unreadable ? unreadable : $"Set up: {email.User} on {email.Host}.";

        var calendar = state.Calendar;
        calendarUserBox.Text = calendar?.User ?? "";
        calendarUrlBox.Clear();
        calendarUrlBox.PlaceholderText = calendar is { Unreadable: false } ? "saved (blank keeps it)" : "https://...";
        calendarPasswordBox.Clear();
        calendarPasswordBox.PlaceholderText = calendar?.PasswordSet == true ? "saved (blank keeps it)" : "";
        calendarStatusLabel.ForeColor = DarkTheme.Muted;
        calendarStatusLabel.Text = calendar is null
            ? "Not set up."
            : calendar.Unreadable
                ? unreadable
                : calendar.ReadOnly
                    ? $"Set up: iCal feed from {calendar.Host} (read-only)."
                    : $"Set up: {calendar.User} on {calendar.Host}.";
    }

    // #567: registration goes through the approval gate server-side, not
    // an immediate write (see RegisterMcpServerAsync's own comment) --
    // this tab has no toggle/edit action, only Add and Delete, matching
    // that: there's nothing here to PATCH, and a pending registration is
    // decided from the existing Approvals tab, not this one.
    private TabPage BuildMcpServersTab()
    {
        mcpServersList.Dock = DockStyle.Fill;
        mcpServersList.View = View.Details;
        mcpServersList.FullRowSelect = true;
        mcpServersList.Columns.Add("Name", 120);
        mcpServersList.Columns.Add("Transport", 200);
        mcpServersList.Columns.Add("Allowed tools", 200);
        DarkTheme.ApplyListView(mcpServersList);

        var addButton = new Button { Text = "Register..." };
        var deleteButton = new Button { Text = "Remove" };
        DarkTheme.ApplyButton(addButton);
        DarkTheme.ApplyButton(deleteButton);
        addButton.Click += async (_, _) => await RegisterMcpServerAsync();
        deleteButton.Click += async (_, _) => await DeleteSelectedMcpServerAsync();

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(addButton);
        buttonRow.Controls.Add(deleteButton);

        var page = new TabPage("MCP Clients");
        page.Controls.Add(mcpServersList);
        page.Controls.Add(buttonRow);
        return page;
    }

    private async Task RegisterMcpServerAsync()
    {
        using var dialog = new McpServerDialog();
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        string status;
        try
        {
            status = await backendClient.RegisterMcpServerAsync(dialog.ServerName, dialog.TransportKind, dialog.Command, dialog.Args, dialog.EnvAllowlist, dialog.Url, dialog.AllowedTools);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to register MCP server: {ex.Message}", "Register MCP Server", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            MessageBox.Show(
                this,
                status == "pending" ? "Registration submitted -- approve it from the Approvals tab." : $"Registration status: {status}",
                "Register MCP Server",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            await RefreshMcpServersAsync();
        }
    }

    private async Task DeleteSelectedMcpServerAsync()
    {
        if (mcpServersList.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)mcpServersList.SelectedItems[0].Tag!;
        try
        {
            await backendClient.DeleteMcpServerAsync(id);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to remove MCP server '{id}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshMcpServersAsync();
        }
    }

    private async Task RefreshMcpServersAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaMcpServer> servers;
        try
        {
            servers = await backendClient.GetMcpServersAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load MCP servers. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(mcpServersList, BackendError.Describe(ex));
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        mcpServersList.Items.Clear();
        foreach (var server in servers)
        {
            var item = new ListViewItem(server.Name) { Tag = server.Id };
            item.SubItems.Add(server.TransportSummary);
            item.SubItems.Add(server.AllowedTools);
            mcpServersList.Items.Add(item);
        }
    }

    // #566: PATCH /hooks/:id only settles `enabled` (pause/resume) --
    // matches node-bot's own narrow scope for that route (hooks-store.js's
    // setRuleEnabled), so this tab's checkbox is the one edit action, same
    // shape as the Plugins tab's own enable/disable toggle above.
    private TabPage BuildHooksTab()
    {
        hooksList.Dock = DockStyle.Fill;
        hooksList.View = View.Details;
        hooksList.CheckBoxes = true;
        hooksList.FullRowSelect = true;
        hooksList.Columns.Add("Tool", 150);
        hooksList.Columns.Add("Phase", 60);
        hooksList.Columns.Add("Action", 100);
        hooksList.Columns.Add("Path filter", 140);
        hooksList.Columns.Add("Last run", 70);
        hooksList.ItemChecked += OnHookChecked;
        DarkTheme.ApplyListView(hooksList);

        var addButton = new Button { Text = "Add..." };
        var deleteButton = new Button { Text = "Delete" };
        DarkTheme.ApplyButton(addButton);
        DarkTheme.ApplyButton(deleteButton);
        addButton.Click += async (_, _) => await AddHookAsync();
        deleteButton.Click += async (_, _) => await DeleteSelectedHookAsync();

        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 32, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        buttonRow.Controls.Add(addButton);
        buttonRow.Controls.Add(deleteButton);

        var page = new TabPage("Hooks");
        page.Controls.Add(hooksList);
        page.Controls.Add(buttonRow);
        return page;
    }

    private async void OnHookChecked(object? sender, ItemCheckedEventArgs e)
    {
        // Same reentrancy guard as OnPluginChecked above -- suppressed
        // while RefreshHooksAsync is setting each item's initial Checked
        // state from the server's own value.
        if (populatingHooks)
        {
            return;
        }
        var id = (string)e.Item.Tag!;
        try
        {
            await backendClient.SetHookEnabledAsync(id, e.Item.Checked);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to toggle hook '{id}'. {ex.Message}");
        }
    }

    private async Task AddHookAsync()
    {
        using var dialog = new HookRuleDialog();
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            await backendClient.CreateHookAsync(dialog.Phase, dialog.Action, dialog.ToolName, dialog.PathContains, dialog.Command, dialog.Args, dialog.Reason);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"Failed to add hook rule: {ex.Message}", "Add Hook Rule", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        if (!IsDisposed)
        {
            await RefreshHooksAsync();
        }
    }

    private async Task DeleteSelectedHookAsync()
    {
        if (hooksList.SelectedItems.Count == 0)
        {
            return;
        }
        var id = (string)hooksList.SelectedItems[0].Tag!;
        try
        {
            await backendClient.DeleteHookAsync(id);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to delete hook '{id}'. {ex.Message}");
            return;
        }
        if (!IsDisposed)
        {
            await RefreshHooksAsync();
        }
    }

    private async Task RefreshHooksAsync()
    {
        System.Collections.Generic.IReadOnlyList<ManaHookRule> hooks;
        try
        {
            hooks = await backendClient.GetHooksAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SettingsPanel: failed to load hooks. {ex.Message}");
            if (!IsDisposed)
            {
                ShowLoadFailure(hooksList, BackendError.Describe(ex));
            }
            return;
        }
        if (IsDisposed)
        {
            return;
        }

        populatingHooks = true;
        try
        {
            hooksList.Items.Clear();
            foreach (var hook in hooks)
            {
                var item = new ListViewItem(hook.ToolName) { Tag = hook.Id, Checked = hook.Enabled };
                item.SubItems.Add(hook.Phase);
                item.SubItems.Add(hook.Action);
                item.SubItems.Add(hook.PathContains ?? "");
                item.SubItems.Add(hook.LastRunOk switch { true => "ok", false => "failed", null => "" });
                hooksList.Items.Add(item);
            }
        }
        finally
        {
            populatingHooks = false;
        }
    }

    // #1336: Export all my data as a zip archive, or wipe data completely / by category.
    private TabPage BuildPrivacyTab()
    {
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            AutoSize = true,
            Padding = new Padding(12),
        };

        var titleLabel = new Label
        {
            Text = "Data & Privacy",
            UseMnemonic = false,
            Font = new Font(Font.FontFamily, 12, FontStyle.Bold),
            ForeColor = DarkTheme.Text,
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 8),
        };
        layout.Controls.Add(titleLabel);

        var introLabel = new Label
        {
            Text = "Export your personal data or permanently delete stored history, memories, and voice samples.",
            ForeColor = DarkTheme.Muted,
            AutoSize = true,
            MaximumSize = new Size(600, 0),
            Margin = new Padding(0, 0, 0, 16),
        };
        layout.Controls.Add(introLabel);

        // Section 1: Export Everything
        var exportHeader = new Label
        {
            Text = "Export All Data",
            Font = new Font(Font.FontFamily, 10, FontStyle.Bold),
            ForeColor = DarkTheme.Text,
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 4),
        };
        var exportDesc = new Label
        {
            Text = "Create a single ZIP archive containing all chat sessions (JSON and Markdown), memory facts, vault sync records, voice samples, generated artifacts, and settings (credentials redacted).",
            ForeColor = DarkTheme.Muted,
            AutoSize = true,
            MaximumSize = new Size(600, 0),
            Margin = new Padding(0, 0, 0, 8),
        };
        var exportStatus = new Label
        {
            AutoSize = true,
            ForeColor = DarkTheme.Muted,
            Margin = new Padding(8, 6, 0, 0),
        };

        var exportButton = new Button
        {
            Text = "Export everything...",
            AccessibleName = "Export everything",
            AutoSize = true,
            Padding = new Padding(8, 4, 8, 4),
        };
        DarkTheme.ApplyButton(exportButton);
        exportButton.Click += async (_, _) =>
        {
            using var saveDialog = new SaveFileDialog
            {
                Title = "Export all Mana data",
                Filter = "ZIP archive (*.zip)|*.zip",
                FileName = $"mana-export-{DateTime.UtcNow:yyyy-MM-dd}.zip",
            };
            if (saveDialog.ShowDialog(this) != DialogResult.OK)
            {
                return;
            }

            exportButton.Enabled = false;
            exportStatus.ForeColor = DarkTheme.Muted;
            exportStatus.Text = "Exporting data archive...";
            try
            {
                var zipBytes = await backendClient.ExportAllDataAsync();
                await File.WriteAllBytesAsync(saveDialog.FileName, zipBytes);
                exportStatus.ForeColor = DarkTheme.Green;
                exportStatus.Text = $"Export saved successfully ({zipBytes.Length / 1024:N0} KB).";
            }
            catch (Exception ex)
            {
                exportStatus.ForeColor = Color.Firebrick;
                exportStatus.Text = $"Export failed: {ex.Message}";
            }
            finally
            {
                exportButton.Enabled = true;
            }
        };

        layout.Controls.Add(exportHeader);
        layout.Controls.Add(exportDesc);
        var exportRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        exportRow.Controls.Add(exportButton);
        exportRow.Controls.Add(exportStatus);
        layout.Controls.Add(exportRow);

        // Section 2: Delete Everything
        var deleteHeader = new Label
        {
            Text = "Delete Everything",
            Font = new Font(Font.FontFamily, 10, FontStyle.Bold),
            ForeColor = Color.IndianRed,
            AutoSize = true,
            Margin = new Padding(0, 20, 0, 4),
        };
        var deleteDesc = new Label
        {
            Text = "Permanently wipes all chat history, memory facts, entity indexes, vault sync state, voice samples, caches, and logs. This leaves Mana in a clean first-run state. This cannot be undone.",
            ForeColor = DarkTheme.Muted,
            AutoSize = true,
            MaximumSize = new Size(600, 0),
            Margin = new Padding(0, 0, 0, 8),
        };
        var deleteStatus = new Label
        {
            AutoSize = true,
            ForeColor = DarkTheme.Muted,
            Margin = new Padding(8, 6, 0, 0),
        };

        var deleteAllButton = new Button
        {
            Text = "Delete everything...",
            AccessibleName = "Delete everything",
            AutoSize = true,
            ForeColor = Color.IndianRed,
            Padding = new Padding(8, 4, 8, 4),
        };
        DarkTheme.ApplyButton(deleteAllButton);
        deleteAllButton.Click += async (_, _) =>
        {
            using var prompt = new TextPromptDialog(
                "Delete everything",
                "Type 'delete-everything' to permanently delete all data and reset to first-run state:",
                ""
            );
            if (prompt.ShowDialog(this) != DialogResult.OK)
            {
                return;
            }

            var input = prompt.Value.Trim();
            if (input != "delete-everything")
            {
                MessageBox.Show(this, "Confirmation text did not match 'delete-everything'. Deletion canceled.", "Delete Canceled", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            deleteAllButton.Enabled = false;
            deleteStatus.ForeColor = DarkTheme.Muted;
            deleteStatus.Text = "Wiping all data...";
            try
            {
                var success = await backendClient.DeleteAllDataAsync("delete-everything");
                if (success)
                {
                    deleteStatus.ForeColor = DarkTheme.Green;
                    deleteStatus.Text = "All data wiped successfully. Mana is in first-run state.";
                    MessageBox.Show(this, "All personal data has been wiped. Mana is now in first-run state.", "Data Deleted", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    await RefreshAllAsync();
                }
                else
                {
                    deleteStatus.ForeColor = Color.Firebrick;
                    deleteStatus.Text = "Failed to wipe data (backend returned an error).";
                }
            }
            catch (Exception ex)
            {
                deleteStatus.ForeColor = Color.Firebrick;
                deleteStatus.Text = $"Failed to wipe data: {ex.Message}";
            }
            finally
            {
                deleteAllButton.Enabled = true;
            }
        };

        layout.Controls.Add(deleteHeader);
        layout.Controls.Add(deleteDesc);
        var deleteRow = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, BackColor = DarkTheme.Background };
        deleteRow.Controls.Add(deleteAllButton);
        deleteRow.Controls.Add(deleteStatus);
        layout.Controls.Add(deleteRow);

        // Section 3: Delete by Category
        var categoryHeader = new Label
        {
            Text = "Delete by Category",
            Font = new Font(Font.FontFamily, 10, FontStyle.Bold),
            ForeColor = DarkTheme.Text,
            AutoSize = true,
            Margin = new Padding(0, 20, 0, 4),
        };
        var categoryDesc = new Label
        {
            Text = "Selectively remove specific data categories without affecting the rest of your profile.",
            ForeColor = DarkTheme.Muted,
            AutoSize = true,
            MaximumSize = new Size(600, 0),
            Margin = new Padding(0, 0, 0, 8),
        };
        layout.Controls.Add(categoryHeader);
        layout.Controls.Add(categoryDesc);

        var categories = new (string Key, string Title, string Desc)[]
        {
            ("voice", "Voice Data", "Voice samples, speaker profiles, and acoustic enrolment recordings."),
            ("chats", "Chat History", "All conversation sessions, message histories, and transcripts."),
            ("memory", "Memory Facts", "Learned memory facts, entity indexes, and emotional states."),
            ("vault", "Vault Sync State", "Obsidian vault synchronization state and cached sync notes."),
            ("cache-logs", "Caches & Logs", "Tool execution logs, temporary debug files, and upload caches."),
        };

        foreach (var (key, title, desc) in categories)
        {
            layout.Controls.Add(BuildCategoryDeleteRow(key, title, desc));
        }

        return new TabPage("Privacy") { Controls = { layout } };
    }

    private FlowLayoutPanel BuildCategoryDeleteRow(string categoryKey, string categoryTitle, string categoryDesc)
    {
        var row = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.LeftToRight,
            BackColor = DarkTheme.Background,
            Margin = new Padding(0, 4, 0, 4),
        };

        var btn = new Button
        {
            Text = $"Delete {categoryTitle}...",
            AccessibleName = $"Delete {categoryTitle}",
            AutoSize = true,
            Padding = new Padding(6, 2, 6, 2),
            UseMnemonic = false, // "Caches & Logs" keeps its "&"
        };
        DarkTheme.ApplyButton(btn);

        var lbl = new Label
        {
            Text = categoryDesc,
            ForeColor = DarkTheme.Muted,
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(8, 6, 0, 0),
        };

        var status = new Label
        {
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(8, 6, 0, 0),
        };

        btn.Click += async (_, _) =>
        {
            var expected = $"delete-{categoryKey}";
            using var prompt = new TextPromptDialog(
                $"Delete {categoryTitle}",
                $"Type '{expected}' to permanently delete {categoryTitle.ToLowerInvariant()}:",
                ""
            );
            if (prompt.ShowDialog(this) != DialogResult.OK)
            {
                return;
            }

            var input = prompt.Value.Trim();
            if (input != expected && input != "delete-everything")
            {
                MessageBox.Show(this, $"Confirmation text did not match '{expected}'. Deletion canceled.", "Delete Canceled", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            btn.Enabled = false;
            status.ForeColor = DarkTheme.Muted;
            status.Text = "Deleting...";
            try
            {
                var success = await backendClient.DeleteDataCategoryAsync(categoryKey, input);
                if (success)
                {
                    status.ForeColor = DarkTheme.Green;
                    status.Text = "Deleted.";
                    if (categoryKey == "memory")
                    {
                        await RefreshMemoryFactsAsync();
                    }
                }
                else
                {
                    status.ForeColor = Color.Firebrick;
                    status.Text = "Failed.";
                }
            }
            catch (Exception ex)
            {
                status.ForeColor = Color.Firebrick;
                status.Text = $"Error: {ex.Message}";
            }
            finally
            {
                btn.Enabled = true;
            }
        };

        row.Controls.Add(btn);
        row.Controls.Add(status);
        row.Controls.Add(lbl);
        return row;
    }
}
