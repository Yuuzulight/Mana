using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #528: ports windows-launcher/artifact/'s standalone viewer window --
// Prev/Next navigation through a version thread (ArtifactDetector),
// Mermaid content rendered natively (MermaidParser/MermaidLayout/
// MermaidRenderer, flowcharts only -- sequence diagrams and everything
// else fall back to raw source text, same as an unrecognized/malformed
// diagram), everything else shown as plain monospace text. No markdown
// rendering for non-Mermaid content: artifact content is source
// code/HTML, which doesn't carry markdown inline formatting to begin
// with, so plain monospace text is the correct rendering for it, not a
// lesser fallback.
//
// Unlike the reference (a click affordance in the chat log opens this),
// the native launcher has no chat surface on this branch to host that
// click target in -- ReportReply shows/activates this window directly
// whenever a fresh artifact is detected, a deliberate adaptation given
// what's actually available to wire into right now.
internal sealed class ArtifactViewerForm : Form, IArtifactSink
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

        // Forces the native window handle to exist now, on this (the UI)
        // thread -- ReportReply can fire from VoiceLoop's background
        // continuations before this window has ever been shown, and
        // InvokeRequired/BeginInvoke need a handle that was genuinely
        // created on the UI thread to marshal correctly (InvokeRequired
        // returns false, not throws, when no handle exists yet, which
        // would otherwise let a background thread touch this form's
        // controls directly).
        _ = Handle;
        Hide();
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

    public void ReportReply(string replyText)
    {
        var detected = ArtifactDetector.Extract(replyText);
        if (detected is null)
        {
            return;
        }

        var versioned = ArtifactDetector.AssignVersion(detected.Value, history);
        history.Add(versioned);
        var thread = history.Where(a => a.ThreadId == versioned.ThreadId).ToList();

        RunOnUiThread(() => ShowThread(thread, thread.Count - 1));
    }

    private void RunOnUiThread(Action action)
    {
        if (IsDisposed)
        {
            return;
        }
        if (InvokeRequired)
        {
            BeginInvoke(action);
            return;
        }
        action();
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
            textBox.Text = artifact.Content;
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
