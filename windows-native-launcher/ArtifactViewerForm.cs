using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Folio;
using Folio.Skia;
using Folio.Typography;
using Folio.WinForms;

namespace Mana.NativeLauncher;

// #528: ports windows-launcher/artifact/'s standalone viewer window --
// Prev/Next navigation through a version thread (ArtifactDetector),
// Mermaid content rendered natively (MermaidParser/MermaidLayout/
// MermaidRenderer, flowcharts only -- sequence diagrams and everything
// else fall back to raw source text, same as an unrecognized/malformed
// diagram), static HTML drawn by Folio (#937; pages it can't draw open in
// the default browser), everything else as a highlighted code page that
// Folio also draws (#1141, CodeArtifact).
//
// #686: like the reference, the chat opens this from a button on the
// reply's bubble (ChatView calls Add, then the returned action), instead
// of it popping up by itself.
internal enum ArtifactOpen
{
    Default, // HTML: in Mana if Folio can draw it, else the browser
    InMana,
    Browser,
    Source,
    SaveAs,
}

// #1120: an artifact as the chat recorded it -- which chat, and when.
// #1142: one read back from a saved chat comes with its Title and, until
// it's opened, no content: Load reads it (ArtifactViewerForm.LoadThreadAsync).
internal sealed record ArtifactEntry(VersionedArtifact Artifact, string? SessionId, DateTime At)
{
    public string? Title { get; init; }
    public Func<Task<string?>>? Load { get; init; }
}

internal sealed class ArtifactViewerForm : Form
{
    private readonly List<ArtifactEntry> entries = new();
    private IReadOnlyList<VersionedArtifact> currentThread = Array.Empty<VersionedArtifact>();
    private int currentIndex;
    private bool showSource; // "View source": HTML stays source while paging through versions

    private readonly Label titleLabel = new();
    private readonly Button prevButton = new();
    private readonly Button nextButton = new();
    private readonly ArtifactView view = new() { Dock = DockStyle.Fill };

    internal FolioView HtmlView => view.HtmlView; // tests

    // #1120: every artifact so far, oldest first, for the chat window's
    // Artifacts panel; Added is raised (UI thread) for each new one.
    public IReadOnlyList<ArtifactEntry> Entries => entries;
    public event Action<ArtifactEntry>? Added;

    // The chat an artifact comes from; set once VoiceLoop exists.
    public Func<string?>? CurrentSessionId { get; set; }

