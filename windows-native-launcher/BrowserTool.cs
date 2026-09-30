using System;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1122: the chat rail's Browser tool -- BrowserAutomationPanel's view,
// docked: the page she's on, its latest screenshot and her last steps,
// with Stop (ends her browser session) and Take over (#1139: her Edge
// profile opens as a visible window at her page; Done hands it back), plus
// the web pages this turn took in. Polls GET /browser-automation/activity
// once a second while it's on screen.
// #1140: opening one of this turn's pages reads it here, drawn by Folio
// (ReaderView), in place of the rest until Back.
internal sealed class BrowserTool : Panel
{
    private const int PollIntervalMs = 1000;
    private const int MaxSteps = 8;
    private const string TakeOverName = "Take over: open her browser in a window for me";
    private const string DoneName = "Done: hand her browser back";

    private readonly ManaBackendClient client;
    private readonly System.Windows.Forms.Timer pollTimer = new() { Interval = PollIntervalMs };
    private readonly Label titleLabel = new() { Dock = DockStyle.Top, Height = 22, AutoEllipsis = true, ForeColor = DarkTheme.Text };
    private readonly Label urlLabel = new() { Dock = DockStyle.Top, Height = 20, AutoEllipsis = true, ForeColor = DarkTheme.Muted };
    private readonly PictureBox screenshotBox = new() { Dock = DockStyle.Top, Height = 160, SizeMode = PictureBoxSizeMode.Zoom, BackColor = DarkTheme.Background, AccessibleName = "Her browser's latest screenshot" };
    private readonly ListBox stepsBox = new() { Dock = DockStyle.Top, Height = 96, BorderStyle = BorderStyle.None, IntegralHeight = false, AccessibleName = "Her last steps" };
    // #1168: a page that may need the ads/trackers her browser blocked,
    // with "Open in my browser".
    private readonly Panel blockedRow = new() { Dock = DockStyle.Top, Height = 28, Visible = false, Padding = new Padding(0, 2, 0, 2) };
    private readonly Label blockedLabel = new() { Dock = DockStyle.Fill, AutoEllipsis = true, ForeColor = DarkTheme.Muted, TextAlign = ContentAlignment.MiddleLeft };
    private readonly Button openInMyBrowserButton = new() { Text = "Open in my browser", Dock = DockStyle.Right, Width = 130, AccessibleName = "Open this page in my own browser" };
    private readonly Label pagesLabel = new() { Dock = DockStyle.Top, Height = 22, Text = "Pages she read this turn (open one to read it here)", ForeColor = DarkTheme.Muted, Padding = new Padding(0, 6, 0, 0) };
    private readonly ListView pagesList = new() { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, HeaderStyle = ColumnHeaderStyle.None, AccessibleName = "Pages she read this turn (outside content)" };
    private readonly Button stopButton = new() { Text = "Stop", Dock = DockStyle.Right, Width = 64, AccessibleName = "Stop: end her browser session" };
    private readonly Button takeOverButton = new() { Text = "Take over", Dock = DockStyle.Left, Width = 84, AccessibleName = TakeOverName };
    private readonly Font titleFont;
    private readonly ReaderView reader;

    private ManaBrowserAutomationActivity? activity;
    private string? note;
    private string? shownScreenshot;
    // After Stop: the last step then, until she takes a new one (the feed
    // still holds the old page).
    private string? endedAtStep;
    private bool polling;

