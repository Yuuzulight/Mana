using System;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #1122: the chat rail's Browser tool -- BrowserAutomationPanel's view,
// docked: the page she's on, its latest screenshot and her last steps,
// with Stop (ends her browser session) and Take over (#704: interactive
// page frames here, without opening a window; Done hands it back), plus
// the web pages this turn took in. Polls GET /browser-automation/activity
// once a second while it's on screen.
// #1140: opening one of this turn's pages reads it here, drawn by Folio
// (ReaderView), in place of the rest until Back.
internal sealed class BrowserTool : Panel
{
    private const int PollIntervalMs = 1000;
    private const int MaxSteps = 8;
    private const string TakeOverName = "Take over: control her browser here";
    private const string DoneName = "Done: hand her browser back";

    private readonly ManaBackendClient client;
    private readonly Func<string?> currentSession;
    private string? manualToken;
    private string? manualImage;
    private string? manualUrl;
    private Size manualViewport;
    private Task inputQueue = Task.CompletedTask;
    private bool returningBrowser;
    private readonly Button chromeButton = new() { Text = "Connect Chrome", Dock = DockStyle.Right, Width = 132, AccessibleName = "Connect selected personal Chrome tabs to this chat" };
    private readonly TextBox connectionCode = new() { Dock = DockStyle.Fill, ReadOnly = true, AccessibleName = "Chrome connection code" };
    private readonly Panel chromeRow = new() { Dock = DockStyle.Top, Height = 28 };
    private readonly System.Windows.Forms.Timer pollTimer = new() { Interval = PollIntervalMs };
    private readonly Label titleLabel = new() { Dock = DockStyle.Top, Height = 22, AutoEllipsis = true, ForeColor = DarkTheme.Text };
    private readonly Label urlLabel = new() { Dock = DockStyle.Top, Height = 20, AutoEllipsis = true, ForeColor = DarkTheme.Muted };
    private readonly BrowserPageView screenshotBox = new() { Dock = DockStyle.Top, Height = 160, SizeMode = PictureBoxSizeMode.Zoom, BackColor = DarkTheme.Background, AccessibleName = "Her browser's latest screenshot" };
    private readonly ListBox stepsBox = new() { Dock = DockStyle.Top, Height = 96, BorderStyle = BorderStyle.None, IntegralHeight = false, AccessibleName = "Her last steps" };
    // #1168: a page that may need the ads/trackers her browser blocked,
    // with "Open in my browser".
    private readonly Panel blockedRow = new() { Dock = DockStyle.Top, Height = 28, Visible = false, Padding = new Padding(0, 2, 0, 2) };
    private readonly Label blockedLabel = new() { Dock = DockStyle.Fill, AutoEllipsis = true, ForeColor = DarkTheme.Muted, TextAlign = ContentAlignment.MiddleLeft };
    private readonly Button openInMyBrowserButton = new() { Text = "Open in my browser", Dock = DockStyle.Right, Width = 130, AccessibleName = "Open this page in my own browser" };
    private readonly Label pagesLabel = new() { Dock = DockStyle.Top, Height = 22, Text = "Pages she read this turn (open one to read it here)", ForeColor = DarkTheme.Muted, Padding = new Padding(0, 6, 0, 0) };
    private readonly ListView pagesList = new() { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, HeaderStyle = ColumnHeaderStyle.None, AccessibleName = "Pages she read this turn (outside content)" };
    // #1158: the only files she may upload come from me.
    private readonly Button giveFileButton = new() { Text = "Give her a file", Dock = DockStyle.Left, Width = 110, AccessibleName = "Give her a file to upload" };
    // #1161: her latest "Test this site" report, drawn by Folio in the reader.
    private readonly Button reportButton = new() { Text = "Test report", Dock = DockStyle.Left, Width = 90, Enabled = false, AccessibleName = "Open her latest site test report" };
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
    // Tests swap this out so no dialog opens.
    internal Func<string[]?> PickFiles { get; set; } = () =>
    {
        using var dialog = new OpenFileDialog { Multiselect = true, Title = "Give Mana a file to upload" };
        return dialog.ShowDialog() == DialogResult.OK ? dialog.FileNames : null;
    };