    public ArtifactViewerForm()
    {
        Text = "Mana Artifact Viewer";
        Width = 720;
        Height = 560;
        StartPosition = FormStartPosition.CenterScreen;
        DarkTheme.ApplyForm(this);

        var navRow = new TableLayoutPanel { Dock = DockStyle.Top, Height = 32, ColumnCount = 3, BackColor = DarkTheme.Background };
        prevButton.Text = "< Prev";
        prevButton.Dock = DockStyle.Fill;
        prevButton.Click += (_, _) => Navigate(-1);
        DarkTheme.ApplyButton(prevButton);
        nextButton.Text = "Next >";
        nextButton.Dock = DockStyle.Fill;
        nextButton.Click += (_, _) => Navigate(1);
        DarkTheme.ApplyButton(nextButton);
        titleLabel.Dock = DockStyle.Fill;
        titleLabel.TextAlign = ContentAlignment.MiddleCenter;
        titleLabel.ForeColor = DarkTheme.Text;
        navRow.Controls.Add(prevButton, 0, 0);
        navRow.Controls.Add(titleLabel, 1, 0);
        navRow.Controls.Add(nextButton, 2, 0);
        navRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        navRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        navRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));

        Controls.Add(view);
        Controls.Add(navRow);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnFormClosing(e);
    }

    // Records a reply's artifact in its version thread and returns what its
    // chat button runs: open the thread at this version (versions added
    // since stay reachable with Next), or for HTML, the browser / save.
    // UI thread only.
    public Action<ArtifactOpen> Add(DetectedArtifact detected)
    {
        var versioned = ArtifactDetector.AssignVersion(detected, entries.ConvertAll(e => e.Artifact));
        var entry = new ArtifactEntry(versioned, CurrentSessionId?.Invoke(), DateTime.Now);
        entries.Add(entry);
        Added?.Invoke(entry);
        return how =>
        {
            var html = versioned.Language == "html";
            if (html && (how == ArtifactOpen.Browser || (how == ArtifactOpen.Default && HtmlArtifact.BrowserReasons(versioned.Content) is not null)))
            {
                HtmlArtifact.OpenInBrowser(versioned.Content);
                return;
            }
            if (how == ArtifactOpen.SaveAs)
            {
                SaveAs(versioned);
                return;
            }
            Open(entry, source: how == ArtifactOpen.Source);
        };
    }

    // #1142: when this run started. Saved chats' artifacts from before it are
    // read back (AddHistory); later ones arrived here through Add.
    public DateTime StartedAt { get; } = DateTime.Now;
    public event Action? HistoryAdded;

    // #1142: a saved chat's past artifacts (oldest first, not loaded yet),
    // listed with the rest and older than this run's.
    public void AddHistory(IReadOnlyList<ArtifactEntry> past)
    {
        if (past.Count > 0)
        {
            entries.InsertRange(0, past);
            HistoryAdded?.Invoke();
        }
    }

    // #1142: reads the content of the entry's thread's saved versions. False
    // when one couldn't be read; it's tried again next time. UI thread only.
    public async Task<bool> LoadThreadAsync(ArtifactEntry entry)
    {
        var ok = true;
        foreach (var saved in ThreadOf(entry).Where(e => e.Load is not null))
        {
            string? content;
            try
            {
                content = await saved.Load!();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"ArtifactViewerForm: couldn't read a saved artifact. {ex.Message}");
                content = null;
            }
            var at = entries.IndexOf(saved);
            if (content is null)
            {
                ok = false;
            }
            else if (at >= 0) // not already loaded by another call meanwhile
            {
                entries[at] = saved with { Artifact = saved.Artifact with { Content = content }, Load = null };
            }
        }
        return ok;
    }

    // #1120: the entry's version thread, oldest first.
    public List<ArtifactEntry> ThreadOf(ArtifactEntry entry) =>
        entries.Where(e => e.Artifact.ThreadId == entry.Artifact.ThreadId).ToList();

    // Shows the entry's thread at its version in this window.
    public void Open(ArtifactEntry entry, bool source = false)
    {
        showSource = source;
        var thread = ThreadOf(entry).ConvertAll(e => e.Artifact);
        ShowThread(thread, thread.IndexOf(entry.Artifact));
    }

    internal static void SaveAs(VersionedArtifact artifact)
    {
        var (extension, kind) = artifact.Language switch
        {
            "html" => ("html", "Web page"),
            "mermaid" => ("mmd", "Mermaid diagram"),
            _ => ("txt", "Text"),
        };
        using var dialog = new SaveFileDialog { FileName = $"artifact.{extension}", Filter = $"{kind} (*.{extension})|*.{extension}|All files (*.*)|*.*" };
        if (dialog.ShowDialog() == DialogResult.OK)
        {
            File.WriteAllText(dialog.FileName, artifact.Content);
        }
    }

    private void ShowThread(IReadOnlyList<VersionedArtifact> thread, int index)
    {
        currentThread = thread;
        currentIndex = index;
        RenderCurrent();
        Show();
        Activate();
    }

    private void Navigate(int delta)
    {
        var next = currentIndex + delta;
        if (next < 0 || next >= currentThread.Count)
        {
            return;
        }
        currentIndex = next;
        RenderCurrent();
    }

    private void RenderCurrent()
    {
        if (currentThread.Count == 0)
        {
            return;
        }
        var artifact = currentThread[currentIndex];
        titleLabel.Text = $"{artifact.Language} -- version {artifact.VersionIndex} of {currentThread.Count}";
        prevButton.Enabled = currentIndex > 0;
        nextButton.Enabled = currentIndex < currentThread.Count - 1;

        if (view.Show(artifact, showSource) is { } whyBrowser)
        {
            titleLabel.Text += $" (needs a browser: {whyBrowser} -- source shown)";
        }
    }
}

