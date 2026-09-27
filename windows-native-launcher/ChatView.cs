using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #652 part 3: the chat pane, custom-drawn so it can take the Mana preset's
// glass look (a RichTextBox can't be see-through). Replaces ChatLogPanel in
// every theme: padded bubbles, "You"/"Mana" labels, markdown (paragraphs,
// headings, bullet/numbered items, inline bold/italic/code, code blocks).
// Mana's sentences stream in one at a time; they all join her current
// bubble until your next message starts a new turn (VoiceLoop always logs
// the user message before a reply).
//
// Copying: click a bubble to select it, then Ctrl+C or right-click Copy;
// right-click "Copy conversation" copies everything. Up/Down move the
// selection. Screen readers see a list with one item per message.
internal sealed class ChatView : Control, IChatLog
{
    private const int SideMargin = 24;
    private const int PadX = 14;
    private const int PadY = 9;
    private const int LabelGap = 3;
    private const int MessageGap = 14;
    private const int BlockGap = 5;
    private const TextFormatFlags TextFlags = TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;
    private static readonly Regex WordPattern = new(@"\S+\s*|\s+", RegexOptions.Compiled);

    private readonly List<Message> messages = new();
    private readonly VScrollBar scrollBar = new() { Dock = DockStyle.Right, Visible = false };
    private readonly Font bodyFont = new("Segoe UI", 10F);
    private readonly Font boldFont;
    private readonly Font italicFont;
    private readonly Font boldItalicFont;
    private readonly Font headerFont = new("Segoe UI", 11F, FontStyle.Bold);
    private readonly Font codeFont = new("Consolas", 9.5F);
    private readonly Font labelFont = new("Segoe UI", 8.5F, FontStyle.Bold);
    private int contentHeight;
    private int selected = -1;
    private Bitmap? glow;
    private (Size Size, Point Offset, Size Window) glowKey;

    public ChatView()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint
                 | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
        Dock = DockStyle.Fill;
        TabStop = true;
        BackColor = DarkTheme.Background;
        ForeColor = DarkTheme.Text;
        boldFont = new Font(bodyFont, FontStyle.Bold);
        italicFont = new Font(bodyFont, FontStyle.Italic);
        boldItalicFont = new Font(bodyFont, FontStyle.Bold | FontStyle.Italic);
        AccessibleName = "Conversation";
        AccessibleRole = AccessibleRole.List;

        scrollBar.ValueChanged += (_, _) => Invalidate();
        Controls.Add(scrollBar);