    internal Action<string> OpenUrl { get; set; } = url => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });

    internal ReaderView Reader => reader; // tests

    public BrowserTool(ManaBackendClient client, Func<string?>? currentSession = null)
    {
        this.client = client;
        this.currentSession = currentSession ?? (() => null);
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
        DarkTheme.ApplyButton(giveFileButton);
        DarkTheme.ApplyButton(reportButton);
        reportButton.Click += (_, _) =>
        {
            ShowReader(true);
            _ = reader.ShowSiteTestAsync();
        };
        giveFileButton.Click += async (_, _) => await GiveFilesAsync();
        stopButton.Click += async (_, _) => await StopAsync();
        takeOverButton.Click += async (_, _) => await TakeOverOrHandBackAsync();
        DarkTheme.ApplyButton(chromeButton);
        chromeButton.Click += async (_, _) => await ConnectChromeAsync();
        chromeRow.Controls.Add(connectionCode);
        chromeRow.Controls.Add(chromeButton);
        screenshotBox.MouseDown += (_, _) => screenshotBox.Focus();
        screenshotBox.MouseClick += (_, e) =>
        {
            var point = BrowserPageView.PagePoint(e.Location, screenshotBox.ClientSize, manualViewport);
            if (manualToken is not null && point is Point p)
                QueueInput(new { action = "click", x = p.X, y = p.Y, button = e.Button == MouseButtons.Right ? "right" : "left" });
        };
        screenshotBox.MouseWheel += (_, e) => { if (manualToken is not null) QueueInput(new { action = "scroll", dy = Math.Clamp(-e.Delta * 3, -2000, 2000) }); };
        screenshotBox.KeyPress += (_, e) =>
        {
            if (manualToken is null || char.IsControl(e.KeyChar)) return;
            QueueInput(new { action = "text", text = e.KeyChar.ToString() });
            e.Handled = true;
        };
        screenshotBox.KeyDown += (_, e) =>
        {
            if (manualToken is null) return;
            var key = BrowserPageView.BrowserKey(e);
            if (key is null) return;
            QueueInput(new { action = "key", key });
            e.Handled = true;
            e.SuppressKeyPress = true;
        };
        DarkTheme.ApplyButton(openInMyBrowserButton);
        openInMyBrowserButton.Click += (_, _) => Open(activity?.BlockedUrl);
        blockedRow.Controls.Add(blockedLabel);
        blockedRow.Controls.Add(openInMyBrowserButton);
        var buttonRow = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = true, Padding = new Padding(0, 4, 0, 0) };
        foreach (var button in new[] { reportButton, giveFileButton, takeOverButton, stopButton }) { button.Dock = DockStyle.None; button.Height = 28; button.Margin = new Padding(0, 0, 4, 4); }
        buttonRow.Controls.Add(reportButton);
        buttonRow.Controls.Add(giveFileButton);
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
        Controls.Add(chromeRow);
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
            if (manualToken is not null)
            {
                var token = manualToken;
                var frame = await client.BrowserManualAsync("frame", token);
                if (manualToken == token && !IsDisposed)
                {
                    manualImage = frame.GetProperty("image").GetString();
                    manualUrl = frame.GetProperty("url").GetString();
                    manualViewport = new Size(frame.GetProperty("width").GetInt32(), frame.GetProperty("height").GetInt32());
                }
            }
            note = null;
        }
        catch (Exception ex)
        {
            note = $"Couldn't read her browser: {ex.Message}";
            if (manualToken is not null && activity?.TakenOver == false) { manualToken = null; manualImage = null; manualUrl = null; }
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
            manualToken = null;
            manualImage = null;
            manualUrl = null;
            connectionCode.Clear();
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

    private async Task GiveFilesAsync()
    {
        var files = PickFiles();
        if (files is not { Length: > 0 })
        {
            return;
        }
        try
        {
            var offered = await client.OfferBrowserFilesAsync(files);
            note = offered.Count == 0 ? "Those files couldn't be found." : $"She may upload: {string.Join(", ", offered.Select(p => System.IO.Path.GetFileName(p)))}";
        }
        catch (Exception ex)
        {
            note = $"Couldn't give her the file: {ex.Message}";
        }
        if (!IsDisposed)
        {
            Render();
        }
    }

    private async Task TakeOverOrHandBackAsync()
    {
        takeOverButton.Enabled = false;
        try
        {
            if (manualToken is not null)
            {
                var token = manualToken;
                returningBrowser = true;
                await inputQueue;
                await client.BrowserManualAsync("done", token);
                manualToken = null;
                manualImage = null;
                manualUrl = null;
            }
            else if (activity?.TakenOver == true)
            {
                await client.HandBackBrowserAsync();
            }
            else
            {
                var result = await client.BrowserManualAsync("start", payload: new { url = IsWebUrl(urlLabel.Text) ? urlLabel.Text : null });
                manualToken = result.GetProperty("token").GetString();
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
        finally { returningBrowser = false; if (!IsDisposed) Render(); }
    }

    private void QueueInput(object command)
    {
        var token = manualToken;
        if (token is null || returningBrowser) return;
        inputQueue = inputQueue.ContinueWith(async _ =>
        {
            try { if (!IsDisposed && manualToken == token) await client.BrowserManualAsync("input", token, command); }
            catch (Exception ex) { if (!IsDisposed) BeginInvoke(() => { note = $"Browser input failed: {ex.Message}"; Render(); }); }
        }, TaskScheduler.Default).Unwrap();
    }

    private async Task ConnectChromeAsync()
    {
        var sessionId = currentSession();
        if (string.IsNullOrWhiteSpace(sessionId)) { note = "Choose a chat before connecting Chrome."; Render(); return; }
        using var dialog = new Form { Text = "Connect Personal Chrome", Size = new Size(460, 220), StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false };
        var consent = new Label { Text = "Connect selected Chrome tabs to this chat? Mana will ask before each action. Disconnect ends her access without closing Chrome.", Dock = DockStyle.Top, Height = 56, Padding = new Padding(8) };
        var sites = new TextBox { Dock = DockStyle.Top, AccessibleName = "Allowed site origins, comma separated; blank permits any web site" };
        var label = new Label { Text = "Allowed sites (optional, e.g. https://example.com)", Dock = DockStyle.Top, Height = 26 };
        var accept = new Button { Text = "Connect", DialogResult = DialogResult.OK, Dock = DockStyle.Bottom, Height = 32 };
        dialog.Controls.Add(sites); dialog.Controls.Add(label); dialog.Controls.Add(consent); dialog.Controls.Add(accept);
        dialog.AcceptButton = accept;
        if (dialog.ShowDialog(FindForm()) != DialogResult.OK) return;
        chromeButton.Enabled = false;
        try
        {
            var origins = sites.Text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            connectionCode.Text = await client.ConnectPersonalBrowserAsync(sessionId, origins);
            connectionCode.SelectAll();
            connectionCode.Focus();
            note = "Chrome connection is waiting.";
        }
        catch (Exception ex) { note = $"Couldn't connect Chrome: {ex.Message}"; }
        finally { if (!IsDisposed) { chromeButton.Enabled = true; Render(); } }
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
        Render();
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
        var pageUrl = endedAtStep is null ? manualUrl ?? activity?.PageUrl : null;
        var takenOver = manualToken is not null || activity?.TakenOver == true;
        if (!readerOn)
        {
            var embedded = manualToken is not null;
            pagesList.Visible = !embedded;
            pagesLabel.Visible = !embedded;
            stepsBox.Visible = !embedded;
            screenshotBox.Dock = embedded ? DockStyle.Fill : DockStyle.Top;
            if (!embedded) screenshotBox.Height = 160;
        }
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
        reportButton.Enabled = activity?.SiteTestTitle is not null;
        takeOverButton.Text = takenOver ? "Done" : "Take over";
        takeOverButton.AccessibleName = takenOver ? DoneName : TakeOverName;
        takeOverButton.Enabled = takenOver || IsWebUrl(pageUrl) || activity?.NeedsYou is not null || connectionCode.TextLength > 0;

        var base64 = endedAtStep is null ? manualImage ?? activity?.ScreenshotBase64 : null;
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
            var token = manualToken;
            manualToken = null;
            if (token is not null) _ = client.BrowserManualAsync("done", token).ContinueWith(task => { _ = task.Exception; }, TaskScheduler.Default);
            pollTimer.Dispose();
            screenshotBox.Image?.Dispose();
            titleFont.Dispose();
        }
        base.Dispose(disposing);
    }
}

internal sealed class BrowserPageView : PictureBox
{
    public BrowserPageView() { SetStyle(ControlStyles.Selectable, true); TabStop = true; }
    protected override bool IsInputKey(Keys keyData) => true;

    internal static Point? PagePoint(Point point, Size control, Size viewport)
    {
        if (viewport.Width <= 0 || viewport.Height <= 0 || control.Width <= 0 || control.Height <= 0) return null;
        var scale = Math.Min((double)control.Width / viewport.Width, (double)control.Height / viewport.Height);
        var x = (point.X - (control.Width - viewport.Width * scale) / 2) / scale;
        var y = (point.Y - (control.Height - viewport.Height * scale) / 2) / scale;
        return x < 0 || y < 0 || x >= viewport.Width || y >= viewport.Height ? null : new Point(Math.Min(viewport.Width - 1, (int)Math.Round(x)), Math.Min(viewport.Height - 1, (int)Math.Round(y)));
    }

    internal static string? BrowserKey(KeyEventArgs e)
    {
        var key = e.KeyCode switch
        {
            Keys.Enter => "Enter", Keys.Tab => "Tab", Keys.Escape => "Escape", Keys.Back => "Backspace",
            Keys.Delete => "Delete", Keys.Space => "Space", Keys.Up => "ArrowUp", Keys.Down => "ArrowDown", Keys.Left => "ArrowLeft", Keys.Right => "ArrowRight",
            Keys.Home => "Home", Keys.End => "End", Keys.PageUp => "PageUp", Keys.PageDown => "PageDown",
            _ when (e.Control || e.Alt) && e.KeyCode >= Keys.A && e.KeyCode <= Keys.Z => e.KeyCode.ToString(),
            _ => null,
        };
        return key is null ? null : $"{(e.Control ? "Control+" : "")}{(e.Alt ? "Alt+" : "")}{(e.Shift ? "Shift+" : "")}{key}";
    }
}
