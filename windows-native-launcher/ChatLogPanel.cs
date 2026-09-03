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
    // #521 review: built once, not per "You: ..." line -- a fresh Font
    // per call would leak a GDI handle each time (Font isn't disposed by
    // callers that just assign it to SelectionFont), same reasoning as
    // ChatMarkdown's own font cache.
    private readonly Font userMessageFont;

    public ChatLogPanel()
    {
        ReadOnly = true;
        Dock = DockStyle.Fill;
        Font = new Font("Segoe UI", 10F);
        BorderStyle = BorderStyle.None;
        userMessageFont = new Font(Font, FontStyle.Bold);
    }

    public void AppendUserMessage(string text) => RunOnUiThread(() => AppendPlainLine($"You: {text}"));

    public void AppendReplySentence(string text) => RunOnUiThread(() =>
    {
        ChatMarkdown.Append(this, text);
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

    private void AppendPlainLine(string text)
    {
        var start = TextLength;
        AppendText(text + "\n");
        Select(start, text.Length);
        SelectionFont = userMessageFont;
        SelectionColor = ForeColor;
        SelectionLength = 0;
        ScrollToEnd();
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