        var menu = new ContextMenuStrip();
        var copyItem = menu.Items.Add("Copy", null, (_, _) => CopySelected());
        menu.Items.Add("Copy conversation", null, (_, _) => CopyConversation());
        menu.Opening += (_, _) => copyItem.Enabled = selected >= 0;
        ContextMenuStrip = menu;
    }

    // ---- IChatLog -------------------------------------------------------

    public void AppendUserMessage(string text) => RunOnUiThread(() =>
    {
        var message = new Message(fromUser: true);
        message.Blocks.Add(new MarkdownBlock(MarkdownBlockType.Paragraph, new[] { new MarkdownRun(text, false, false, false) }));
        Add(message, forceScroll: true);
    });

    public void AppendReplySentence(string text) => RunOnUiThread(() =>
    {
        var blocks = ChatMarkdownParser.Parse(text);
        if (blocks.Count == 0)
        {
            return;
        }
        if (messages.Count > 0 && !messages[^1].FromUser)
        {
            var current = messages[^1];
            AppendSentence(current, blocks);
            current.Invalidate();
            Relayout(forceScroll: false);
            return;
        }
        var message = new Message(fromUser: false);
        message.Blocks.AddRange(blocks);
        Add(message, forceScroll: false);
    });

    // A plain sentence continues the bubble's last paragraph (space-joined);
    // anything structural (list item, code block, heading) starts its own block.
    internal static void AppendSentence(Message message, IReadOnlyList<MarkdownBlock> blocks)
    {
        var first = blocks[0];
        if (first.Type == MarkdownBlockType.Paragraph && message.Blocks.Count > 0 && message.Blocks[^1].Type == MarkdownBlockType.Paragraph)
        {
            var last = message.Blocks[^1];
            var runs = last.Runs.ToList();
            runs.Add(new MarkdownRun(" ", false, false, false));
            runs.AddRange(first.Runs);
            message.Blocks[^1] = new MarkdownBlock(MarkdownBlockType.Paragraph, runs);
            message.Blocks.AddRange(blocks.Skip(1));
        }
        else
        {
            message.Blocks.AddRange(blocks);
        }
    }

    private void RunOnUiThread(Action action)
    {
        if (IsDisposed || !IsHandleCreated)
        {
            return;
        }
        if (InvokeRequired)
        {
            // Fire-and-forget, same as ChatLogPanel: an append racing the
            // window closing is fine to drop.
            BeginInvoke(action);
            return;
        }
        action();
    }

    private void Add(Message message, bool forceScroll)
    {
        messages.Add(message);
        Relayout(forceScroll);
        AccessibilityNotifyClients(AccessibleEvents.Reorder, -1);
    }

    // ---- Copy -----------------------------------------------------------

    internal IReadOnlyList<Message> Messages => messages;

    internal string ConversationText() =>
        string.Join(Environment.NewLine + Environment.NewLine, messages.Select(m => $"{m.Speaker}: {m.PlainText}"));

    private void CopySelected()
    {
        if (selected >= 0)
        {
            Clipboard.SetText(messages[selected].PlainText);
        }
    }

    private void CopyConversation()
    {
        if (messages.Count > 0)
        {
            Clipboard.SetText(ConversationText());
        }
    }

    // ---- Layout ---------------------------------------------------------

    private int ViewportWidth => Math.Max(1, ClientSize.Width - (scrollBar.Visible ? scrollBar.Width : 0));

    private int MaxBubbleContentWidth => Math.Max(120, Math.Min(640, (int)((ViewportWidth - SideMargin * 2) * 0.72)) - PadX * 2);

    private void Relayout(bool forceScroll)
    {
        var wasAtBottom = scrollBar.Value >= MaxScroll() - 8;
        var y = SideMargin;
        var width = MaxBubbleContentWidth;
        foreach (var message in messages)
        {
            if (message.LaidOutWidth != width)
            {
                LayOut(message, width);
            }
            var bubbleWidth = message.ContentWidth + PadX * 2;
            var x = message.FromUser ? ViewportWidth - SideMargin - bubbleWidth : SideMargin;
            var labelHeight = labelFont.Height;
            message.LabelBounds = new Rectangle(message.FromUser ? x + bubbleWidth - 60 : x, y, 60, labelHeight);
            message.Bounds = new Rectangle(x, y + labelHeight + LabelGap, bubbleWidth, message.ContentHeight + PadY * 2);
            y = message.Bounds.Bottom + MessageGap;
        }
        contentHeight = y;

        var needsScroll = contentHeight > ClientSize.Height;
        if (scrollBar.Visible != needsScroll)
        {
            scrollBar.Visible = needsScroll;
            foreach (var message in messages)
            {
                message.LaidOutWidth = -1; // viewport width changed with the scrollbar
            }
            Relayout(forceScroll);
            return;
        }
        scrollBar.Maximum = Math.Max(0, contentHeight);
        scrollBar.LargeChange = Math.Max(1, ClientSize.Height);
        scrollBar.SmallChange = 40;
        if (forceScroll || wasAtBottom)
        {
            scrollBar.Value = MaxScroll();
        }
        else
        {
            scrollBar.Value = Math.Min(scrollBar.Value, MaxScroll());
        }
        Invalidate();
    }

    private int MaxScroll() => Math.Max(0, contentHeight - ClientSize.Height);

    private void LayOut(Message message, int maxWidth)
    {
        var lines = new List<Line>();
        var y = 0;
        var widest = 0;
        for (var b = 0; b < message.Blocks.Count; b++)
        {
            var block = message.Blocks[b];
            if (b > 0)
            {
                y += BlockGap;
            }
            if (block.Type == MarkdownBlockType.CodeBlock)
            {
                foreach (var sourceLine in string.Concat(block.Runs.Select(r => r.Text)).Replace("\r", "").Split('\n'))
                {
                    foreach (var piece in BreakToWidth(sourceLine.Length == 0 ? " " : sourceLine, codeFont, maxWidth - 12))
                    {
                        var w = Measure(piece, codeFont);
                        lines.Add(new Line(y, codeFont.Height + 2, true, new List<Fragment> { new(piece, codeFont, 6, w, true) }));
                        widest = Math.Max(widest, w + 12);
                        y += codeFont.Height + 2;
                    }
                }
                continue;
            }

            var indent = 0;
            var runs = block.Runs.ToList();
            if (block.Type == MarkdownBlockType.BulletItem)
            {
                runs.Insert(0, new MarkdownRun("•  ", false, false, false));
                indent = Measure("•  ", bodyFont);
            }
            var headerFontFor = block.Type == MarkdownBlockType.Header;
            var line = new List<Fragment>();
            var x = 0;
            var lineHeight = headerFontFor ? headerFont.Height : bodyFont.Height;
            void EndLine()
            {
                lines.Add(new Line(y, lineHeight, false, line));
                widest = Math.Max(widest, x);
                y += lineHeight + 2;
                line = new List<Fragment>();
                x = indent;
            }
            foreach (var run in runs)
            {
                var font = headerFontFor ? headerFont : FontFor(run);
                foreach (Match word in WordPattern.Matches(run.Text))
                {
                    var text = word.Value;
                    var w = Measure(text, font);
                    if (x + w > maxWidth && x > indent)
                    {
                        EndLine();
                        text = text.TrimStart();
                        if (text.Length == 0)
                        {
                            continue;
                        }
                        w = Measure(text, font);
                    }
                    if (w > maxWidth - indent)
                    {
                        foreach (var piece in BreakToWidth(text, font, maxWidth - indent))
                        {
                            if (x > indent)
                            {
                                EndLine();
                            }
                            var pw = Measure(piece, font);
                            line.Add(new Fragment(piece, font, x, pw, run.Code));
                            x += pw;
                        }
                        continue;
                    }
                    line.Add(new Fragment(text, font, x, w, run.Code));
                    x += w;
                }
            }
            if (line.Count > 0)
            {
                EndLine();
            }
        }
        message.Lines = lines;
        message.ContentWidth = Math.Min(maxWidth, Math.Max(widest, 1));
        message.ContentHeight = Math.Max(y - 2, bodyFont.Height);
        message.LaidOutWidth = maxWidth;
    }

    private Font FontFor(MarkdownRun run) =>
        run.Code ? codeFont : run.Bold && run.Italic ? boldItalicFont : run.Bold ? boldFont : run.Italic ? italicFont : bodyFont;

    private static int Measure(string text, Font font) =>
        TextRenderer.MeasureText(text, font, new Size(int.MaxValue, int.MaxValue), TextFlags).Width;

    // Splits text too long for one line into the longest pieces that fit.
    private static IEnumerable<string> BreakToWidth(string text, Font font, int maxWidth)
    {
        var start = 0;
        while (start < text.Length)
        {
            var length = text.Length - start;
            while (length > 1 && Measure(text.Substring(start, length), font) > maxWidth)
            {
                length = Math.Max(1, Math.Min(length - 1, length * 3 / 4)); // shrink fast, then grow back below
            }
            while (start + length < text.Length && Measure(text.Substring(start, length + 1), font) <= maxWidth)
            {
                length++;
            }
            yield return text.Substring(start, length);
            start += length;
        }
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        if (IsHandleCreated)
        {
            Relayout(forceScroll: false); // bubble widths and the scroll range both follow the size
        }
    }

    // ---- Painting -------------------------------------------------------

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        if (DarkTheme.IsGlass && FindForm() is { } form)
        {
            (Size Size, Point Offset, Size Window) key = (ClientSize, form.PointToClient(PointToScreen(Point.Empty)), form.ClientSize);
            if (glow is null || key != glowKey)
            {
                glow?.Dispose();
                glow = GlassSurface.RenderGlow(key.Size, key.Offset, key.Window);
                glowKey = key;
            }
            e.Graphics.DrawImageUnscaled(glow, 0, 0);
            return;
        }
        using var brush = new SolidBrush(DarkTheme.Background);
        e.Graphics.FillRectangle(brush, ClientRectangle);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var scroll = scrollBar.Visible ? scrollBar.Value : 0;
        for (var i = 0; i < messages.Count; i++)
        {
            var message = messages[i];
            var bubble = message.Bounds with { Y = message.Bounds.Y - scroll };
            if (bubble.Bottom < 0 || bubble.Y - labelFont.Height > ClientSize.Height)
            {
                continue;
            }
            var label = message.LabelBounds with { Y = message.LabelBounds.Y - scroll };
            TextRenderer.DrawText(g, message.Speaker, labelFont, label, DarkTheme.Muted,
                TextFlags | (message.FromUser ? TextFormatFlags.Right : TextFormatFlags.Left));

            var fill = message.FromUser ? DarkTheme.UserBubble : DarkTheme.ManaBubble;
            if (DarkTheme.IsGlass)
            {
                using var glass = new SolidBrush(Color.FromArgb(175, fill));
                g.FillRectangle(glass, bubble);
                GlassSurface.PaintGlassEdges(g, bubble, null);
            }
            else
            {
                using var solid = new SolidBrush(fill);
                g.FillRectangle(solid, bubble);
                using var border = new Pen(DarkTheme.Border);
                g.DrawRectangle(border, bubble.X, bubble.Y, bubble.Width - 1, bubble.Height - 1);
            }

            var origin = new Point(bubble.X + PadX, bubble.Y + PadY);
            foreach (var line in message.Lines)
            {
                if (line.Code)
                {
                    using var codeBack = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 110 : 60, DarkTheme.IsLight ? Color.White : Color.Black));
                    g.FillRectangle(codeBack, origin.X, origin.Y + line.Y - 1, message.ContentWidth, line.Height);
                }
                foreach (var fragment in line.Fragments)
                {
                    // Centred on the line, so a smaller code-font span sits level with the words around it.
                    var y = origin.Y + line.Y + (line.Height - fragment.Font.Height) / 2;
                    TextRenderer.DrawText(g, fragment.Text, fragment.Font, new Point(origin.X + fragment.X, y),
                        fragment.IsCode ? DarkTheme.CodeText : DarkTheme.Text, TextFlags);
                }
            }

            if (i == selected)
            {
                using var ring = new Pen(DarkTheme.Accent, 2);
                g.DrawRectangle(ring, bubble.X + 1, bubble.Y + 1, bubble.Width - 3, bubble.Height - 3);
            }
        }
    }

    // ---- Input ----------------------------------------------------------

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        Focus();
        var hit = HitTest(e.Location);
        if (hit != selected && (hit >= 0 || e.Button == MouseButtons.Left))
        {
            Select(hit);
        }
    }

    internal int HitTest(Point point)
    {
        var scroll = scrollBar.Visible ? scrollBar.Value : 0;
        for (var i = 0; i < messages.Count; i++)
        {
            if (messages[i].Bounds.Contains(point.X, point.Y + scroll))
            {
                return i;
            }
        }
        return -1;
    }

    private void Select(int index)
    {
        selected = index;
        if (index >= 0)
        {
            ScrollIntoView(messages[index].Bounds);
            AccessibilityNotifyClients(AccessibleEvents.Focus, index);
            AccessibilityNotifyClients(AccessibleEvents.Selection, index);
        }
        Invalidate();
    }

    private void ScrollIntoView(Rectangle bounds)
    {
        if (!scrollBar.Visible)
        {
            return;
        }
        if (bounds.Y - labelFont.Height < scrollBar.Value)
        {
            scrollBar.Value = Math.Max(0, bounds.Y - labelFont.Height - PadY);
        }
        else if (bounds.Bottom > scrollBar.Value + ClientSize.Height)
        {
            scrollBar.Value = Math.Min(MaxScroll(), bounds.Bottom - ClientSize.Height + PadY);
        }
    }

    protected override bool IsInputKey(Keys keyData) =>
        keyData is Keys.Up or Keys.Down or Keys.Home or Keys.End || base.IsInputKey(keyData);

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (messages.Count == 0)
        {
            return;
        }
        switch (e.KeyData)
        {
            case Keys.Control | Keys.C:
                CopySelected();
                e.Handled = true;
                break;
            case Keys.Up:
                Select(selected <= 0 ? 0 : selected - 1);
                e.Handled = true;
                break;
            case Keys.Down:
                Select(selected < 0 ? messages.Count - 1 : Math.Min(messages.Count - 1, selected + 1));
                e.Handled = true;
                break;
            case Keys.Home:
                Select(0);
                e.Handled = true;
                break;
            case Keys.End:
                Select(messages.Count - 1);
                e.Handled = true;
                break;
        }
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        if (scrollBar.Visible)
        {
            scrollBar.Value = Math.Clamp(scrollBar.Value - e.Delta / 120 * 3 * scrollBar.SmallChange / 2, 0, MaxScroll());
        }
    }

    protected override void OnGotFocus(EventArgs e)
    {
        base.OnGotFocus(e);
        Invalidate();
    }

    // ---- Accessibility --------------------------------------------------

    protected override AccessibleObject CreateAccessibilityInstance() => new ChatAccessibleObject(this);

    private sealed class ChatAccessibleObject : ControlAccessibleObject
    {
        private readonly ChatView view;

        public ChatAccessibleObject(ChatView view) : base(view) => this.view = view;

        public override AccessibleRole Role => AccessibleRole.List;
        public override int GetChildCount() => view.messages.Count;
        public override AccessibleObject? GetChild(int index) =>
            index >= 0 && index < view.messages.Count ? new MessageAccessibleObject(view, index) : null;
        public override AccessibleObject? GetFocused() =>
            view.selected >= 0 ? GetChild(view.selected) : base.GetFocused();
        public override AccessibleObject? GetSelected() => GetFocused();
    }

    private sealed class MessageAccessibleObject : AccessibleObject
    {
        private readonly ChatView view;
        private readonly int index;

        public MessageAccessibleObject(ChatView view, int index)
        {
            this.view = view;
            this.index = index;
        }

        public override string Name => $"{view.messages[index].Speaker}: {view.messages[index].PlainText}";
        public override AccessibleRole Role => AccessibleRole.ListItem;
        public override AccessibleObject Parent => view.AccessibilityObject;
        public override AccessibleStates State =>
            AccessibleStates.Selectable | AccessibleStates.Focusable | AccessibleStates.ReadOnly
            | (view.selected == index ? AccessibleStates.Selected | AccessibleStates.Focused : AccessibleStates.None);
        public override Rectangle Bounds
        {
            get
            {
                var scroll = view.scrollBar.Visible ? view.scrollBar.Value : 0;
                var b = view.messages[index].Bounds;
                return view.RectangleToScreen(b with { Y = b.Y - scroll });
            }
        }
        public override void Select(AccessibleSelection flags) => view.Select(index);
        public override void DoDefaultAction() => view.Select(index);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            bodyFont.Dispose();
            boldFont.Dispose();
            italicFont.Dispose();
            boldItalicFont.Dispose();
            headerFont.Dispose();
            codeFont.Dispose();
            labelFont.Dispose();
            glow?.Dispose();
            ContextMenuStrip?.Dispose();
        }
        base.Dispose(disposing);
    }

    // ---- Model ----------------------------------------------------------

    internal sealed class Message
    {
        public Message(bool fromUser) => FromUser = fromUser;

        public bool FromUser { get; }
        public string Speaker => FromUser ? "You" : "Mana";
        public List<MarkdownBlock> Blocks { get; } = new();
        public List<Line> Lines { get; set; } = new();
        public int LaidOutWidth { get; set; } = -1;
        public int ContentWidth { get; set; }
        public int ContentHeight { get; set; }
        public Rectangle Bounds { get; set; }
        public Rectangle LabelBounds { get; set; }

        public void Invalidate() => LaidOutWidth = -1;

        public string PlainText
        {
            get
            {
                var text = new StringBuilder();
                foreach (var block in Blocks)
                {
                    if (text.Length > 0)
                    {
                        text.AppendLine();
                    }
                    if (block.Type == MarkdownBlockType.BulletItem)
                    {
                        text.Append("• ");
                    }
                    foreach (var run in block.Runs)
                    {
                        text.Append(run.Text);
                    }
                }
                return text.ToString();
            }
        }
    }

    internal sealed record Line(int Y, int Height, bool Code, List<Fragment> Fragments);

    internal sealed record Fragment(string Text, Font Font, int X, int Width, bool IsCode);
}
