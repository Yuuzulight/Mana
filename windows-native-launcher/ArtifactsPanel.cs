using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Net;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1120: the chat window's Artifacts tool (rail panel, #1118). Lists this
// chat's artifacts first, then other chats', newest first -- one row per
// version thread, its latest version -- and draws the selected one right
// here with ArtifactView (Folio for the HTML ArtifactClassifier allows),
// with Prev/Next through its versions. The artifacts themselves live in
// ArtifactViewerForm, which also stays the "Open in its own window".
internal sealed class ArtifactsPanel : UserControl
{
    private readonly ArtifactViewerForm store;
    private readonly Func<string?> currentSessionId;
    private readonly ListView list = new() { Dock = DockStyle.Top, Height = 170, View = View.Details, FullRowSelect = true, HideSelection = false, MultiSelect = false, HeaderStyle = ColumnHeaderStyle.Nonclickable, AccessibleName = "Artifacts" };
    private readonly ListViewGroup thisChat = new("This chat");
    private readonly ListViewGroup otherChats = new("Other chats");
    private readonly ArtifactView view = new() { Dock = DockStyle.Fill };
    private readonly Label versionLabel = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = DarkTheme.Text, AutoEllipsis = true };
    private readonly Label noteLabel = new() { Dock = DockStyle.Top, AutoSize = true, ForeColor = DarkTheme.Muted, Padding = new Padding(6, 4, 6, 4) };
    private readonly Button prevButton = new() { Text = "<", Dock = DockStyle.Left, Width = 32, AccessibleName = "Previous version" };
    private readonly Button nextButton = new() { Text = ">", Dock = DockStyle.Right, Width = 32, AccessibleName = "Next version" };
    private readonly Button openWindowButton = new() { Text = "Open in its own window", AutoSize = true };
    private readonly Button browserButton = new() { Text = "Open in browser", AutoSize = true };
    private readonly Button copyButton = new() { Text = "Copy source", AutoSize = true };
    private readonly Button saveButton = new() { Text = "Save as...", AutoSize = true };
    private List<ArtifactEntry> thread = new();
    private int index;
    private bool selecting; // selection set in code, which shows the entry itself

    public ArtifactsPanel(ArtifactViewerForm store, Func<string?> currentSessionId)
    {
        this.store = store;
        this.currentSessionId = currentSessionId;
        BackColor = DarkTheme.Background;

        list.Columns.Add("Title", 150);
        list.Columns.Add("Type", 70);
        list.Columns.Add("Time", 60);
        list.Groups.Add(thisChat);
        list.Groups.Add(otherChats);
        DarkTheme.ApplyListView(list);
        list.SelectedIndexChanged += (_, _) =>
        {
            if (!selecting && list.SelectedItems.Count > 0)
            {
                ShowEntry((ArtifactEntry)list.SelectedItems[0].Tag!);
            }
        };
        list.ClientSizeChanged += (_, _) => list.Columns[0].Width = Math.Max(60, list.ClientSize.Width - list.Columns[1].Width - list.Columns[2].Width);

        foreach (var button in new[] { prevButton, nextButton, openWindowButton, browserButton, copyButton, saveButton })
        {
            DarkTheme.ApplyButton(button);
        }
        prevButton.Click += (_, _) => Step(-1);
        nextButton.Click += (_, _) => Step(1);
        openWindowButton.Click += (_, _) => store.Open(thread[index]);
        browserButton.Click += (_, _) => HtmlArtifact.OpenInBrowser(Current.Content);
        copyButton.Click += (_, _) =>
        {
            try
            {
                Clipboard.SetText(Current.Content);
            }
            catch (System.Runtime.InteropServices.ExternalException ex)
            {
                Console.WriteLine($"ArtifactsPanel: couldn't copy to the clipboard. {ex.Message}");
            }
        };
        saveButton.Click += (_, _) => ArtifactViewerForm.SaveAs(Current);

        var actions = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, WrapContents = true, Padding = new Padding(4) };
        actions.Controls.AddRange(new Control[] { openWindowButton, browserButton, copyButton, saveButton });
        var versions = new Panel { Dock = DockStyle.Top, Height = 28, Padding = new Padding(4, 2, 4, 2) };
        versions.Controls.Add(versionLabel);
        versions.Controls.Add(prevButton);
        versions.Controls.Add(nextButton);

        // Last added docks first: the list on top, then the actions, the
        // version row and any note, and the artifact fills the rest.
        Controls.Add(view);
        Controls.Add(noteLabel);
        Controls.Add(versions);
        Controls.Add(actions);
        Controls.Add(list);

        store.Added += OnAdded;
        // The open chat may have changed while it was hidden.
        VisibleChanged += (_, _) =>
        {
            if (Visible)
            {
                RefreshList();
            }
        };
        RefreshList();
    }

    private VersionedArtifact Current => thread[index].Artifact;

    // One row per version thread (its latest version): this chat's first,
    // then the rest, each newest first.
    internal static List<ArtifactEntry> Order(IEnumerable<ArtifactEntry> entries, string? sessionId) =>
        entries.GroupBy(e => e.Artifact.ThreadId)
            .Select(thread => thread.Last())
            .OrderByDescending(e => sessionId is not null && e.SessionId == sessionId)
            .ThenByDescending(e => e.At)
            .ToList();

    // An HTML page's <title>, else its first non-blank line.
    internal static string Title(VersionedArtifact artifact)
    {
        if (artifact.Language == "html" && Regex.Match(artifact.Content, @"<title[^>]*>\s*([^<]+?)\s*</title>", RegexOptions.IgnoreCase) is { Success: true } title)
        {
            return WebUtility.HtmlDecode(title.Groups[1].Value);
        }
        var line = artifact.Content.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0) ?? artifact.Language;
        return line.Length > 60 ? line[..60] + "…" : line;
    }

    // Selects the entry's row and shows it (a new artifact while the panel is open).
    public void Select(ArtifactEntry entry)
    {
        RefreshList();
        var row = list.Items.Cast<ListViewItem>().FirstOrDefault(i => ((ArtifactEntry)i.Tag!).Artifact.ThreadId == entry.Artifact.ThreadId);
        if (row is not null)
        {
            selecting = true;
            row.Selected = true;
            selecting = false;
            row.EnsureVisible();
        }
        ShowEntry(entry);
    }

    internal IEnumerable<string> RowsForTests => list.Items.Cast<ListViewItem>().Select(i => $"{i.Group?.Header}: {i.Text}");
    internal string VersionText => versionLabel.Text;

    private void OnAdded(ArtifactEntry entry) => RefreshList();

    private void RefreshList()
    {
        var selectedThread = list.SelectedItems.Count > 0 ? ((ArtifactEntry)list.SelectedItems[0].Tag!).Artifact.ThreadId : null;
        var sessionId = currentSessionId();
        selecting = true;
        list.BeginUpdate();
        list.Items.Clear();
        foreach (var entry in Order(store.Entries, sessionId))
        {
            var row = new ListViewItem(new[] { Title(entry.Artifact), entry.Artifact.Language, entry.At.ToString("t") })
            {
                Tag = entry,
                Group = sessionId is not null && entry.SessionId == sessionId ? thisChat : otherChats,
                ToolTipText = entry.At.ToString("f"),
            };
            list.Items.Add(row);
            row.Selected = entry.Artifact.ThreadId == selectedThread;
        }
        list.EndUpdate();
        if (list.Items.Count > 0 && list.SelectedItems.Count == 0)
        {
            list.Items[0].Selected = true;
            selectedThread = null; // a new selection, shown below
        }
        selecting = false;
        if (list.Items.Count == 0)
        {
            thread = new();
            view.Visible = false;
            noteLabel.Text = "No artifacts yet. When Mana writes a page, a diagram or a long block of code, it shows up here.";
            noteLabel.Visible = true;
            EnableActions(false);
        }
        else
        {
            // The same version as before (its thread may have grown), or the first row.
            ShowEntry(selectedThread is null ? (ArtifactEntry)list.Items[0].Tag! : thread[index]);
        }
    }

    private void ShowEntry(ArtifactEntry entry)
    {
        thread = store.ThreadOf(entry);
        index = thread.IndexOf(entry);
        Render();
    }

    private void Step(int delta)
    {
        var next = index + delta;
        if (next >= 0 && next < thread.Count)
        {
            index = next;
            Render();
        }
    }

    private void Render()
    {
        var artifact = Current;
        versionLabel.Text = $"{artifact.Language} -- version {artifact.VersionIndex} of {thread.Count}";
        EnableActions(true);
        prevButton.Enabled = index > 0;
        nextButton.Enabled = index < thread.Count - 1;
        view.Visible = true;
        var whyBrowser = view.Show(artifact, source: false);
        noteLabel.Text = whyBrowser is null ? "" : $"Needs a browser: {whyBrowser}. Showing its source.";
        noteLabel.Visible = whyBrowser is not null;
        browserButton.Visible = whyBrowser is not null;
    }

    private void EnableActions(bool on)
    {
        foreach (var button in new[] { prevButton, nextButton, openWindowButton, browserButton, copyButton, saveButton })
        {
            button.Enabled = on;
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            store.Added -= OnAdded; // the store outlives the chat window
        }
        base.Dispose(disposing);
    }
}
