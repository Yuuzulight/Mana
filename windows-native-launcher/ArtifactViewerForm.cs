using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using TheArtOfDev.HtmlRenderer.WinForms;

namespace Mana.NativeLauncher;

// #528: ports windows-launcher/artifact/'s standalone viewer window --
// Prev/Next navigation through a version thread (ArtifactDetector),
// Mermaid content rendered natively (MermaidParser/MermaidLayout/
// MermaidRenderer, flowcharts only -- sequence diagrams and everything
// else fall back to raw source text, same as an unrecognized/malformed
// diagram), simple HTML drawn by HtmlRenderer (#686; pages it can't draw
// open in the default browser), everything else shown as plain
// monospace text. No markdown rendering for other
// content: artifact content is source code, which doesn't carry markdown
// inline formatting to begin with, so plain monospace text is the correct
// rendering for it, not a lesser fallback.
//
// #686: like the reference, the chat opens this from a button on the
// reply's bubble (ChatView calls Add, then the returned action), instead
// of it popping up by itself.
internal enum ArtifactOpen
{
    Default, // HTML: in Mana if HtmlRenderer can draw it, else the browser
    InMana,
    Browser,
    Source,
    SaveAs,
}

internal sealed class ArtifactViewerForm : Form
{
    private readonly List<VersionedArtifact> history = new();
    private IReadOnlyList<VersionedArtifact> currentThread = Array.Empty<VersionedArtifact>();
    private int currentIndex;
    private string? currentMermaidSource;
    private bool showSource; // "View source": HTML stays source while paging through versions

    private readonly Label titleLabel = new();
    private readonly Button prevButton = new();
    private readonly Button nextButton = new();
    private readonly TextBox textBox = new();
    private readonly Panel diagramPanel = new();
    // #686: simple HTML, drawn with no network: images only from data:
    // URIs, no external stylesheets, links go nowhere. Anything needing
    // scripts or modern layout goes to the browser instead (HtmlArtifact).
    private readonly HtmlPanel htmlView = new() { Dock = DockStyle.Fill, Visible = false };

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

        textBox.Multiline = true;
        textBox.ReadOnly = true;
        textBox.ScrollBars = ScrollBars.Both;
        textBox.WordWrap = false;
        textBox.Font = new Font("Consolas", 10F);
        textBox.Dock = DockStyle.Fill;
        textBox.BackColor = DarkTheme.Background;
        textBox.ForeColor = DarkTheme.Text;
        textBox.BorderStyle = BorderStyle.None;

        diagramPanel.Dock = DockStyle.Fill;
        diagramPanel.AutoScroll = true;
        diagramPanel.BackColor = DarkTheme.Background;
        diagramPanel.Paint += OnDiagramPaint;

        htmlView.ImageLoad += (_, e) =>
        {
            if (!HtmlArtifact.IsDataUri(e.Src))
            {
                e.Handled = true;
                e.Callback(); // no image
            }
        };
        htmlView.StylesheetLoad += (_, e) => e.SetStyleSheet = "";
        htmlView.LinkClicked += (_, e) => e.Handled = true;

        Controls.Add(htmlView);
        Controls.Add(diagramPanel);
        Controls.Add(textBox);
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
        var versioned = ArtifactDetector.AssignVersion(detected, history);
        history.Add(versioned);
        return how =>
        {
            var html = versioned.Language == "html";
            if (html && (how == ArtifactOpen.Browser || (how == ArtifactOpen.Default && HtmlArtifact.NeedsBrowser(versioned.Content))))
            {
                HtmlArtifact.OpenInBrowser(versioned.Content);
                return;
            }
            if (how == ArtifactOpen.SaveAs)
            {
                SaveAs(versioned);
                return;
            }
            showSource = how == ArtifactOpen.Source;
            var thread = history.Where(a => a.ThreadId == versioned.ThreadId).ToList();
            ShowThread(thread, thread.IndexOf(versioned));
        };
    }

    // Only HTML artifacts offer it (their split button's menu).
    private static void SaveAs(VersionedArtifact artifact)
    {
        using var dialog = new SaveFileDialog { FileName = "artifact.html", Filter = "Web page (*.html)|*.html|All files (*.*)|*.*" };
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

        htmlView.Visible = false;
        if (artifact.Language == "mermaid")
        {
            currentMermaidSource = artifact.Content;
            textBox.Visible = false;
            diagramPanel.Visible = true;
            diagramPanel.Invalidate();
        }
        else
        {
            currentMermaidSource = null;
            diagramPanel.Visible = false;
            textBox.Visible = true;
            textBox.Text = artifact.Content; // HTML's source too, when asked for or HtmlRenderer can't draw it
            if (artifact.Language == "html" && !showSource)
            {
                if (HtmlArtifact.NeedsBrowser(artifact.Content))
                {
                    titleLabel.Text += " (needs a browser -- source shown)";
                }
                else
                {
                    htmlView.Text = artifact.Content;
                    textBox.Visible = false;
                    htmlView.Visible = true;
                }
            }
        }
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
        var size = g.MeasureString(text, textBox.Font, diagramPanel.ClientSize.Width > 0 ? diagramPanel.ClientSize.Width : 2000);
        var scrollSize = new Size((int)size.Width + 20, (int)size.Height + 20);
        if (diagramPanel.AutoScrollMinSize != scrollSize)
        {
            diagramPanel.AutoScrollMinSize = scrollSize;
        }
        // DarkTheme.Text, not Brushes.Black -- diagramPanel's own
        // background is DarkTheme.Background now, not white.
        using var textBrush = new SolidBrush(DarkTheme.Text);
        g.DrawString(text, textBox.Font, textBrush, 10, 10);
    }
}

// #686 (Q1/Q4): what HtmlRenderer can't draw -- scripts, inline event
// handlers, canvas, SVG, flex/grid layout -- opens in the default browser,
// from a temp copy whose CSP stops it making network requests.
internal static class HtmlArtifact
{
    private static readonly Regex BrowserOnly = new(
        @"<script\b|<canvas\b|<svg\b|\son[a-z]+\s*=|display\s*:\s*(inline-)?(flex|grid)\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static bool NeedsBrowser(string html) => BrowserOnly.IsMatch(html);

    public static bool IsDataUri(string? src) => src?.TrimStart().StartsWith("data:", StringComparison.OrdinalIgnoreCase) == true;

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
