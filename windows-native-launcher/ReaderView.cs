using System;
using System.Diagnostics;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Folio;
using Folio.Skia;
using Folio.Typography;
using Folio.WinForms;

namespace Mana.NativeLauncher;

// #1140: a web page read without a browser, in the Browser tool. The
// backend fetches it behind its SSRF guard and extracts the readable part
// as Markdown (node-bot/tools/html-extract.js); Folio draws that like
// Mana's docs (MarkdownHtml): text, tables and images, no scripts or
// trackers. Images are only the data: URLs the backend fetched -- Folio
// itself loads nothing. Its source link and "Open in my browser" open the
// real page in my browser, as does any link in it.
internal sealed class ReaderView : UserControl
{
    private readonly ManaBackendClient client;
    private readonly FolioView view = new()
    {
        Dock = DockStyle.Fill,
        Options = new FolioOptions { Fonts = new FontSettings { Source = new SystemFontSource() }, ColorScheme = DarkTheme.IsLight ? ColorScheme.Light : ColorScheme.Dark },
        AccessibleName = "Page",
    };
    private readonly Label titleLabel = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = DarkTheme.Text, AutoEllipsis = true };
    private readonly LinkLabel sourceLink = new() { Dock = DockStyle.Top, Height = 20, AutoEllipsis = true, AccessibleName = "Source link" };
    private readonly Label noteLabel = new() { Dock = DockStyle.Top, AutoSize = true, ForeColor = DarkTheme.Muted, Padding = new Padding(0, 2, 0, 4), Visible = false };
    private readonly Button backButton = new() { Text = "<", Dock = DockStyle.Left, Width = 32, AccessibleName = "Back to her browser" };
    private readonly Button browserButton = new() { Text = "Open in my browser", Dock = DockStyle.Right, AutoSize = true };
    private string? url;

    // Tests swap this out so nothing opens a real browser.
    internal Action<string> OpenUrl { get; set; } = url => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose();

    internal FolioView View => view; // tests
    internal string Note => noteLabel.Text; // tests

    public ReaderView(ManaBackendClient client, Action back)
    {
        this.client = client;
        BackColor = DarkTheme.Panel2;
        Padding = new Padding(6);
        sourceLink.LinkColor = sourceLink.ActiveLinkColor = DarkTheme.Accent;
        DarkTheme.ApplyButton(backButton);
        DarkTheme.ApplyButton(browserButton);
        backButton.Click += (_, _) => back();
        browserButton.Click += (_, _) => Open(url);
        sourceLink.LinkClicked += (_, _) => Open(url);
        view.LinkActivated += (_, e) =>
        {
            e.Handled = true;
            Open(e.Uri.AbsoluteUri);
        };

        var bar = new Panel { Dock = DockStyle.Top, Height = 30, Padding = new Padding(0, 0, 0, 4) };
        bar.Controls.Add(titleLabel);
        bar.Controls.Add(browserButton);
        bar.Controls.Add(backButton);
        // Last added docks first: the bar, the source link, any note, then the page.
        Controls.Add(view);
        Controls.Add(noteLabel);
        Controls.Add(sourceLink);
        Controls.Add(bar);
    }

    // Reads the page and draws it; a newer page replaces a slower one.
    public async Task ShowAsync(string pageUrl)
    {
        url = pageUrl;
        titleLabel.Text = "Reading...";
        sourceLink.Text = pageUrl;
        SetNote(null);
        view.LoadHtml(MarkdownHtml.ToHtml("", _ => null));
        ManaReaderPage page;
        try
        {
            page = await client.ReadPageAsync(pageUrl);
        }
        catch (Exception ex)
        {
            if (!IsDisposed && url == pageUrl)
            {
                titleLabel.Text = "Couldn't read this page";
                SetNote(ex.Message);
            }
            return;
        }
        if (IsDisposed || url != pageUrl)
        {
            return;
        }
        titleLabel.Text = page.Title.Length > 0 ? page.Title : "(untitled page)";
        SetNote(page.NeedsBrowser is { } why ? $"This page needs a browser ({why}): open it in your browser to see all of it."
            : page.Truncated ? "A long page: this is the first part of it."
            : null);
        // Relative links resolve against the page; images the backend didn't fetch show their alt text.
        view.LoadHtml(Html(page), Uri.TryCreate(page.Url, UriKind.Absolute, out var baseUri) ? baseUri : new Uri(pageUrl));
    }

    // Only data: images reach Folio: anything else could make it fetch.
    internal static string Html(ManaReaderPage page) =>
        MarkdownHtml.ToHtml(page.Text, src => page.Images.TryGetValue(src, out var data) && data.StartsWith("data:image/", StringComparison.Ordinal) ? data : null);

    private void SetNote(string? note)
    {
        noteLabel.Text = note ?? "";
        noteLabel.Visible = note is not null;
    }

    // Only web pages: a link from outside content never runs anything else.
    private void Open(string? target)
    {
        if (BrowserTool.IsWebUrl(target))
        {
            OpenUrl(target!);
        }
    }
}
