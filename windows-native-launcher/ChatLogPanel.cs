using System;
using System.Drawing;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #521: the visible chat pane -- a read-only RichTextBox rendering
// through ChatMarkdown, auto-scrolling to the latest message. Implements
// IChatLog so VoiceLoop can report turns without depending on WinForms.
//
// Every IChatLog method here marshals onto the UI thread before touching
// the control: VoiceLoop's turn-processing chain runs on thread-pool
// continuations (see VoiceLoop's own stateLock comment for its
// threading model), never the UI thread that owns this control.
internal sealed class ChatLogPanel : RichTextBox, IChatLog
{
    // #521 review: built once, not per user message -- a fresh Font per
    // call would leak a GDI handle each time (Font isn't disposed by
    // callers that just assign it to SelectionFont), same reasoning as
    // ChatMarkdown's own font cache.
    private readonly Font userMessageFont;

    public ChatLogPanel()
    {
        ReadOnly = true;
        Dock = DockStyle.Fill;
        Font = new Font("Segoe UI", 10F);
        BorderStyle = BorderStyle.None;
        BackColor = DarkTheme.Background;
        ForeColor = DarkTheme.Text;
        userMessageFont = new Font(Font, FontStyle.Bold);
    }

    // #538's own bubble look, ported onto RichTextBox rather than
    // rebuilding it as hand-drawn Panels/Labels the way #538 did (which
    // leaked a Font and a Control per message -- see that PR's own
    // review): SelectionBackColor already only paints behind the actual
    // text, not the full line width, so it reads as a pill on its own;
    // SelectionAlignment right/left-aligns the whole paragraph the same
    // way #538's bubbles sat on opposite sides. Unlike #538, a muted
    // "You"/"Mana" label is kept inside the bubble (#538 relied on
    // color+side alone) -- review flagged dropping it entirely as a real
    // regression for screen readers and plain-text copy, worth the two
    // extra words.
    public void AppendUserMessage(string text) => RunOnUiThread(() =>
    {
        var start = TextLength;
        AppendLabel("You");
        AppendBubbleText(text);
        ApplyBubbleStyle(start, DarkTheme.UserBubble, HorizontalAlignment.Right);
        ScrollToEnd();
    });

    public void AppendReplySentence(string text) => RunOnUiThread(() =>
    {
        var start = TextLength;
        AppendLabel("Mana");
        ChatMarkdown.Append(this, text);
        ApplyBubbleStyle(start, DarkTheme.ManaBubble, HorizontalAlignment.Left);
        ScrollToEnd();
    });

    private void RunOnUiThread(Action action)
    {
        if (IsDisposed || !IsHandleCreated)
        {
            return;
        }
        if (InvokeRequired)
        {
            // Fire-and-forget by design -- a chat-log append racing the
            // window closing is fine to just drop; nothing awaits this.
            BeginInvoke(action);
            return;
        }
        action();
    }

    // Muted, small speaker label at the start of a bubble -- deliberately
    // not styled through ChatMarkdown (it's not message content), and
    // kept on the same line as what follows rather than its own paragraph
    // so ApplyBubbleStyle's later "whole range" alignment/background
    // still reads as one bubble, not two stacked lines.
    private void AppendLabel(string label)
    {
        var start = TextLength;
        AppendText(label + "  ");
        Select(start, label.Length + 2);
        SelectionFont = userMessageFont;
        SelectionColor = DarkTheme.Muted;
        SelectionLength = 0;
    }

    private void AppendBubbleText(string text)
    {
        var start = TextLength;
        AppendText(text + "\n");
        Select(start, text.Length);
        SelectionFont = Font;
        SelectionColor = ForeColor;
        SelectionLength = 0;
    }

    // Shared by both AppendUserMessage/AppendReplySentence (which append a
    // label plus one or more runs/blocks and know the total range only
    // after the fact) -- applies the bubble background/alignment over
    // everything written since `start`.
    private void ApplyBubbleStyle(int start, Color bubbleColor, HorizontalAlignment alignment)
    {
        var length = TextLength - start;
        if (length <= 0)
        {
            return;
        }
        Select(start, length);
        SelectionBackColor = bubbleColor;
        SelectionAlignment = alignment;
        SelectionLength = 0;
    }

    private void ScrollToEnd()
    {
        SelectionStart = TextLength;
        SelectionLength = 0;
        ScrollToCaret();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            userMessageFont.Dispose();
        }
        base.Dispose(disposing);
    }
}