// #1120: draws one artifact -- a Mermaid flowchart natively, static HTML
// with Folio, anything else (and HTML Folio can't draw, or its source) as a
// highlighted code page, also drawn by Folio (#1141, CodeArtifact). Shared
// by the viewer window and the chat window's Artifacts panel so both look
// the same.
internal sealed class ArtifactView : Panel
{
    private readonly CheckBox wrapBox = new() { Text = "Wrap long lines", Checked = true, Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(6, 2, 6, 2), Visible = false };
    private readonly Panel diagramPanel = new();
    private readonly Font textFont = new("Consolas", 10F);
    private string? currentMermaidSource;
    private VersionedArtifact? currentCode; // shown as a code page
    // #937: static HTML, drawn by Folio with the system's fonts. Folio loads
    // nothing but data: images and runs no scripts; pages that need more go
    // to the browser instead (HtmlArtifact.BrowserReasons).
    private readonly FolioView htmlView = new()
    {
        Dock = DockStyle.Fill,
        Visible = false,
        Options = new FolioOptions { Fonts = new FontSettings { Source = new SystemFontSource() } },
        AccessibleName = "Artifact",
    };

    internal FolioView HtmlView => htmlView;
    internal CheckBox WrapBox => wrapBox; // tests

    public ArtifactView()
    {
        BackColor = DarkTheme.Background;
        wrapBox.ForeColor = DarkTheme.Text;
        // Wrapping is set when the page is built (it has no script).
        wrapBox.CheckedChanged += (_, _) => ShowCode();

        diagramPanel.Dock = DockStyle.Fill;
        diagramPanel.AutoScroll = true;
        diagramPanel.BackColor = DarkTheme.Background;
        diagramPanel.Paint += OnDiagramPaint;

        // A clicked web link opens in the default browser; other schemes
        // (file:, mailto:, protocol handlers) do nothing.
        htmlView.LinkActivated += (_, e) =>
        {
            e.Handled = true;
            if (HtmlArtifact.IsWebLink(e.Uri))
            {
                Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true })?.Dispose();
            }
        };
        // The code page carries the theme's colours: rebuild it on a switch.
        DarkTheme.Changed += ShowCode;

        Controls.Add(htmlView);
        Controls.Add(diagramPanel);
        Controls.Add(wrapBox);
    }

    // Returns why an HTML artifact needs a browser (its source is shown
    // instead), or null. source: show HTML's source even when Folio can draw it.
    public string? Show(VersionedArtifact artifact, bool source)
    {
        htmlView.Visible = false;
        diagramPanel.Visible = false;
        wrapBox.Visible = false;
        currentMermaidSource = null;
        currentCode = null;
        if (artifact.Language == "mermaid")
        {
            currentMermaidSource = artifact.Content;
            diagramPanel.Visible = true;
            diagramPanel.Invalidate();
            return null;
        }
        var whyBrowser = artifact.Language == "html" && !source ? HtmlArtifact.BrowserReasons(artifact.Content) : null;
        if (artifact.Language == "html" && !source && whyBrowser is null)
        {
            htmlView.LoadHtml(artifact.Content);
            htmlView.Visible = true;
            return null;
        }
        currentCode = artifact; // HTML's source too, when asked for or Folio can't draw it
        ShowCode();
        return whyBrowser;
    }

    private void ShowCode()
    {
        if (currentCode is not { } code)
        {
            return;
        }
        htmlView.LoadHtml(CodeArtifact.Html(code.Language, code.Content, wrapBox.Checked));
        htmlView.Visible = true;
        wrapBox.Visible = true;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            DarkTheme.Changed -= ShowCode; // a static event: don't keep this view alive
            textFont.Dispose();
        }
        base.Dispose(disposing);
    }

    private void OnDiagramPaint(object? sender, PaintEventArgs e)
    {
        if (currentMermaidSource is null)
        {
            return;
        }

        MermaidLayoutResult layout;
        try
        {
            var graph = MermaidParser.Parse(currentMermaidSource);
            if (graph.Nodes.Count == 0)
            {
                // Nothing this parser recognizes -- either a genuinely
                // empty diagram, or a Mermaid type outside this issue's
                // scope (sequenceDiagram, classDiagram, pie, gantt, ...).
                // Either way, showing the raw source beats a blank canvas.
                DrawFallbackText(e.Graphics, currentMermaidSource);
                return;
            }
            layout = MermaidLayout.Compute(graph);
        }
        catch (Exception ex)
        {
            DrawFallbackText(e.Graphics, $"Could not render this diagram: {ex.Message}\n\n{currentMermaidSource}");
            return;
        }

        var size = MermaidRenderer.Measure(layout);
        if (diagramPanel.AutoScrollMinSize != size)
        {
            diagramPanel.AutoScrollMinSize = size;
        }
        MermaidRenderer.Draw(e.Graphics, layout);
    }

    // #528 review: the success path sizes AutoScrollMinSize off the
    // measured diagram (above) -- without doing the same here, switching
    // from a large successfully-rendered diagram to a fallback (an
    // unsupported type, or a parse error) left the panel's scroll extent
    // stale from whatever was rendered last, clipping/hiding text that a
    // fresh scroll region would have shown.
    private void DrawFallbackText(Graphics g, string text)
    {
        var size = g.MeasureString(text, textFont, diagramPanel.ClientSize.Width > 0 ? diagramPanel.ClientSize.Width : 2000);
        var scrollSize = new Size((int)size.Width + 20, (int)size.Height + 20);
        if (diagramPanel.AutoScrollMinSize != scrollSize)
        {
            diagramPanel.AutoScrollMinSize = scrollSize;
        }
        // DarkTheme.Text, not Brushes.Black -- diagramPanel's own
        // background is DarkTheme.Background now, not white.
        using var textBrush = new SolidBrush(DarkTheme.Text);
        g.DrawString(text, textFont, textBrush, 10, 10);
    }
}