    // Tests swap this out so nothing opens a real browser.
    internal Action<string> OpenUrl { get; set; } = url => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });

    internal ReaderView Reader => reader; // tests

    public BrowserTool(ManaBackendClient client)
    {
        this.client = client;
        BackColor = DarkTheme.Panel2;
        Padding = new Padding(6);
        titleFont = new Font(titleLabel.Font, FontStyle.Bold);
        titleLabel.Font = titleFont;
        stepsBox.BackColor = DarkTheme.Panel;
        stepsBox.ForeColor = DarkTheme.Text;

        pagesList.Columns.Add("Source", 72);
        pagesList.Columns.Add("Link", 260);
        DarkTheme.ApplyListView(pagesList);
        pagesList.ItemActivate += (_, _) =>
        {
            if (pagesList.SelectedItems.Count > 0)
            {
                Read((string)pagesList.SelectedItems[0].Tag!);
            }
        };

        DarkTheme.ApplyButton(stopButton);
        DarkTheme.ApplyButton(takeOverButton);
        stopButton.Click += async (_, _) => await StopAsync();
        takeOverButton.Click += async (_, _) => await TakeOverOrHandBackAsync();
        DarkTheme.ApplyButton(openInMyBrowserButton);
        openInMyBrowserButton.Click += (_, _) => Open(activity?.BlockedUrl);
        blockedRow.Controls.Add(blockedLabel);
        blockedRow.Controls.Add(openInMyBrowserButton);
        var buttonRow = new Panel { Dock = DockStyle.Bottom, Height = 32, Padding = new Padding(0, 4, 0, 0) };
        buttonRow.Controls.Add(takeOverButton);
        buttonRow.Controls.Add(stopButton);

        reader = new ReaderView(client, () => ShowReader(false)) { Dock = DockStyle.Fill, Visible = false, OpenUrl = url => this.OpenUrl(url) };

        // Last added docks first: title and URL on top, then the screenshot,
        // her steps, and this turn's pages filling the rest above the buttons.
        // The reader, when it's open, is the only one shown.
        Controls.Add(reader);
        Controls.Add(pagesList);
        Controls.Add(buttonRow);
        Controls.Add(pagesLabel);
        Controls.Add(stepsBox);
        Controls.Add(screenshotBox);
        Controls.Add(blockedRow);
        Controls.Add(urlLabel);
        Controls.Add(titleLabel);

        pollTimer.Tick += async (_, _) => await RefreshAsync();
        VisibleChanged += (_, _) =>
        {
            pollTimer.Enabled = Visible;
            if (Visible)
            {
                _ = RefreshAsync();
            }
        };
        Render();
    }

    internal async Task RefreshAsync()
    {
        // A slow backend mustn't pile up a request per tick.
        if (polling)
        {
            return;
        }
        polling = true;
        try
        {
            activity = await client.GetBrowserAutomationActivityAsync();
            note = null;
        }
        catch (Exception ex)
        {
            note = $"Couldn't read her browser: {ex.Message}";
        }
        finally
        {
            polling = false;
        }
        if (!IsDisposed)
        {
            Render();
        }
    }

    private async Task StopAsync()
    {
        stopButton.Enabled = false;
        try
        {
            await client.CloseBrowserSessionAsync();
            endedAtStep = activity?.Log.LastOrDefault()?.At ?? "";
        }
        catch (Exception ex)
        {
            note = $"Couldn't stop it: {ex.Message}";
        }
        if (!IsDisposed)
        {
            Render();
            stopButton.Enabled = true;
        }
    }

    private async Task TakeOverOrHandBackAsync()
    {
        takeOverButton.Enabled = false;
        try
        {
            if (activity?.TakenOver == true)
            {
                await client.HandBackBrowserAsync();
            }
            else
            {
                await client.TakeOverBrowserAsync(IsWebUrl(urlLabel.Text) ? urlLabel.Text : null);
            }
            await RefreshAsync();
        }
        catch (Exception ex)
        {
            note = $"Couldn't switch: {ex.Message}";
            if (!IsDisposed)
            {
                Render();
            }
        }
    }

    // Only web pages: a link from outside content never runs anything else.
    private void Open(string? url)
    {
        if (IsWebUrl(url))
        {
            OpenUrl(url!);
        }
    }

    private void Read(string? url)
    {
        if (IsWebUrl(url))
        {
            ShowReader(true);
            _ = reader.ShowAsync(url!);
        }
    }

    private void ShowReader(bool on)
    {
        readerOn = on;
        SuspendLayout();
        foreach (Control control in Controls)
        {
            control.Visible = (control == reader) == on;
        }
        // #1168: the blocked-ads note only when there is one.
        blockedRow.Visible = !on && blockedLabel.Text.Length > 0;
        ResumeLayout();
    }

    private bool readerOn;

    internal static bool IsWebUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp);

    private void Render()
    {
        var lastStep = activity?.Log.LastOrDefault()?.At ?? "";
        if (endedAtStep is not null && endedAtStep != lastStep)
        {
            endedAtStep = null;
        }
        var pageUrl = endedAtStep is null ? activity?.PageUrl : null;
        var takenOver = activity?.TakenOver == true;
        titleLabel.Text = note
            ?? (takenOver ? "You have her browser. Press Done when you're finished."
            : activity?.NeedsYou is { Length: > 0 } needsYou ? $"She needs you: {needsYou}"
            : endedAtStep is not null ? "Her browser session is closed."
            : pageUrl is null ? "She isn't on a page right now."
            : activity!.PageTitle is { Length: > 0 } title ? title : "(untitled page)");
        urlLabel.Text = pageUrl ?? "";
        var blockedUrl = endedAtStep is null && activity?.BlockedCount > 0 && IsWebUrl(activity.BlockedUrl) ? activity.BlockedUrl : null;
        blockedRow.Visible = blockedUrl is not null && !readerOn;
        blockedLabel.Text = blockedUrl is null ? "" : $"This site may need the {activity!.BlockedCount} ad/tracker request(s) her browser blocked.";
        takeOverButton.Text = takenOver ? "Done" : "Take over";
        takeOverButton.AccessibleName = takenOver ? DoneName : TakeOverName;
        takeOverButton.Enabled = takenOver || IsWebUrl(pageUrl) || activity?.NeedsYou is not null;

        var base64 = endedAtStep is null ? activity?.ScreenshotBase64 : null;
        if (base64 != shownScreenshot)
        {
            shownScreenshot = base64;
            screenshotBox.Image?.Dispose();
            screenshotBox.Image = BrowserAutomationPanel.DecodeScreenshot(base64);
        }

        var steps = activity?.Log.Skip(Math.Max(0, activity.Log.Count - MaxSteps)).Select(e => (object)e.Summary).ToArray() ?? [];
        if (!stepsBox.Items.Cast<object>().SequenceEqual(steps))
        {
            stepsBox.Items.Clear();
            stepsBox.Items.AddRange(steps);
        }

        var pages = activity?.TurnPages ?? [];
        if (pagesList.Items.Count != pages.Count || pagesList.Items.Cast<ListViewItem>().Select(i => (string)i.Tag!).Where((url, i) => url != pages[i].Url).Any())
        {
            pagesList.BeginUpdate();
            pagesList.Items.Clear();
            foreach (var page in pages)
            {
                pagesList.Items.Add(new ListViewItem([page.Source, page.Url]) { Tag = page.Url });
            }
            pagesList.EndUpdate();
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            pollTimer.Dispose();
            screenshotBox.Image?.Dispose();
            titleFont.Dispose();
        }
        base.Dispose(disposing);
    }
}
