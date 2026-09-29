using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Mana.NativeLauncher;

// #528: ports windows-launcher/artifact/'s standalone viewer window --
// Prev/Next navigation through a version thread (ArtifactDetector),
// Mermaid content rendered natively (MermaidParser/MermaidLayout/
// MermaidRenderer, flowcharts only -- sequence diagrams and everything
// else fall back to raw source text, same as an unrecognized/malformed
// diagram), HTML rendered in a locked-down WebView2 (#686), everything
// else shown as plain monospace text. No markdown rendering for other
// content: artifact content is source code, which doesn't carry markdown
// inline formatting to begin with, so plain monospace text is the correct
// rendering for it, not a lesser fallback.
//
// #686: like the reference, the chat opens this from a button on the
// reply's bubble (ChatView calls Add, then the returned action), instead
// of it popping up by itself.
internal sealed class ArtifactViewerForm : Form
{
    private readonly List<VersionedArtifact> history = new();
    private IReadOnlyList<VersionedArtifact> currentThread = Array.Empty<VersionedArtifact>();
    private int currentIndex;
    private string? currentMermaidSource;

    private readonly Label titleLabel = new();
    private readonly Button prevButton = new();
    private readonly Button nextButton = new();
    private readonly TextBox textBox = new();
    private readonly Panel diagramPanel = new();

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
    // since stay reachable with Next). UI thread only.
    public Action Add(DetectedArtifact detected)
    {
        var versioned = ArtifactDetector.AssignVersion(detected, history);
        history.Add(versioned);
        return () =>
        {
            var thread = history.Where(a => a.ThreadId == versioned.ThreadId).ToList();
            ShowThread(thread, thread.IndexOf(versioned));
        };
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

        if (htmlView is not null)
        {
            htmlView.Visible = false;
        }
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
            textBox.Text = artifact.Content; // HTML's source too, until (or if it can't be) rendered
            if (artifact.Language == "html")
            {
                _ = ShowHtmlAsync(artifact);
            }
        }
    }

    // #686: HTML renders in a WebView2 with scripts, host objects and web
    // messages off, so a page has no way to reach Mana; only the artifact
    // itself loads -- its links, redirects, frames and popups go nowhere.
    private WebView2? htmlView;
    private Task? htmlViewReady;
    private int htmlNavigationsAllowed;

    private async Task ShowHtmlAsync(VersionedArtifact artifact)
    {
        try
        {
            htmlViewReady ??= CreateHtmlViewAsync();
            await htmlViewReady;
            if (IsDisposed || currentThread.Count == 0 || currentThread[currentIndex] != artifact)
            {
                return; // moved to another version meanwhile
            }
            htmlNavigationsAllowed++;
            htmlView!.NavigateToString(artifact.Content);
            textBox.Visible = false;
            htmlView.Visible = true;
        }
        catch (Exception ex)
        {
            // No WebView2 runtime, or the page is over its 2 MB limit: the source stays shown.
            Console.WriteLine($"ArtifactViewerForm: couldn't render HTML, showing its source. {ex.Message}");
        }
    }

    private async Task CreateHtmlViewAsync()
    {
        var view = new WebView2 { Dock = DockStyle.Fill, Visible = false };
        Controls.Add(view);
        view.BringToFront(); // docked last, so it fills the space under the nav row
        htmlView = view;
        var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mana", "WebView2"));
        await view.EnsureCoreWebView2Async(environment);
        var core = view.CoreWebView2;
        core.Settings.IsScriptEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsWebMessageEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.NavigationStarting += (_, e) =>
        {
            if (htmlNavigationsAllowed > 0)
            {
                htmlNavigationsAllowed--; // one of ours from NavigateToString
            }
            else
            {
                e.Cancel = true;
            }
        };
        core.FrameNavigationStarting += (_, e) => e.Cancel = true;
        core.NewWindowRequested += (_, e) => e.Handled = true;
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