// #686 (Q1/Q4), #937: what Folio can't draw yet -- scripts, event handlers,
// external resources, canvas, MathML, SVG and CSS it doesn't support (Folio's
// ArtifactClassifier) -- opens in the default browser, from a temp copy
// whose CSP stops it making network requests.
internal static class HtmlArtifact
{
    // Why the page needs a browser (the classifier's reasons, e.g. "uses
    // MathML"), or null when Folio can draw it.
    public static string? BrowserReasons(string html) =>
        ArtifactClassifier.Classify(html) is { Kind: not ArtifactKind.Static } c ? string.Join(", ", c.Reasons) : null;

    public static bool IsWebLink(Uri uri) => uri.Scheme is "http" or "https";

    private const string CspMeta = "<meta http-equiv=\"Content-Security-Policy\" content=\"connect-src 'none'\">";

    // Right after <head>, else after the doctype (a meta there still lands
    // in the implied head), else first.
    public static string WithCsp(string html)
    {
        var at = Regex.Match(html, @"<head\b[^>]*>", RegexOptions.IgnoreCase);
        if (!at.Success)
        {
            at = Regex.Match(html, @"^\s*<!doctype[^>]*>", RegexOptions.IgnoreCase);
        }
        var index = at.Success ? at.Index + at.Length : 0;
        return html.Insert(index, CspMeta);
    }

    // ponytail: temp copies are left for Windows' temp cleanup; delete on exit if they pile up.
    public static void OpenInBrowser(string html)
    {
        var dir = Path.Combine(Path.GetTempPath(), "Mana", "artifacts");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, $"artifact-{Guid.NewGuid():N}.html");
        File.WriteAllText(path, WithCsp(html));
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true })?.Dispose();
    }
}
