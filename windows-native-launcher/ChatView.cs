using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #652 part 3: the chat pane, custom-drawn so it can take the Mana preset's
// glass look (a RichTextBox can't be see-through). Replaces ChatLogPanel in
// every theme: padded bubbles, "You"/"Mana" labels, markdown (paragraphs,
// headings, bullet/numbered items, quotes, tables, inline bold/italic/
// strikethrough/code/links, code blocks). Mana's sentences stream in one at
// a time; they all join her current bubble until your next message starts
// a new turn (VoiceLoop always logs the user message before a reply). Once
// the reply is done, ReportReply re-renders the bubble from the full text.
//
// Copying: drag to select text within or across bubbles, or click a bubble
// to select all of it; then Ctrl+C or right-click Copy. Ctrl+A selects all
// text; right-click "Copy conversation" copies everything with labels.
// Table cells copy tab-separated, so they paste into a spreadsheet. Clicking
// a link opens it in the browser. Up/Down move the bubble selection. Screen
// readers see a list with one item per message.
internal sealed class ChatView : Control, IChatLog, IArtifactSink
{
    private const int SideMargin = 24;
    private const int PadX = 14;
    private const int PadY = 9;
    private const int LabelGap = 3;
    private const int MessageGap = 12;
    private const int RunGap = 3; // between her bubbles in a row

    // Her next bubble joins this one's run: both hers (the same speaker), neither a step line or a request card.
    private static bool GroupsWith(Message message, Message next) =>
        !message.FromUser && !next.FromUser && message.Steps is null && next.Steps is null
        && message.ApprovalId is null && next.ApprovalId is null && message.Speaker == next.Speaker;

    // The time under your message: the time today, the day and time before that.
    internal static string Stamp(DateTime at, DateTime now) =>
        at.Date == now.Date ? at.ToString("h:mm tt", System.Globalization.CultureInfo.InvariantCulture)
        : at.ToString("MMM d, h:mm tt", System.Globalization.CultureInfo.InvariantCulture);
    private const int BlockGap = 5;
    private const int ActionHeight = 28;
    private const int MenuArrowWidth = 22; // a split button's dropdown part
    private const int QuoteIndent = 12;
    private const int CellPad = 6;
    private const TextFormatFlags TextFlags = TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;
    private static readonly Regex WordPattern = new(@"\S+\s*|\s+", RegexOptions.Compiled);

    private readonly List<Message> messages = new();
    private readonly VScrollBar scrollBar = new() { Dock = DockStyle.Right, Visible = false };
    // Whether the scroll bar is on. Not read back from scrollBar.Visible,
    // which stays false while the window is hidden (then Relayout would
    // keep switching it on forever).
    private bool scrolling;
    private readonly Font bodyFont = new("Segoe UI", 10F);
    private readonly Dictionary<FontStyle, Font> styledFonts = new(); // bodyFont in bold/italic/strikeout/underline mixes
    private readonly Font headerFont = new("Segoe UI", 11F, FontStyle.Bold);
    private readonly Font codeFont = new("Consolas", 9.5F);
    private readonly Font labelFont = new("Segoe UI", 8.5F, FontStyle.Bold);
    private readonly Font stampFont = new("Segoe UI", 8.25F); // the footer: your time, her name
    private readonly Font greetingFont = new("Segoe UI Semibold", 15F); // the welcome's greeting (mockup B)
    private readonly ToolTip linkTip = new();
    private string? hoveredLink;
    private int hoveredIndex = -1;
    // Mockup A's code Copy button: which block just copied (it says "Copied" for a moment).
    private (int Message, int Block)? copiedBlock;
    private readonly System.Windows.Forms.Timer copiedReset = new() { Interval = 1500 };

    // Where a Copy button's text goes: the clipboard (tests read it from here instead).
    internal Action<string> CopyText { get; set; } = Clipboard.SetText;
    private int contentHeight;
    private int selected = -1;
    private (int Msg, int Offset)? anchor;
    private (int Msg, int Offset)? caret;
    private Point pressPoint;
    private bool pressed;
    private bool dragSelecting;
    private Bitmap? glow;
    private (Size Size, Point Offset, Size Window, int Theme, (Point, bool, int) Backdrop) glowKey;
    // The UI thread, captured at construction: the view has no handle until
    // the chat window is first shown, and appends made before then (the
    // reopened session's history at launch, voice turns) must still land.
    private readonly int uiThreadId = Environment.CurrentManagedThreadId;
    private readonly System.Threading.SynchronizationContext? uiContext;

    // #1322: Chat branching, message editing, reply regeneration, and version stepping
    public event Action<int, string>? OnEditMessage;
    public event Action<int>? OnRegenerateReply;
    public event Action<int>? OnBranchFromMessage;
    public event Action<int, int>? OnSwitchTurnVersion;

    public ChatView()
    {
        Controls.Add(welcomeAvatar);
        copiedReset.Tick += (_, _) =>
        {
            copiedReset.Stop();
            copiedBlock = null;
            Invalidate();
        };
        uiContext = System.Threading.SynchronizationContext.Current; // installed by Control's constructor
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint
                 | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
        Dock = DockStyle.Fill;
        TabStop = true;
        BackColor = DarkTheme.Background;
        ForeColor = DarkTheme.Text;
        AccessibleName = "Conversation";
        AccessibleRole = AccessibleRole.List;

        scrollBar.ValueChanged += (_, _) => Invalidate();
        Controls.Add(scrollBar);

        var menu = new ContextMenuStrip();
        var copyItem = menu.Items.Add("Copy", null, (_, _) => CopySelected());
        menu.Items.Add("Copy conversation", null, (_, _) => CopyConversation());
        menu.Items.Add(new ToolStripSeparator());
        var editItem = menu.Items.Add("Edit message (E / F2)", null, (_, _) =>
        {
            if (selected >= 0 && selected < messages.Count && messages[selected].FromUser && messages[selected].TurnIndex >= 0)
            {
                OnEditMessage?.Invoke(messages[selected].TurnIndex, messages[selected].PlainText);
            }
        });
        var regenItem = menu.Items.Add("Regenerate reply (R)", null, (_, _) =>
        {
            if (selected >= 0 && selected < messages.Count && !messages[selected].FromUser && messages[selected].TurnIndex >= 0)
            {
                OnRegenerateReply?.Invoke(messages[selected].TurnIndex);
            }
        });
        var branchItem = menu.Items.Add("Branch from here (B)", null, (_, _) =>
        {
            if (selected >= 0 && selected < messages.Count && messages[selected].TurnIndex >= 0)
            {
                OnBranchFromMessage?.Invoke(messages[selected].TurnIndex);
            }
        });
        menu.Opening += (_, _) =>
        {
            copyItem.Enabled = selected >= 0 || HasTextSelection;
            var hasMsg = selected >= 0 && selected < messages.Count && messages[selected].TurnIndex >= 0;
            editItem.Visible = hasMsg && messages[selected].FromUser;
            regenItem.Visible = hasMsg && !messages[selected].FromUser;
            branchItem.Visible = hasMsg;
        };
        ContextMenuStrip = menu;
    }

    // ---- IChatLog -------------------------------------------------------

    // When the latest user message was logged (UTC) -- the start of the
    // current turn, for telling which edits it produced.
    public DateTime? LastUserMessageAt { get; private set; }

    public void AppendUserMessage(string text) => AppendUserMessage(text, Array.Empty<string>(), null);

    public void AppendUserMessage(string text, IReadOnlyList<string> images) => AppendUserMessage(text, images, null);

    // #679: images show as thumbnails above the text; an image-only
    // message has no text line.
    // #1325: documents show as attached document cards with name and size.
    public void AppendUserMessage(string text, IReadOnlyList<string> images, IReadOnlyList<string>? documents) => RunOnUiThread(() =>
    {
        LastUserMessageAt = DateTime.UtcNow;
        var turnIndex = messages.Count(m => m.FromUser);
        var message = new Message(fromUser: true) { TurnIndex = turnIndex, At = DateTime.Now };
        foreach (var image in images)
        {
            if (DecodeThumbnail(image) is { } thumb)
            {
                message.Images.Add(thumb);
            }
        }
        if (documents is { Count: > 0 })
        {
            foreach (var doc in documents)
            {
                var docName = Path.GetFileName(doc);
                string sizeStr = "";
                try
                {
                    if (File.Exists(doc))
                    {
                        sizeStr = $" ({ImageAttachmentStrip.FormatFileSize(new FileInfo(doc).Length)})";
                    }
                }
                catch
                {
                }
                message.Blocks.Add(new MarkdownBlock(MarkdownBlockType.Paragraph, new[] {
                    new MarkdownRun($"📎 {docName}{sizeStr}", true, false, false)
                }));
            }
        }
        if (text.Length > 0 || (message.Images.Count == 0 && (documents == null || documents.Count == 0)))
        {
            message.Blocks.AddRange(UserBlocks(text));
        }
        Add(message, forceScroll: true);
    });

    // My message as typed -- except text I shared from My shell (#1121),
    // which Mana gets framed as outside text: the chat shows it as a
    // "Shared from terminal" card with the text in a monospace box.
    internal static IReadOnlyList<MarkdownBlock> UserBlocks(string text)
    {
        if (UntrustedText.Unwrap(MyShellPanel.SharedSource, text) is not { } shared)
        {
            return [new MarkdownBlock(MarkdownBlockType.Paragraph, new[] { new MarkdownRun(text, false, false, false) })];
        }
        return
        [
            new MarkdownBlock(MarkdownBlockType.Paragraph, new[] { new MarkdownRun("Shared from terminal", true, false, false) }),
            new MarkdownBlock(MarkdownBlockType.CodeBlock, new[] { new MarkdownRun(shared.ReplaceLineEndings("\n"), false, false, true) }),
        ];
    }

    private const int ThumbnailSide = 160;

    // A data URL's image scaled to ThumbnailSide, or null if it isn't one.
    internal static Bitmap? DecodeThumbnail(string dataUrl)
    {
        var comma = dataUrl.IndexOf(',');
        try
        {
            using var stream = new System.IO.MemoryStream(Convert.FromBase64String(dataUrl[(comma + 1)..]));
            using var image = Image.FromStream(stream);
            return new Bitmap(image, ScreenCapture.FitWithin(image.Size, ThumbnailSide));
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException)
        {
            return null;
        }
    }

    public void AppendReplySentence(string text) => AppendReplySentence(text, null);

    // #914: a sentence from another character than the open reply's (group
    // mode's second reply) starts her own message, labelled with her name.
    public void AppendReplySentence(string text, string? speaker) => RunOnUiThread(() =>
    {
        var blocks = ChatMarkdownParser.Parse(text);
        if (blocks.Count == 0)
        {
            return;
        }
        if (messages.Count > 0 && !messages[^1].FromUser && messages[^1].Steps is null && (speaker is null || messages[^1].Speaker == speaker))
        {
            var current = messages[^1];
            if (current.FinalText == text)
            {
                return; // VoiceLoop's non-streamed fallback logging the reply it just reported
            }
            if (current.FinalText is null)
            {
                AppendSentence(current, blocks);
                current.Invalidate();
                Relayout(forceScroll: false);
                return;
            }
        }
        var lastUser = messages.FindLast(m => m.FromUser);
        var message = new Message(fromUser: false) { Name = speaker, TurnIndex = lastUser?.TurnIndex ?? -1 };
        message.Blocks.AddRange(blocks);
        Add(message, forceScroll: false);
    });

    // #1354: live reasoning/thought token streaming and final consolidated thought
    public void AppendReplyThought(string text, string? speaker = null) => RunOnUiThread(() =>
    {
        if (string.IsNullOrEmpty(text))
        {
            return;
        }
        Message current;
        if (messages.Count > 0 && !messages[^1].FromUser && messages[^1].Steps is null && (speaker is null || messages[^1].Speaker == speaker) && messages[^1].FinalText is null)
        {
            current = messages[^1];
        }
        else
        {
            var lastUser = messages.FindLast(m => m.FromUser);
            current = new Message(fromUser: false) { Name = speaker, TurnIndex = lastUser?.TurnIndex ?? -1 };
            Add(current, forceScroll: false);
        }
        current.Thought = (current.Thought ?? "") + text;
        current.Invalidate();
        Relayout(forceScroll: false);
    });

    public void SetReplyThought(string thought, string? speaker = null) => RunOnUiThread(() =>
    {
        if (string.IsNullOrWhiteSpace(thought))
        {
            return;
        }
        if (messages.Count > 0 && !messages[^1].FromUser && messages[^1].Steps is null && (speaker is null || messages[^1].Speaker == speaker))
        {
            var current = messages[^1];
            current.Thought = thought;
            current.Invalidate();
            Relayout(forceScroll: false);
        }
    });

    // #687: a reopened or switched-to session's stored turns, replacing the
    // conversation shown. Artifacts stay inline here.
    public void ShowHistory(IReadOnlyList<ManaSessionTurn> turns) => RunOnUiThread(() =>
    {
        foreach (var image in messages.SelectMany(message => message.Images)) image.Dispose();
        messages.Clear();
        polledSteps.Clear(); // #1318: re-added after the history on the next poll
        streamedSteps.Clear();
        selected = -1;
        ClearTextSelection();
        var now = DateTimeOffset.UtcNow;
        for (var i = 0; i < turns.Count; i++)
        {
            var turn = turns[i];
            var turnIdx = turn.TurnIndex >= 0 ? turn.TurnIndex : i;
            if (turn.Notice is { } notice)
            {
                messages.Add(TaskNoticeMessage(notice));
                continue;
            }
            if (!string.IsNullOrWhiteSpace(turn.User))
            {
                var user = new Message(fromUser: true) { TurnIndex = turnIdx, At = DateTimeOffset.TryParse(turn.At, out var at) ? at.LocalDateTime : null };
                user.Blocks.AddRange(UserBlocks(turn.User));
                messages.Add(user);
            }
            if (string.IsNullOrWhiteSpace(turn.Assistant))
            {
                continue;
            }
            // #1337: her saved steps where they showed live.
            var first = true;
            foreach (var (text, group) in ChatStepGroups.Interleave(turn.Assistant, turn.Steps))
            {
                var reply = new Message(fromUser: false)
                {
                    FinalText = text,
                    AnswerModel = turn.AnswerModel,
                    CloudFallback = turn.CloudFallback,
                    Steps = group,
                    Thought = first && group is null ? turn.Thought : null,
                    TurnIndex = turnIdx,
                    Versions = turn.Versions,
                    VersionIndex = turn.VersionIndex
                };
                if (group is null)
                {
                    first = false;
                    reply.Blocks.AddRange(ChatMarkdownParser.Parse(text!));
                }
                else
                {
                    SetStepBlocks(reply, now);
                }
                messages.Add(reply);
            }
            var outputMessage = messages.LastOrDefault(message => !message.FromUser && message.Steps is null && message.TurnIndex == turnIdx);
            if (outputMessage is not null) AttachAnalysisOutputs(outputMessage, turn.AnalysisOutputs);
        }
        AccessibilityNotifyClients(AccessibleEvents.Reorder, -1);
        Relayout(forceScroll: true);
    });

    // #686: records a detected artifact with the viewer (ArtifactViewerForm.Add)
    // and returns what opens it; null means artifacts stay inline.
    public Func<DetectedArtifact, Action<ArtifactOpen>>? Artifacts { get; set; }

    // VoiceLoop reports each finished reply's full text. Streamed sentences
    // lose the line breaks between them and a long table or code block is
    // cut mid-line, so Mana's bubble is re-parsed from the real text. As in
    // Electron, the reply's artifact (a big or ```html/```mermaid block)
    public void ReportReply(string replyText) => ReportReply(replyText, null);

    public void SetAnswerModel(string? model, bool fallback) => RunOnUiThread(() =>
    {
        var message = messages.LastOrDefault(m => !m.FromUser && m.Steps is null);
        if (message is null) return;
        message.AnswerModel = model;
        message.CloudFallback = fallback;
        Relayout(forceScroll: false);
        Invalidate();
    });

    public void ReportAnalysisOutputs(AnalysisOutputs outputs) => RunOnUiThread(() =>
    {
        var lastUser = messages.FindLastIndex(message => message.FromUser);
        var message = messages.Skip(lastUser + 1).LastOrDefault(message => !message.FromUser && message.Steps is null);
        if (message is null) return;
        AttachAnalysisOutputs(message, outputs);
        message.Invalidate();
        Relayout(forceScroll: false);
    });

    private void AttachAnalysisOutputs(Message message, AnalysisOutputs outputs)
    {
        foreach (var image in message.Images) image.Dispose();
        message.Images.Clear();
        foreach (var action in message.AnalysisActions) message.Actions.Remove(action);
        message.AnalysisActions.Clear();
        foreach (var block in message.AnalysisBlocks) message.Blocks.Remove(block);
        message.AnalysisBlocks.Clear();
        foreach (var table in outputs.Tables)
        {
            var rows = new List<IReadOnlyList<IReadOnlyList<MarkdownRun>>>();
            rows.Add(table.Columns.Select(cell => (IReadOnlyList<MarkdownRun>)new[] { new MarkdownRun(cell, true, false, false) }).ToArray());
            rows.AddRange(table.Rows.Select(row => (IReadOnlyList<IReadOnlyList<MarkdownRun>>)row.Select(cell => (IReadOnlyList<MarkdownRun>)new[] { new MarkdownRun(cell, false, false, false) }).ToArray()));
            var block = new MarkdownBlock(MarkdownBlockType.Table, [], Rows: rows);
            message.Blocks.Add(block);
            message.AnalysisBlocks.Add(block);
        }
        var downloads = new List<ChatMenuItem>();
        void SaveAction(string name, string data)
        {
            downloads.Add(new ChatMenuItem(name, true, async () =>
            {
                using var dialog = new SaveFileDialog { FileName = name, OverwritePrompt = true, CheckPathExists = true };
                if (dialog.ShowDialog(FindForm()) == DialogResult.OK)
                    await System.IO.File.WriteAllBytesAsync(dialog.FileName, Convert.FromBase64String(data));
                return null;
            }));
        }
        var chartIndex = 0;
        foreach (var chart in outputs.Charts)
        {
            try
            {
                using var stream = new System.IO.MemoryStream(Convert.FromBase64String(chart.DataUrl["data:image/png;base64,".Length..]));
                using var image = Image.FromStream(stream);
                if (image.Width > 4096 || image.Height > 4096 || (long)image.Width * image.Height > 4000000) continue;
                message.Images.Add(new Bitmap(image));
                SaveAction($"chart{++chartIndex}.png", chart.DataUrl["data:image/png;base64,".Length..]);
            }
            catch (Exception error) when (error is FormatException or ArgumentException or OutOfMemoryException) { }
        }
        foreach (var file in outputs.Files) SaveAction(file.Name, file.Data);
        if (downloads.Count > 0)
        {
            var action = new ChatAction("Save as...", false, downloads[0].Run, Keep: true, Menu: downloads);
            message.Actions.Add(action);
            message.AnalysisActions.Add(action);
        }
    }

    // #1329: ReportReply with verified web sources citations.
    public void ReportReply(string replyText, IReadOnlyList<WebSourceCitation>? sources) => RunOnUiThread(() =>
    {
        var addArtifact = Artifacts;
        var artifact = addArtifact is null ? null : ArtifactDetector.Extract(replyText);
        var blocks = ChatMarkdownParser.Parse(artifact is { } found ? replyText.Replace(found.MatchedText, "").Trim() : replyText).ToList();
        if (sources is { Count: > 0 })
        {
            blocks.Add(new MarkdownBlock(MarkdownBlockType.Header, new[] { new MarkdownRun("Sources", Bold: true, Italic: false, Code: false) }, Level: 3));
            foreach (var s in sources)
            {
                var runs = new List<MarkdownRun>
                {
                    new($"[{s.Index}] ", Bold: true, Italic: false, Code: false),
                    new(string.IsNullOrWhiteSpace(s.Title) ? s.Url : s.Title, Bold: false, Italic: false, Code: false, Link: s.Url)
                };
                blocks.Add(new MarkdownBlock(MarkdownBlockType.BulletItem, runs));
            }
        }
        if (blocks.Count == 0 && artifact is null)
        {
            return;
        }
        // #1318: a reply split by step lines keeps its streamed segments --
        // re-parsing the whole text into the last one would repeat the rest.
        // ponytail: those segments keep the streamed sentences' formatting.
        var lastUser = messages.FindLastIndex(m => m.FromUser);
        if (messages.Skip(lastUser + 1).Any(m => m.Steps is not null))
        {
            var last = messages.FindLast(m => !m.FromUser && m.Steps is null && m.FinalText is null);
            if (last is not null && messages.IndexOf(last) > lastUser)
            {
                last.FinalText = replyText;
                last.Sources = sources?.ToList();
                if (sources is { Count: > 0 })
                {
                    last.Blocks.Add(new MarkdownBlock(MarkdownBlockType.Header, new[] { new MarkdownRun("Sources", Bold: true, Italic: false, Code: false) }, Level: 3));
                    foreach (var s in sources)
                    {
                        var runs = new List<MarkdownRun>
                        {
                            new($"[{s.Index}] ", Bold: true, Italic: false, Code: false),
                            new(string.IsNullOrWhiteSpace(s.Title) ? s.Url : s.Title, Bold: false, Italic: false, Code: false, Link: s.Url)
                        };
                        last.Blocks.Add(new MarkdownBlock(MarkdownBlockType.BulletItem, runs));
                    }
                }
                if (artifact is { } split)
                {
                    last.Actions.Add(ArtifactAction(split, addArtifact!(split)));
                }
                last.Invalidate();
                Relayout(forceScroll: false);
            }
            return;
        }
        var message = messages.Count > 0 && !messages[^1].FromUser && messages[^1].FinalText is null && messages[^1].Steps is null
            ? messages[^1]
            : null;
        var lastUserMsg = messages.FindLast(m => m.FromUser);
        if (message is null)
        {
            message = new Message(fromUser: false) { TurnIndex = lastUserMsg?.TurnIndex ?? -1 };
            messages.Add(message);
            AccessibilityNotifyClients(AccessibleEvents.Reorder, -1);
        }
        else if (lastUserMsg != null && message.TurnIndex < 0)
        {
            message.TurnIndex = lastUserMsg.TurnIndex;
        }
        message.Blocks.Clear();
        message.Blocks.AddRange(blocks);
        message.FinalText = replyText;
        message.Sources = sources?.ToList();
        if (artifact is { } a)
        {
            message.Actions.Add(ArtifactAction(a, addArtifact!(a)));
        }
        message.Invalidate();
        Relayout(forceScroll: false);
    });

    // #686 (Q4/Q44b): an HTML artifact gets an "Open" split button whose
    // main part opens it in Mana when Folio can draw it (#937), else in the
    // browser; the arrow lists every way. Other artifacts open in the viewer.
    private static ChatAction ArtifactAction(DetectedArtifact artifact, Action<ArtifactOpen> open)
    {
        Func<Task<string?>> Run(ArtifactOpen how) => () =>
        {
            open(how);
            return Task.FromResult<string?>(null);
        };
        if (artifact.Language != "html")
        {
            return new ChatAction($"Open {artifact.Language} content in new window", false, Run(ArtifactOpen.Default), Keep: true);
        }
        var whyBrowser = HtmlArtifact.BrowserReasons(artifact.Content);
        return new ChatAction("Open", false, Run(ArtifactOpen.Default), Keep: true, Menu: new[]
        {
            new ChatMenuItem(whyBrowser is null ? "Open in Mana" : $"Open in Mana (needs a browser: {whyBrowser})", whyBrowser is null, Run(ArtifactOpen.InMana)),
            new ChatMenuItem("Open in browser", true, Run(ArtifactOpen.Browser)),
            new ChatMenuItem("View source", true, Run(ArtifactOpen.Source)),
            new ChatMenuItem("Save as...", true, Run(ArtifactOpen.SaveAs)),
        });
    }

    // #1318: the reply's step groups, each placed after the reply text
    // before it: a group not shown yet goes at the end, which is right after
    // that text while it's streaming in. Groups with neither a segment nor a
    // textOffset are ChatStepsStrip's. A new run starts a new set.
    // #1337: steps with a textOffset come from the reply stream's own "tool"
    // events (ShowStreamSteps), in order with its sentences, so they land
    // exactly. The poll (ShowSteps) only places older backends' steps, where
    // a tool round shorter than the poll can land after the next text.
    private readonly StepPlacement polledSteps = new();
    private readonly StepPlacement streamedSteps = new();

    private sealed class StepPlacement
    {
        public string? RunId;
        public readonly Dictionary<string, Message> Lines = new(); // by each group's first step

        public void Clear()
        {
            RunId = null;
            Lines.Clear();
        }
    }

    public void ShowSteps(AgentSteps activity) =>
        PlaceSteps(polledSteps, activity with { Steps = activity.Steps.Where(s => s.TextOffset is null).ToList() });

    public void ShowStreamSteps(AgentSteps activity) => PlaceSteps(streamedSteps, activity);

    private void PlaceSteps(StepPlacement placement, AgentSteps activity) => RunOnUiThread(() =>
    {
        if (activity.RunId != placement.RunId)
        {
            placement.Clear();
            placement.RunId = activity.RunId;
        }
        var now = DateTimeOffset.UtcNow;
        var changed = false;
        foreach (var group in ChatStepGroups.Group(activity))
        {
            if (group.Segment is null && group.Steps[0].TextOffset is null)
            {
                continue;
            }
            if (!placement.Lines.TryGetValue(group.Steps[0].Id, out var message))
            {
                message = new Message(fromUser: false);
                placement.Lines[group.Steps[0].Id] = message;
                messages.Add(message);
                AccessibilityNotifyClients(AccessibleEvents.Reorder, -1);
            }
            message.Steps = group;
            changed |= SetStepBlocks(message, now);
        }
        if (changed)
        {
            Relayout(forceScroll: false);
        }
    });

    // #1337: clicking a sub-agent's or finished task's line opens its
    // transcript: (task id, title, whether it may still be running).
    public Action<string, string, Func<bool>>? OpenTask { get; set; }

    // Tasks a notice said ended, so their transcript stops refreshing.
    private readonly HashSet<string> endedTasks = new();

    // #1337: a background task started from this chat ended (the tray socket).
    public void AppendTaskNotice(ManaTaskNotice notice) => RunOnUiThread(() => Add(TaskNoticeMessage(notice), forceScroll: false));

    private Message TaskNoticeMessage(ManaTaskNotice notice)
    {
        endedTasks.Add(notice.TaskId);
        var message = new Message(fromUser: false) { Steps = ChatStepGroups.TaskNotice(notice.TaskId, notice.Title, notice.Status, notice.Text) };
        SetStepBlocks(message, DateTimeOffset.UtcNow);
        return message;
    }

    private static bool SetStepBlocks(Message message, DateTimeOffset now)
    {
        var blocks = ChatStepGroups.Blocks(message.Steps!, message.StepsOpen, now);
        if (blocks.SequenceEqual(message.Blocks, MarkdownBlockText.Instance))
        {
            return false;
        }
        message.Blocks.Clear();
        message.Blocks.AddRange(blocks);
        message.Invalidate();
        return true;
    }

    // Blocks compared by their text (MarkdownBlock's own equality compares
    // its run lists by reference).
    private sealed class MarkdownBlockText : IEqualityComparer<MarkdownBlock>
    {
        public static readonly MarkdownBlockText Instance = new();
        public bool Equals(MarkdownBlock a, MarkdownBlock b) => a.Type == b.Type && a.Runs.SequenceEqual(b.Runs);
        public int GetHashCode(MarkdownBlock block) => block.Type.GetHashCode();
    }

    // Step-line text: grey, the +added total green, the -removed one red.
    internal static Color StepColor(string fragment)
    {
        var text = fragment.Trim();
        return text.Length > 1 && text[1..].All(char.IsDigit)
            ? text.StartsWith(ChatStepGroups.AddedPrefix, StringComparison.Ordinal) ? DarkTheme.Green
            : text.StartsWith(ChatStepGroups.RemovedPrefix, StringComparison.Ordinal) ? ChatStepsStrip.RemovedColor
            : DarkTheme.Muted
            : DarkTheme.Muted;
    }

    // #652 part 6: raised when Mana's reply is complete; SessionListForm
    // checks then for edits to approve and attaches buttons for them.
    public event Action? ReplyEnded;

    public void ReplyFinished() => RunOnUiThread(() => ReplyEnded?.Invoke());

    // #619: SessionListForm shows it in the avatar card's status line.
    public event Action<string?>? HearingChanged;
    public event Action<string>? ManaMessageAppended;

    public void ShowHearing(string? text) => RunOnUiThread(() => HearingChanged?.Invoke(text));

    // #690: a message from Mana outside any turn (an ambient screen glance)
    // -- always its own, finished bubble, never merged into a reply that's
    // still open (e.g. one cut off by a barge-in).
    public void AppendManaMessage(string text) => RunOnUiThread(() =>
    {
        var blocks = ChatMarkdownParser.Parse(text);
        if (blocks.Count == 0)
        {
            return;
        }
        var message = new Message(fromUser: false) { FinalText = text };
        message.Blocks.AddRange(blocks);
        Add(message, forceScroll: false);
        ManaMessageAppended?.Invoke(text);
    });

    // #914: "Noted: ..." -- her relationship note or milestone, its own
    // finished line with an Undo button (never merged into the reply).
    public void AppendNoted(string? speaker, string text, Func<Task<string?>> undo) => RunOnUiThread(() =>
    {
        var message = new Message(fromUser: false) { Name = speaker, FinalText = text };
        message.Blocks.AddRange(ChatMarkdownParser.Parse(text));
        message.Actions.Add(new ChatAction("Undo", false, undo));
        Add(message, forceScroll: false);
    });

    // #1426 stage 3: a request from this chat waiting on my OK, as a card
    // with its answers. Answered here, the answer's note replaces them;
    // answered in "Waiting for you", EndApprovalCard does.
    public void ShowApprovalCard(string id, string text, IReadOnlyList<ChatAction> actions) => RunOnUiThread(() =>
    {
        if (messages.Any(m => m.ApprovalId == id))
        {
            return;
        }
        var message = new Message(fromUser: false) { ApprovalId = id, FinalText = text };
        message.Blocks.AddRange(ChatMarkdownParser.Parse(text));
        message.Actions.AddRange(actions);
        Add(message, forceScroll: false);
    });

    public void EndApprovalCard(string id, string note) => RunOnUiThread(() =>
    {
        if (messages.FirstOrDefault(m => m.ApprovalId == id) is not { ActionRunning: false } message || message.Actions.Count == 0)
        {
            return;
        }
        message.Actions.Clear();
        message.Note = note;
        message.Invalidate();
        Relayout(forceScroll: false);
    });

    // The cards still waiting for an answer.
    internal IReadOnlyList<string> OpenApprovalCards =>
        messages.Where(m => m.ApprovalId is not null && m.Actions.Count > 0).Select(m => m.ApprovalId!).ToList();

    // Puts buttons under Mana's latest message (replacing any it had, except
    // kept ones like the artifact button, which move after the new ones).
    public void AttachActions(IReadOnlyList<ChatAction> actions)
    {
        var message = messages.LastOrDefault(m => !m.FromUser);
        if (message is null)
        {
            return;
        }
        var kept = message.Actions.Where(a => a.Keep).ToList();
        message.Actions.Clear();
        message.Actions.AddRange(actions);
        message.Actions.AddRange(kept);
        message.Note = null;
        message.Invalidate();
        Relayout(forceScroll: false);
    }

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
        if (IsDisposed)
        {
            return;
        }
        if (Environment.CurrentManagedThreadId == uiThreadId)
        {
            action();
            return;
        }
        // Fire-and-forget, same as ChatLogPanel: an append racing the
        // window closing is fine to drop.
        uiContext?.Post(_ =>
        {
            if (!IsDisposed)
            {
                action();
            }
        }, null);
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

    // Copies the dragged text selection if there is one, else the selected bubble.
    private void CopySelected()
    {
        if (HasTextSelection)
        {
            Clipboard.SetText(SelectedText());
        }
        else if (selected >= 0)
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

    private int ViewportWidth => Math.Max(1, ClientSize.Width - (scrolling ? scrollBar.Width : 0));

    private int MaxBubbleContentWidth => Math.Max(120, Math.Min(640, (int)((ViewportWidth - SideMargin * 2) * 0.72)) - PadX * 2);

    private void Relayout(bool forceScroll)
    {
        NotifyEmpty();
        if (messages.Count == 0)
        {
            LayOutWelcome();
        }
        var wasAtBottom = scrollBar.Value >= MaxScroll() - 8;
        var y = SideMargin;
        var width = MaxBubbleContentWidth;
        for (var i = 0; i < messages.Count; i++)
        {
            var message = messages[i];
            if (message.LaidOutWidth != width)
            {
                LayOut(message, width);
            }
            var bubbleWidth = message.ContentWidth + PadX * 2;
            var x = message.FromUser ? ViewportWidth - SideMargin - bubbleWidth : SideMargin;
            message.Bounds = new Rectangle(x, y, bubbleWidth, message.ContentHeight + PadY * 2);
            // The mockups: no name over the bubbles. Her bubbles in a row sit together; under the last of a run (and
            // under each of yours) a footer line: your message's time, or her name, with the actions, on hover.
            var continues = i + 1 < messages.Count && GroupsWith(message, messages[i + 1]);
            var footerHeight = message.Steps is null && !continues ? labelFont.Height + LabelGap : 0;
            var footerTop = message.Bounds.Bottom + (footerHeight > 0 ? LabelGap : 0);
            var labelText = message.FromUser ? (message.At is { } at ? Stamp(at, DateTime.Now) : "") : message.Speaker;
            var labelWidth = message.FromUser ? Measure(labelText, stampFont) : Math.Min(Math.Max(40, ViewportWidth - SideMargin * 2 - 200), Math.Max(60, Measure(labelText, stampFont)));
            message.LabelBounds = new Rectangle(message.FromUser ? x + bubbleWidth - labelWidth : x, footerTop, labelWidth, footerHeight);
            y = footerTop;

            // #1322: Action and version stepper button layout
            message.EditBtnBounds = Rectangle.Empty;
            message.RegenerateBtnBounds = Rectangle.Empty;
            message.BranchBtnBounds = Rectangle.Empty;
            message.VersionPrevBounds = Rectangle.Empty;
            message.VersionNextBounds = Rectangle.Empty;
            message.VersionLabelBounds = Rectangle.Empty;

            if (message.Steps is null && message.TurnIndex >= 0 && footerHeight > 0)
            {
                var btnHeight = labelFont.Height + 2;
                if (message.FromUser)
                {
                    var curX = message.LabelBounds.Left - 6;

                    var branchW = 46;
                    curX -= branchW;
                    message.BranchBtnBounds = new Rectangle(curX, y, branchW, btnHeight);
                    curX -= 4;

                    var editW = 34;
                    curX -= editW;
                    message.EditBtnBounds = new Rectangle(curX, y, editW, btnHeight);
                    curX -= 6;

                    if (message.Versions != null && message.Versions.Count > 1)
                    {
                        var nextW = 16;
                        curX -= nextW;
                        message.VersionNextBounds = new Rectangle(curX, y, nextW, btnHeight);

                        var lblText = $"{message.VersionIndex + 1}/{message.Versions.Count}";
                        var lblW = TextRenderer.MeasureText(lblText, labelFont).Width + 4;
                        curX -= lblW;
                        message.VersionLabelBounds = new Rectangle(curX, y, lblW, btnHeight);

                        var prevW = 16;
                        curX -= prevW;
                        message.VersionPrevBounds = new Rectangle(curX, y, prevW, btnHeight);
                    }
                }
                else
                {
                    var curX = message.LabelBounds.Right + 8;

                    if (message.Versions != null && message.Versions.Count > 1)
                    {
                        var prevW = 16;
                        message.VersionPrevBounds = new Rectangle(curX, y, prevW, btnHeight);
                        curX += prevW;

                        var lblText = $"{message.VersionIndex + 1}/{message.Versions.Count}";
                        var lblW = TextRenderer.MeasureText(lblText, labelFont).Width + 4;
                        message.VersionLabelBounds = new Rectangle(curX, y, lblW, btnHeight);
                        curX += lblW;

                        var nextW = 16;
                        message.VersionNextBounds = new Rectangle(curX, y, nextW, btnHeight);
                        curX += nextW + 6;
                    }

                    var regenW = 68;
                    message.RegenerateBtnBounds = new Rectangle(curX, y, regenW, btnHeight);
                    curX += regenW + 4;

                    var branchW = 46;
                    message.BranchBtnBounds = new Rectangle(curX, y, branchW, btnHeight);
                }
            }

            y = continues ? message.Bounds.Bottom + RunGap : footerTop + footerHeight + MessageGap;
        }
        contentHeight = y;

        var needsScroll = contentHeight > ClientSize.Height;
        if (scrolling != needsScroll)
        {
            scrolling = scrollBar.Visible = needsScroll;
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
        // The message's text in reading order; each fragment records where it
        // starts in it, which is what text selection works in. Soft wraps add
        // nothing, so offsets survive re-wrapping at another width.
        var flat = new StringBuilder();
        var y = 0;
        var widest = 0;
        message.Cells.Clear();
        message.ImageBounds.Clear();
        message.CodeBlocks.Clear();
        message.ThoughtHeaderBounds = Rectangle.Empty;
        message.ThoughtLines.Clear();

        if (!string.IsNullOrWhiteSpace(message.Thought))
        {
            var thoughtLabel = message.ThoughtOpen ? "▾ 💭 Thought Process" : "▸ 💭 Thought Process";
            var labelW = Measure(thoughtLabel, labelFont) + 16;
            var labelH = labelFont.Height + 6;
            message.ThoughtHeaderBounds = new Rectangle(0, y, labelW, labelH);
            y += labelH + 4;
            widest = Math.Max(widest, labelW);

            if (message.ThoughtOpen)
            {
                var thoughtBlocks = ChatMarkdownParser.Parse(message.Thought);
                for (var b = 0; b < thoughtBlocks.Count; b++)
                {
                    var block = thoughtBlocks[b];
                    if (b > 0)
                    {
                        y += BlockGap;
                        flat.Append('\n');
                    }
                    if (block.Type == MarkdownBlockType.CodeBlock)
                    {
                        var sourceLines = string.Concat(block.Runs.Select(r => r.Text)).Replace("\r", "").Split('\n');
                        for (var li = 0; li < sourceLines.Length; li++)
                        {
                            if (li > 0)
                            {
                                flat.Append('\n');
                            }
                            foreach (var piece in BreakToWidth(sourceLines[li].Length == 0 ? " " : sourceLines[li], s => Measure(s, codeFont), maxWidth - 12 - QuoteIndent))
                            {
                                var w = Measure(piece, codeFont);
                                message.ThoughtLines.Add(new Line(y, codeFont.Height + 2, true, new List<Fragment> { new(piece, codeFont, QuoteIndent + 6, w, true, flat.Length) }, true));
                                flat.Append(piece);
                                widest = Math.Max(widest, QuoteIndent + w + 12);
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
                    var left = QuoteIndent;
                    var lineHeight = bodyFont.Height;
                    foreach (var fragments in Wrap(runs, null, left, maxWidth - left, indent))
                    {
                        message.ThoughtLines.Add(new Line(y, lineHeight, false, fragments, true));
                        widest = Math.Max(widest, fragments[^1].X + fragments[^1].Width);
                        y += lineHeight + 2;
                    }
                }
                if (message.Blocks.Count > 0)
                {
                    y += BlockGap;
                    flat.Append('\n');
                }
            }
        }

        if (message.Images.Count > 0)
        {
            var x = 0;
            var rowHeight = 0;
            foreach (var image in message.Images)
            {
                var size = ScreenCapture.FitWithin(image.Size, message.FromUser ? Math.Min(ThumbnailSide, maxWidth) : maxWidth);
                if (x > 0 && x + size.Width > maxWidth)
                {
                    y += rowHeight + BlockGap;
                    x = 0;
                    rowHeight = 0;
                }
                message.ImageBounds.Add(new Rectangle(new Point(x, y), size));
                widest = Math.Max(widest, x + size.Width);
                rowHeight = Math.Max(rowHeight, size.Height);
                x += size.Width + BlockGap;
            }
            y += rowHeight + (message.Blocks.Count > 0 ? BlockGap : 2);
        }
        for (var b = 0; b < message.Blocks.Count; b++)
        {
            var block = message.Blocks[b];
            if (b > 0)
            {
                y += BlockGap;
                flat.Append('\n');
            }
            if (block.Type == MarkdownBlockType.CodeBlock)
            {
                var sourceLines = string.Concat(block.Runs.Select(r => r.Text)).Replace("\r", "").Split('\n');
                var codeTop = y;
                // The mockups' code card: a bar with the language and Copy, then the lines.
                var language = CodeLanguage(block.Info);
                widest = Math.Max(widest, Measure(language, stampFont) + CopyWidth + 28);
                y += CodeBarHeight;
                for (var li = 0; li < sourceLines.Length; li++)
                {
                    if (li > 0)
                    {
                        flat.Append('\n');
                    }
                    foreach (var piece in BreakToWidth(sourceLines[li].Length == 0 ? " " : sourceLines[li], s => Measure(s, codeFont), maxWidth - 12))
                    {
                        var w = Measure(piece, codeFont);
                        lines.Add(new Line(y, codeFont.Height + 2, true, new List<Fragment> { new(piece, codeFont, 6, w, true, flat.Length) }));
                        flat.Append(piece);
                        widest = Math.Max(widest, w + 12);
                        y += codeFont.Height + 2;
                    }
                }
                y += 4;
                message.CodeBlocks.Add((codeTop - 1, y - 1, string.Join("\n", sourceLines), language));
                continue;
            }

            if (block.Type == MarkdownBlockType.Table && block.Rows is { Count: > 0 } rows)
            {
                LayOutTable(rows);
                continue;
            }

            var indent = 0;
            var runs = block.Runs.ToList();
            if (block.Type == MarkdownBlockType.BulletItem)
            {
                runs.Insert(0, new MarkdownRun("•  ", false, false, false));
                indent = Measure("•  ", bodyFont);
            }
            var isHeader = block.Type == MarkdownBlockType.Header;
            var isQuote = block.Type == MarkdownBlockType.Quote;
            var left = isQuote ? QuoteIndent : 0;
            var lineHeight = isHeader ? headerFont.Height : bodyFont.Height;
            foreach (var fragments in Wrap(runs, isHeader ? headerFont : null, left, maxWidth - left, indent))
            {
                lines.Add(new Line(y, lineHeight, false, fragments, isQuote));
                widest = Math.Max(widest, fragments[^1].X + fragments[^1].Width);
                y += lineHeight + 2;
            }
        }

        // Columns get their natural (unwrapped) width, scaled down together
        // when the table is wider than the bubble; cells then wrap inside.
        void LayOutTable(IReadOnlyList<IReadOnlyList<IReadOnlyList<MarkdownRun>>> rows)
        {
            static IEnumerable<MarkdownRun> CellRuns(IReadOnlyList<MarkdownRun> cell, bool header) =>
                header ? cell.Select(r => r with { Bold = true }) : cell;
            var columns = rows[0].Count;
            var widths = new int[columns];
            for (var r = 0; r < rows.Count; r++)
            {
                for (var c = 0; c < columns; c++)
                {
                    widths[c] = Math.Max(widths[c], CellRuns(rows[r][c], r == 0).Sum(run => Measure(run.Text, FontFor(run))) + CellPad * 2);
                }
            }
            var total = widths.Sum();
            if (total > maxWidth)
            {
                for (var c = 0; c < columns; c++)
                {
                    widths[c] = Math.Max(1, (int)((long)widths[c] * maxWidth / total));
                }
            }
            for (var r = 0; r < rows.Count; r++)
            {
                if (r > 0)
                {
                    flat.Append('\n');
                }
                var cellLines = new List<List<Fragment>>[columns];
                var x = 0;
                for (var c = 0; c < columns; c++)
                {
                    if (c > 0)
                    {
                        flat.Append('\t');
                    }
                    cellLines[c] = Wrap(CellRuns(rows[r][c], r == 0), null, x + CellPad, Math.Max(8, widths[c] - CellPad * 2), 0);
                    x += widths[c];
                }
                var lineCount = Math.Max(1, cellLines.Max(l => l.Count));
                var rowHeight = lineCount * (bodyFont.Height + 2) + CellPad;
                x = 0;
                for (var c = 0; c < columns; c++)
                {
                    message.Cells.Add((new Rectangle(x, y, widths[c], rowHeight), r == 0));
                    x += widths[c];
                }
                for (var k = 0; k < lineCount; k++)
                {
                    // One visual line across every cell, left to right.
                    var fragments = cellLines.Where(l => k < l.Count).SelectMany(l => l[k]).ToList();
                    if (fragments.Count > 0)
                    {
                        lines.Add(new Line(y + CellPad / 2 + k * (bodyFont.Height + 2), bodyFont.Height, false, fragments));
                    }
                }
                widest = Math.Max(widest, x);
                y += rowHeight;
            }
            y += 2;
        }

        // Word-wraps runs into lines of fragments `width` wide, starting at
        // x = left; continuation lines start `indent` further in.
        List<List<Fragment>> Wrap(IEnumerable<MarkdownRun> runs, Font? onlyFont, int left, int width, int indent)
        {
            var result = new List<List<Fragment>>();
            var line = new List<Fragment>();
            var x = 0;
            void EndLine()
            {
                result.Add(line);
                line = new List<Fragment>();
                x = indent;
            }
            foreach (var run in runs)
            {
                var font = onlyFont ?? FontFor(run);
                foreach (Match word in WordPattern.Matches(run.Text))
                {
                    var text = word.Value;
                    var w = Measure(text, font);
                    if (x + w > width && x > indent)
                    {
                        EndLine();
                        text = text.TrimStart();
                        if (text.Length == 0)
                        {
                            continue;
                        }
                        w = Measure(text, font);
                    }
                    if (w > width - indent)
                    {
                        foreach (var piece in BreakToWidth(text, s => Measure(s, font), width - indent))
                        {
                            if (x > indent)
                            {
                                EndLine();
                            }
                            var pw = Measure(piece, font);
                            line.Add(new Fragment(piece, font, left + x, pw, run.Code, flat.Length, run.Link));
                            flat.Append(piece);
                            x += pw;
                        }
                        continue;
                    }
                    line.Add(new Fragment(text, font, left + x, w, run.Code, flat.Length, run.Link));
                    flat.Append(text);
                    x += w;
                }
            }
            if (line.Count > 0)
            {
                EndLine();
            }
            return result;
        }
        message.ActionBounds.Clear();
        message.NoteBounds = Rectangle.Empty;
        if (message.Actions.Count > 0 || message.Note is not null)
        {
            y += 8;
            var x = 0;
            foreach (var action in message.Actions)
            {
                var w = Measure(action.Label, bodyFont) + 28 + (action.Menu is null ? 0 : MenuArrowWidth);
                message.ActionBounds.Add(new Rectangle(x, y, w, ActionHeight));
                x += w + 8;
            }
            if (message.Actions.Count > 0)
            {
                widest = Math.Max(widest, x - 8);
                y += ActionHeight + 2;
            }
            if (message.Note is not null)
            {
                var w = Math.Min(maxWidth, Measure(message.Note, bodyFont));
                message.NoteBounds = new Rectangle(0, y, w, bodyFont.Height);
                widest = Math.Max(widest, w);
                y += bodyFont.Height + 2;
            }
        }
        message.Lines = lines;
        message.Text = flat.ToString();
        message.ContentWidth = Math.Min(maxWidth, Math.Max(widest, 1));
        message.ContentHeight = Math.Max(y - 2, bodyFont.Height);
        message.LaidOutWidth = maxWidth;
    }

    private Font FontFor(MarkdownRun run)
    {
        if (run.Code)
        {
            return codeFont;
        }
        var style = (run.Bold ? FontStyle.Bold : 0) | (run.Italic ? FontStyle.Italic : 0)
                    | (run.Strike ? FontStyle.Strikeout : 0) | (run.Link is not null ? FontStyle.Underline : 0);
        if (style == FontStyle.Regular)
        {
            return bodyFont;
        }
        if (!styledFonts.TryGetValue(style, out var font))
        {
            styledFonts[style] = font = new Font(bodyFont, style);
        }
        return font;
    }

    private static int Measure(string text, Font font) =>
        TextRenderer.MeasureText(text, font, new Size(int.MaxValue, int.MaxValue), TextFlags).Width;

    // Splits text too long for one line into the longest pieces that fit.
    // #1147: only between text elements (grapheme clusters), so an emoji ZWJ
    // sequence, a flag, a surrogate pair or a letter with its combining
    // accent is never cut in half; one element wider than the line gets a
    // line to itself.
    internal static IEnumerable<string> BreakToWidth(string text, Func<string, int> measure, int maxWidth)
    {
        var starts = StringInfo.ParseCombiningCharacters(text);
        var first = 0; // index into starts
        string Piece(int count) =>
            text[starts[first]..(first + count < starts.Length ? starts[first + count] : text.Length)];
        while (first < starts.Length)
        {
            var count = starts.Length - first;
            while (count > 1 && measure(Piece(count)) > maxWidth)
            {
                count = Math.Max(1, Math.Min(count - 1, count * 3 / 4)); // shrink fast, then grow back below
            }
            while (first + count < starts.Length && measure(Piece(count + 1)) <= maxWidth)
            {
                count++;
            }
            yield return Piece(count);
            first += count;
        }
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        Relayout(forceScroll: false); // bubble widths and the scroll range both follow the size
    }

    // ---- Painting -------------------------------------------------------

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        if (DarkTheme.IsGlass && FindForm() is { } form)
        {
            (Size Size, Point Offset, Size Window, int Theme, (Point, bool, int) Backdrop) key = (ClientSize, form.PointToClient(PointToScreen(Point.Empty)), form.ClientSize, DarkTheme.Version, GlassSurface.BackdropKey(form));
            if (glow is null || key != glowKey)
            {
                glow?.Dispose();
                glow = GlassSurface.RenderGlow(key.Size, key.Offset, key.Window, form: form);
                glowKey = key;
            }
            e.Graphics.DrawImageUnscaled(glow, 0, 0);
            return;
        }
        using var brush = new SolidBrush(DarkTheme.Background);
        e.Graphics.FillRectangle(brush, ClientRectangle);
    }

    // #1449: the chat's rounded corners, like Settings': bubbles and cards
    // 10px, buttons 6px, a pill never more than half its height.
    private const float BubbleRadius = 10;
    private const float ButtonRadius = 6;

    // An empty path for a rectangle too small to round (a button not laid out yet).
    private static GraphicsPath Round(Rectangle r, float radius) =>
        r.Width < 3 || r.Height < 3 ? new GraphicsPath()
        : SettingsRows.Rounded(new RectangleF(r.X + 0.5f, r.Y + 0.5f, r.Width - 1f, r.Height - 1f), Math.Max(0.5f, Math.Min(radius, (r.Height - 1) / 2f)));

    // The mockups' bubbles: 14px corners, but the one nearest the speaker small -- bottom left on hers (and top left too
    // when it follows one of hers), bottom right on yours. Request cards keep even corners.
    private const float SpeechRadius = 14;
    private const float TailRadius = 4;

    private static GraphicsPath BubbleShape(Rectangle r, Message message, bool followsHers)
    {
        if (message.ApprovalId is not null)
        {
            return Round(r, BubbleRadius);
        }
        var big = Math.Min(SpeechRadius, (r.Height - 1) / 2f);
        var (tl, tr, br, bl) = message.FromUser ? (big, big, TailRadius, big) : (followsHers ? TailRadius : big, big, big, TailRadius);
        var rect = new RectangleF(r.X + 0.5f, r.Y + 0.5f, r.Width - 1f, r.Height - 1f);
        var path = new GraphicsPath();
        path.AddArc(rect.X, rect.Y, tl * 2, tl * 2, 180, 90);
        path.AddArc(rect.Right - tr * 2, rect.Y, tr * 2, tr * 2, 270, 90);
        path.AddArc(rect.Right - br * 2, rect.Bottom - br * 2, br * 2, br * 2, 0, 90);
        path.AddArc(rect.X, rect.Bottom - bl * 2, bl * 2, bl * 2, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static void FillRound(Graphics g, Brush brush, Rectangle r, float radius)
    {
        using var shape = Round(r, radius);
        g.FillPath(brush, shape);
    }

    private static void DrawRound(Graphics g, Pen pen, Rectangle r, float radius)
    {
        using var shape = Round(r, radius);
        g.DrawPath(pen, shape);
    }

    // A new chat's card: how to start, and a few things she can do.
    // ---- Welcome (mockup B) ---------------------------------------------
    // An empty chat opens on her: her live model in the middle (the window moves it here from her card, through
    // WelcomeAvatarSlot), a greeting for the time of day, a hint, and up to three things to start with.

    // The mockups' line under the greeting, by the hour like it.
    internal static string WelcomeAsk(int hour) => hour switch
    {
        >= 5 and < 12 => "What are we starting with?",
        >= 12 and < 17 => "What are we working on?",
        _ => "What are we doing tonight?",
    };

    private readonly Panel welcomeAvatar = new() { BackColor = Color.Transparent, Visible = false };
    private IReadOnlyList<(string Label, Action Run)> welcomeSuggestions = Array.Empty<(string, Action)>();
    private readonly List<Rectangle> suggestionBounds = new();
    private int hotSuggestion = -1;
    private bool? wasEmpty;
    private Rectangle greetingBounds;
    private Rectangle hintBounds;

    // True when the chat turns empty (a new chat), false when its first message arrives.
    public event Action<bool>? EmptyChanged;

    public bool IsEmpty => messages.Count == 0;

    public Control WelcomeAvatarSlot => welcomeAvatar;

    internal IReadOnlyList<Rectangle> SuggestionBounds => suggestionBounds;

    // What the welcome offers, first to last (three at most).
    public void SetWelcomeSuggestions(IReadOnlyList<(string Label, Action Run)> suggestions)
    {
        welcomeSuggestions = suggestions.Take(3).ToList();
        LayOutWelcome();
        Invalidate();
    }

    // Her greeting by the hour: morning from 5, afternoon from 12, evening from 17, and a night-owl one after 22.
    // What she calls you (Settings > General > Your name), for the welcome; null or blank: no name.
    public static string? UserName { get; set; }

    internal static string Greeting(int hour, string? name = null)
    {
        name = string.IsNullOrWhiteSpace(name) ? null : name.Trim();
        return hour switch
        {
            >= 5 and < 12 => name is null ? "Good morning~" : $"Good morning, {name}~",
            >= 12 and < 17 => name is null ? "Good afternoon~" : $"Good afternoon, {name}~",
            >= 17 and < 22 => name is null ? "Good evening~" : $"Good evening, {name}~",
            _ => name is null ? "Hi, night owl~" : $"Hi, {name}~ Up late?",
        };
    }

    private void NotifyEmpty()
    {
        var empty = messages.Count == 0;
        welcomeAvatar.Visible = empty && welcomeAvatar.Height > 0;
        if (empty != wasEmpty)
        {
            wasEmpty = empty;
            EmptyChanged?.Invoke(empty);
            LayOutWelcome();
        }
    }

    // Her in the middle, the greeting and hint under her, the cards under those; centred as a block. On a short
    // window she gets smaller, and goes back to her card if there's no room.
    private void LayOutWelcome()
    {
        suggestionBounds.Clear();
        var width = ClientSize.Width;
        var height = ClientSize.Height;
        var greetingHeight = greetingFont.Height;
        var hintHeight = bodyFont.Height;
        var cardHeight = LogicalToDeviceUnits(76); // icon, then two lines
        var gap = LogicalToDeviceUnits(10);
        var count = welcomeSuggestions.Count;
        var textBlock = greetingHeight + gap / 2 + hintHeight + (count > 0 ? gap * 2 + cardHeight : 0);
        var avatarHeight = Math.Min(LogicalToDeviceUnits(230), height - textBlock - gap * 4);
        if (avatarHeight < LogicalToDeviceUnits(110))
        {
            avatarHeight = 0;
        }
        var avatarWidth = avatarHeight * 200 / 230;
        var top = Math.Max(gap, (height - (avatarHeight + (avatarHeight > 0 ? gap : 0) + textBlock)) / 2);
        welcomeAvatar.Bounds = new Rectangle((width - avatarWidth) / 2, top, avatarWidth, avatarHeight);
        welcomeAvatar.Visible = messages.Count == 0 && avatarHeight > 0;
        var y = top + avatarHeight + (avatarHeight > 0 ? gap : 0);
        greetingBounds = new Rectangle(0, y, width, greetingHeight);
        y += greetingHeight + gap / 2;
        hintBounds = new Rectangle(0, y, width, hintHeight);
        y += hintHeight + gap * 2;
        if (count > 0)
        {
            var cardWidth = Math.Min(LogicalToDeviceUnits(170), (width - SideMargin * 2 - gap * (count - 1)) / count);
            var x = (width - (cardWidth * count + gap * (count - 1))) / 2;
            for (var i = 0; i < count; i++)
            {
                suggestionBounds.Add(new Rectangle(x + i * (cardWidth + gap), y, cardWidth, cardHeight));
            }
        }
    }

    private void PaintWelcome(Graphics g)
    {
        const TextFormatFlags centred = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis;
        TextRenderer.DrawText(g, Greeting(DateTime.Now.Hour, UserName), greetingFont, greetingBounds, DarkTheme.Text, centred);
        TextRenderer.DrawText(g, WelcomeAsk(DateTime.Now.Hour), bodyFont, hintBounds, DarkTheme.Muted, centred);
        for (var i = 0; i < suggestionBounds.Count && i < welcomeSuggestions.Count; i++)
        {
            var card = suggestionBounds[i];
            using (var fill = new SolidBrush(DarkTheme.IsGlass ? GlassSurface.Veil(i == hotSuggestion ? 215 : 165) : i == hotSuggestion ? DarkTheme.Border : DarkTheme.Panel2))
            {
                FillRound(g, fill, card, BubbleRadius);
            }
            using (var border = new Pen(i == hotSuggestion ? DarkTheme.Accent : DarkTheme.IsGlass ? GlassSurface.Outline : DarkTheme.Border))
            {
                DrawRound(g, border, card, BubbleRadius);
            }
            // The mockups' cards: an accent icon at the top left, the words under it.
            var label = welcomeSuggestions[i].Label;
            var icon = new RectangleF(card.X + 12, card.Y + 11, 15, 15);
            var smoothing = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var pen = new Pen(DarkTheme.Accent, 1.3f) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round })
            {
                var state = g.Save();
                g.TranslateTransform(icon.X, icon.Y);
                g.ScaleTransform(icon.Width / 16f, icon.Height / 16f);
                pen.Width = 1.3f * 16f / icon.Width;
                if (label.StartsWith("What did I miss", StringComparison.Ordinal))
                {
                    // An inbox tray.
                    g.DrawLines(pen, new PointF[] { new(2, 9), new(4, 3), new(12, 3), new(14, 9), new(14, 13), new(2, 13), new(2, 9) });
                    g.DrawLines(pen, new PointF[] { new(2, 9), new(5.5f, 9), new(6.5f, 10.5f), new(9.5f, 10.5f), new(10.5f, 9), new(14, 9) });
                }
                else
                {
                    // A spark.
                    g.DrawPolygon(pen, new PointF[] { new(8, 1.5f), new(9.4f, 5.6f), new(13.5f, 7), new(9.4f, 8.4f), new(8, 12.5f), new(6.6f, 8.4f), new(2.5f, 7), new(6.6f, 5.6f) });
                }
                g.Restore(state);
            }
            g.SmoothingMode = smoothing;
            var words = new Rectangle(card.X + 12, (int)icon.Bottom + 6, card.Width - 24, card.Bottom - (int)icon.Bottom - 12);
            TextRenderer.DrawText(g, label, bodyFont, words, DarkTheme.Text,
                TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix | TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.EndEllipsis);
        }
    }

    private int SuggestionAt(Point point) => messages.Count == 0 ? suggestionBounds.FindIndex(r => r.Contains(point)) : -1;

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias; // #1449: the rounded corners
        if (messages.Count == 0)
        {
            PaintWelcome(g);
        }
        var scroll = scrolling ? scrollBar.Value : 0;
        for (var i = 0; i < messages.Count; i++)
        {
            var message = messages[i];
            var bubble = message.Bounds with { Y = message.Bounds.Y - scroll };
            if (bubble.Bottom < 0 || bubble.Y - labelFont.Height > ClientSize.Height)
            {
                continue;
            }
            if (message.Steps is not null)
            {
                // The mockups' tool-steps chip: a dashed pill around the line (rounder than a card once it's open).
                var chip = Rectangle.Inflate(bubble, -4, -5);
                using (var dashed = new Pen(DarkTheme.IsGlass ? Color.FromArgb(70, DarkTheme.Accent) : DarkTheme.Border) { DashPattern = new[] { 3f, 2.5f } })
                {
                    var smoothing = g.SmoothingMode;
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    DrawRound(g, dashed, chip, message.StepsOpen ? BubbleRadius : chip.Height / 2f);
                    g.SmoothingMode = smoothing;
                }
                PaintStepLine(g, message, new Point(bubble.X + PadX, bubble.Y + PadY));
                continue;
            }
            var label = message.LabelBounds with { Y = message.LabelBounds.Y - scroll };
            var hovered = hoveredIndex == i || selected == i;
            if (message.FromUser ? message.At is { } at : hovered && label.Height > 0)
            {
                TextRenderer.DrawText(g, message.FromUser ? Stamp(message.At!.Value, DateTime.Now) : message.Speaker, stampFont, label, DarkTheme.Muted,
                    TextFlags | TextFormatFlags.EndEllipsis | (message.FromUser ? TextFormatFlags.Right : TextFormatFlags.Left));
            }

            // #1322: Draw version stepper controls if multiple versions exist
            if (message.Versions != null && message.Versions.Count > 1)
            {
                var prevR = message.VersionPrevBounds with { Y = message.VersionPrevBounds.Y - scroll };
                var nextR = message.VersionNextBounds with { Y = message.VersionNextBounds.Y - scroll };
                var lblR = message.VersionLabelBounds with { Y = message.VersionLabelBounds.Y - scroll };

                var prevEnabled = message.VersionIndex > 0;
                var nextEnabled = message.VersionIndex < message.Versions.Count - 1;

                using var btnBrush = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 25 : 35, DarkTheme.Muted));
                FillRound(g, btnBrush, prevR, ButtonRadius);
                FillRound(g, btnBrush, nextR, ButtonRadius);

                TextRenderer.DrawText(g, "<", labelFont, prevR, prevEnabled ? DarkTheme.Text : DarkTheme.Muted, TextFlags | TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                TextRenderer.DrawText(g, $"{message.VersionIndex + 1}/{message.Versions.Count}", labelFont, lblR, DarkTheme.Muted, TextFlags | TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                TextRenderer.DrawText(g, ">", labelFont, nextR, nextEnabled ? DarkTheme.Text : DarkTheme.Muted, TextFlags | TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }

            // #1322: Draw action buttons if hovered or selected
            var showActions = (hoveredIndex == i || selected == i) && message.TurnIndex >= 0 && message.Steps is null;
            if (showActions)
            {
                using var btnBrush = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 35 : 45, DarkTheme.Muted));
                using var borderPen = new Pen(Color.FromArgb(70, DarkTheme.Border));

                if (message.FromUser && !message.EditBtnBounds.IsEmpty)
                {
                    var editR = message.EditBtnBounds with { Y = message.EditBtnBounds.Y - scroll };
                    FillRound(g, btnBrush, editR, ButtonRadius);
                    DrawRound(g, borderPen, editR, ButtonRadius);
                    TextRenderer.DrawText(g, "Edit", labelFont, editR, DarkTheme.Text, TextFlags | TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                }
                else if (!message.FromUser && !message.RegenerateBtnBounds.IsEmpty)
                {
                    var regenR = message.RegenerateBtnBounds with { Y = message.RegenerateBtnBounds.Y - scroll };
                    FillRound(g, btnBrush, regenR, ButtonRadius);
                    DrawRound(g, borderPen, regenR, ButtonRadius);
                    TextRenderer.DrawText(g, "Regenerate", labelFont, regenR, DarkTheme.Text, TextFlags | TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                }

                if (!message.BranchBtnBounds.IsEmpty)
                {
                    var branchR = message.BranchBtnBounds with { Y = message.BranchBtnBounds.Y - scroll };
                    FillRound(g, btnBrush, branchR, ButtonRadius);
                    DrawRound(g, borderPen, branchR, ButtonRadius);
                    TextRenderer.DrawText(g, "Branch", labelFont, branchR, DarkTheme.Text, TextFlags | TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                }
            }

            var fill = message.FromUser ? DarkTheme.UserBubble : DarkTheme.ManaBubble;
            using (var shape = BubbleShape(bubble, message, i > 0 && GroupsWith(messages[i - 1], message)))
            {
                var smoothing = g.SmoothingMode;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using var solid = new SolidBrush(DarkTheme.IsGlass ? Color.FromArgb(235, fill) : fill);
                g.FillPath(solid, shape);
                if (!DarkTheme.IsGlass)
                {
                    using var border = new Pen(DarkTheme.Border);
                    g.DrawPath(border, shape);
                }
                g.SmoothingMode = smoothing;
            }
            if (message.ApprovalId is not null)
            {
                // #1426: a request card -- edged in the accent, a bar down its
                // left while it waits, the plain edge once it's answered.
                var waiting = message.Actions.Count > 0;
                using var edge = new Pen(waiting ? DarkTheme.Accent : DarkTheme.Border);
                DrawRound(g, edge, bubble, BubbleRadius);
                if (waiting)
                {
                    // The bar follows the card's rounded left edge.
                    using var shape = Round(bubble, BubbleRadius);
                    var clip = g.Clip;
                    g.SetClip(shape, CombineMode.Intersect);
                    using var bar = new SolidBrush(DarkTheme.Accent);
                    g.FillRectangle(bar, bubble.X, bubble.Y, 4, bubble.Height);
                    g.Clip = clip;
                }
            }

            var origin = new Point(bubble.X + PadX, bubble.Y + PadY);
            if (!string.IsNullOrWhiteSpace(message.Thought))
            {
                var headerRect = message.ThoughtHeaderBounds with { X = message.ThoughtHeaderBounds.X + origin.X, Y = message.ThoughtHeaderBounds.Y + origin.Y };
                using var pillBrush = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 30 : 40, DarkTheme.Muted));
                using var pillPen = new Pen(Color.FromArgb(DarkTheme.IsLight ? 60 : 70, DarkTheme.Border));
                FillRound(g, pillBrush, headerRect, headerRect.Height / 2f);
                DrawRound(g, pillPen, headerRect, headerRect.Height / 2f);
                var labelText = message.ThoughtOpen ? "▾ 💭 Thought Process" : "▸ 💭 Thought Process";
                TextRenderer.DrawText(g, labelText, labelFont, new Point(headerRect.X + 8, headerRect.Y + 3), DarkTheme.Muted, TextFlags);

                if (message.ThoughtOpen)
                {
                    foreach (var line in message.ThoughtLines)
                    {
                        if (line.Code)
                        {
                            using var codeBack = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 110 : 60, DarkTheme.IsLight ? Color.White : Color.Black));
                            g.FillRectangle(codeBack, origin.X + QuoteIndent, origin.Y + line.Y - 1, message.ContentWidth - QuoteIndent, line.Height);
                        }
                        if (line.Quote)
                        {
                            using var bar = new SolidBrush(Color.FromArgb(120, DarkTheme.Muted));
                            g.FillRectangle(bar, origin.X, origin.Y + line.Y - 1, 2, line.Height + 2);
                        }
                        foreach (var fragment in line.Fragments)
                        {
                            PaintSelection(g, i, fragment, origin.X, origin.Y + line.Y - 1, line.Height);
                            var y = origin.Y + line.Y + (line.Height - fragment.Font.Height) / 2;
                            TextRenderer.DrawText(g, fragment.Text, fragment.Font, new Point(origin.X + fragment.X, y),
                                fragment.IsCode ? DarkTheme.CodeText : DarkTheme.Muted, TextFlags);
                        }
                    }
                }
            }

            for (var k = 0; k < message.Images.Count; k++)
            {
                var rect = message.ImageBounds[k];
                g.DrawImage(message.Images[k], rect with { X = rect.X + origin.X, Y = rect.Y + origin.Y });
            }
            if (message.Cells.Count > 0)
            {
                using var headerBack = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 110 : 60, DarkTheme.IsLight ? Color.White : Color.Black));
                using var grid = new Pen(DarkTheme.Border);
                foreach (var (cell, header) in message.Cells)
                {
                    var rect = cell with { X = cell.X + origin.X, Y = cell.Y + origin.Y };
                    if (header)
                    {
                        g.FillRectangle(headerBack, rect);
                    }
                    g.DrawRectangle(grid, rect);
                }
            }
            for (var k = 0; k < message.CodeBlocks.Count; k++)
            {
                PaintCodeCard(g, message, k, origin, copied: copiedBlock == (i, k));
            }
            foreach (var line in message.Lines)
            {
                if (line.Quote)
                {
                    using var bar = new SolidBrush(Color.FromArgb(160, DarkTheme.Accent));
                    g.FillRectangle(bar, origin.X, origin.Y + line.Y - 1, 3, line.Height + 2);
                }
                foreach (var fragment in line.Fragments)
                {
                    PaintSelection(g, i, fragment, origin.X, origin.Y + line.Y - 1, line.Height);
                    // Centred on the line, so a smaller code-font span sits level with the words around it.
                    var y = origin.Y + line.Y + (line.Height - fragment.Font.Height) / 2;
                    TextRenderer.DrawText(g, fragment.Text, fragment.Font, new Point(origin.X + fragment.X, y),
                        fragment.IsCode ? DarkTheme.CodeText : fragment.Link is not null ? DarkTheme.Accent : DarkTheme.Text, TextFlags);
                }
            }

            PaintActions(g, message, origin);

            if (i == selected)
            {
                using var ring = new Pen(DarkTheme.Accent, 2);
                DrawRound(g, ring, Rectangle.Inflate(bubble, -1, -1), BubbleRadius - 1);
            }
        }
    }

    // The mockups' code card: rounded, edged, a tinted bar over the lines with the language on the left and a Copy
    // (a copy icon and the word) on the right.
    private void PaintCodeCard(Graphics g, Message message, int block, Point origin, bool copied)
    {
        var (top, bottom, _, language) = message.CodeBlocks[block];
        var card = new Rectangle(origin.X, origin.Y + top, message.ContentWidth, bottom - top);
        var light = DarkTheme.IsLight;
        var smoothing = g.SmoothingMode;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var shape = Round(card, 8))
        {
            using var back = new SolidBrush(light ? Color.FromArgb(180, 255, 255, 255) : Color.FromArgb(120, 12, 12, 24));
            g.FillPath(back, shape);
            var clip = g.Clip;
            g.SetClip(shape, CombineMode.Intersect);
            using var bar = new SolidBrush(Color.FromArgb(light ? 34 : 30, DarkTheme.Accent));
            g.FillRectangle(bar, card.X, card.Y, card.Width, CodeBarHeight);
            g.Clip = clip;
            using var edge = new Pen(Color.FromArgb(light ? 40 : 46, DarkTheme.Accent));
            g.DrawPath(edge, shape);
        }
        var barRect = new Rectangle(card.X + 10, card.Y, card.Width - 20, CodeBarHeight);
        TextRenderer.DrawText(g, language, stampFont, barRect, DarkTheme.Muted, TextFlags | TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
        var copy = CopyButton(message, block);
        copy.Offset(origin);
        var ink = copied ? DarkTheme.Accent : DarkTheme.Text;
        var icon = new RectangleF(copy.X + 6, copy.Y + (copy.Height - 12) / 2f, 12, 12);
        using (var pen = new Pen(ink, 1.1f))
        {
            // Two sheets, the front one whole.
            g.DrawRectangle(pen, icon.X + 3.5f, icon.Y + 3.5f, 7.5f, 8);
            g.DrawLines(pen, new[] { new PointF(icon.X + 1, icon.Y + 9), new PointF(icon.X + 1, icon.Y + 1), new PointF(icon.X + 8, icon.Y + 1) });
        }
        g.SmoothingMode = smoothing;
        TextRenderer.DrawText(g, copied ? "Copied" : "Copy", stampFont, new Rectangle((int)icon.Right + 4, copy.Y, copy.Right - (int)icon.Right - 4, copy.Height), ink,
            TextFlags | TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
    }

    // #1318: a step-group line: grey text straight on the chat background,
    // its command/result blocks on the usual code shading.
    private void PaintStepLine(Graphics g, Message message, Point origin)
    {
        foreach (var line in message.Lines)
        {
            if (line.Code)
            {
                using var codeBack = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 110 : 60, DarkTheme.IsLight ? Color.White : Color.Black));
                g.FillRectangle(codeBack, origin.X, origin.Y + line.Y - 1, message.ContentWidth, line.Height);
            }
            foreach (var fragment in line.Fragments)
            {
                var y = origin.Y + line.Y + (line.Height - fragment.Font.Height) / 2;
                TextRenderer.DrawText(g, fragment.Text, fragment.Font, new Point(origin.X + fragment.X, y),
                    fragment.IsCode ? DarkTheme.Text : StepColor(fragment.Text), TextFlags);
            }
        }
    }

    // A code block's Copy button, in content coordinates: its top right corner.
    private Rectangle CopyButton(Message message, int block) =>
        new(message.ContentWidth - CopyWidth - 4, message.CodeBlocks[block].Top + 3, CopyWidth, CodeBarHeight - 5);

    private int CodeBarHeight => stampFont.Height + 9;
    private int CopyWidth => TextRenderer.MeasureText("Copied", stampFont).Width + 26;

    // The bar's name for a fence language.
    internal static string CodeLanguage(string? info) => info?.ToLowerInvariant() switch
    {
        null or "" => "Code",
        "cs" or "csharp" or "c#" => "C#",
        "js" or "javascript" or "mjs" => "JavaScript",
        "ts" or "typescript" => "TypeScript",
        "py" or "python" => "Python",
        "sh" or "bash" or "shell" or "zsh" => "Shell",
        "ps" or "ps1" or "powershell" or "pwsh" => "PowerShell",
        "json" => "JSON",
        "html" => "HTML",
        "css" => "CSS",
        "md" or "markdown" => "Markdown",
        "diff" => "Diff",
        _ => info!,
    };

    // The Copy button under `point` (control coordinates), on the hovered message only, where they show.
    private (int Message, int Block)? CopyButtonAt(Point point)
    {
        if (hoveredIndex < 0 || hoveredIndex >= messages.Count)
        {
            return null;
        }
        var message = messages[hoveredIndex];
        var content = new Point(point.X - message.Bounds.X - PadX, point.Y + (scrolling ? scrollBar.Value : 0) - message.Bounds.Y - PadY);
        for (var k = 0; k < message.CodeBlocks.Count; k++)
        {
            if (CopyButton(message, k).Contains(content))
            {
                return (hoveredIndex, k);
            }
        }
        return null;
    }

    // ---- Input ----------------------------------------------------------

    internal void SimulateClick(Point point) =>
        OnMouseDown(new MouseEventArgs(MouseButtons.Left, 1, point.X, point.Y, 0));

    internal void SimulateKeyDown(KeyEventArgs e) => OnKeyDown(e);

    internal void SimulateMouseMove(Point point) =>
        OnMouseMove(new MouseEventArgs(MouseButtons.None, 0, point.X, point.Y, 0));

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        Focus();
        if (e.Button == MouseButtons.Left && SuggestionAt(e.Location) is var suggestion and >= 0 && suggestion < welcomeSuggestions.Count)
        {
            welcomeSuggestions[suggestion].Run();
            return;
        }
        if (e.Button == MouseButtons.Left && ActionAt(e.Location) is var (actionMsg, actionIndex, actionRect))
        {
            if (messages[actionMsg].Actions[actionIndex].Menu is not null && e.X >= actionRect.Right - MenuArrowWidth)
            {
                ShowActionMenu(actionMsg, actionIndex, new Point(actionRect.Right - MenuArrowWidth, actionRect.Bottom));
            }
            else
            {
                _ = RunActionAsync(actionMsg, actionIndex);
            }
            return;
        }
        if (e.Button == MouseButtons.Left && CopyButtonAt(e.Location) is var (copyMsg, copyBlock))
        {
            try
            {
                CopyText(messages[copyMsg].CodeBlocks[copyBlock].Code);
                copiedBlock = (copyMsg, copyBlock);
                copiedReset.Stop();
                copiedReset.Start();
                Invalidate();
            }
            catch (System.Runtime.InteropServices.ExternalException ex)
            {
                Console.WriteLine($"ChatView: copy failed. {ex.Message}"); // the clipboard is busy in another app
            }
            return;
        }
        // #1322: clicking edit, regenerate, branch, or version buttons
        if (e.Button == MouseButtons.Left)
        {
            var scroll = scrolling ? scrollBar.Value : 0;
            var p = new Point(e.X, e.Y + scroll);
            for (var i = 0; i < messages.Count; i++)
            {
                var m = messages[i];
                if (m.TurnIndex >= 0 && m.Steps is null)
                {
                    if (!m.EditBtnBounds.IsEmpty && m.EditBtnBounds.Contains(p))
                    {
                        OnEditMessage?.Invoke(m.TurnIndex, m.PlainText);
                        return;
                    }
                    if (!m.RegenerateBtnBounds.IsEmpty && m.RegenerateBtnBounds.Contains(p))
                    {
                        OnRegenerateReply?.Invoke(m.TurnIndex);
                        return;
                    }
                    if (!m.BranchBtnBounds.IsEmpty && m.BranchBtnBounds.Contains(p))
                    {
                        OnBranchFromMessage?.Invoke(m.TurnIndex);
                        return;
                    }
                    if (!m.VersionPrevBounds.IsEmpty && m.VersionPrevBounds.Contains(p))
                    {
                        if (m.Versions != null && m.VersionIndex > 0)
                        {
                            OnSwitchTurnVersion?.Invoke(m.TurnIndex, m.VersionIndex - 1);
                        }
                        return;
                    }
                    if (!m.VersionNextBounds.IsEmpty && m.VersionNextBounds.Contains(p))
                    {
                        if (m.Versions != null && m.VersionIndex < m.Versions.Count - 1)
                        {
                            OnSwitchTurnVersion?.Invoke(m.TurnIndex, m.VersionIndex + 1);
                        }
                        return;
                    }
                }
            }
        }
        // #1354: clicking thought header toggles ThoughtOpen
        if (e.Button == MouseButtons.Left && HitTest(e.Location) is var thHit and >= 0 && !string.IsNullOrWhiteSpace(messages[thHit].Thought))
        {
            var thMsg = messages[thHit];
            var hx = e.X - thMsg.Bounds.X - PadX;
            var hy = e.Y + (scrolling ? scrollBar.Value : 0) - thMsg.Bounds.Y - PadY;
            if (thMsg.ThoughtHeaderBounds.Contains(hx, hy))
            {
                thMsg.ThoughtOpen = !thMsg.ThoughtOpen;
                thMsg.Invalidate();
                Relayout(forceScroll: false);
                return;
            }
        }
        // #1318: clicking a step line opens or closes its steps.
        if (e.Button == MouseButtons.Left && HitTest(e.Location) is var taskHit and >= 0 && messages[taskHit].Steps is { TaskId: { } taskId } task)
        {
            OpenTask?.Invoke(taskId, task.Steps[0].Title ?? task.Line, () => !endedTasks.Contains(taskId));
            return;
        }
        if (e.Button == MouseButtons.Left && HitTest(e.Location) is var stepHit and >= 0 && messages[stepHit].Steps is not null)
        {
            messages[stepHit].StepsOpen = !messages[stepHit].StepsOpen;
            SetStepBlocks(messages[stepHit], DateTimeOffset.UtcNow);
            Relayout(forceScroll: false);
            return;
        }
        if (e.Button == MouseButtons.Left)
        {
            pressPoint = e.Location;
            pressed = true;
            dragSelecting = false;
            ClearTextSelection();
        }
        // A right-click keeps a text selection so its menu can copy it.
        var keepText = e.Button == MouseButtons.Right && HasTextSelection;
        var hit = HitTest(e.Location);
        if (!keepText && hit != selected && (hit >= 0 || e.Button == MouseButtons.Left))
        {
            Select(hit);
        }
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        if (hoveredIndex != -1)
        {
            hoveredIndex = -1;
            Invalidate();
        }
    }

    // A press that moves a few pixels becomes a text drag-selection, which
    // can run within one bubble or across several.
    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (messages.Count == 0)
        {
            var hot = SuggestionAt(e.Location);
            if (hot != hotSuggestion)
            {
                hotSuggestion = hot;
                Invalidate();
            }
            Cursor = hot >= 0 ? Cursors.Hand : Cursors.Default;
            return;
        }
        var link = LinkAt(e.Location);
        var label = messages.FirstOrDefault(message => !message.FromUser && message.LabelBounds.Contains(e.X, e.Y + (scrolling ? scrollBar.Value : 0)))?.Speaker;
        var tip = link ?? label;
        if (link != hoveredLink)
        {
            hoveredLink = link;
        }
        if (linkTip.GetToolTip(this) != tip) linkTip.SetToolTip(this, tip);
        var isThoughtHeader = false;
        if (HitTest(e.Location) is var thMoveHit and >= 0 && !string.IsNullOrWhiteSpace(messages[thMoveHit].Thought))
        {
            var thMsg = messages[thMoveHit];
            var hx = e.X - thMsg.Bounds.X - PadX;
            var hy = e.Y + (scrolling ? scrollBar.Value : 0) - thMsg.Bounds.Y - PadY;
            if (thMsg.ThoughtHeaderBounds.Contains(hx, hy))
            {
                isThoughtHeader = true;
            }
        }
        var scroll = scrolling ? scrollBar.Value : 0;
        var p = new Point(e.X, e.Y + scroll);
        var newHovered = -1;
        var isActionButton = false;
        for (var i = 0; i < messages.Count; i++)
        {
            var m = messages[i];
            if (m.Bounds.Contains(p) || m.LabelBounds.Contains(p) ||
                (!m.EditBtnBounds.IsEmpty && m.EditBtnBounds.Contains(p)) ||
                (!m.RegenerateBtnBounds.IsEmpty && m.RegenerateBtnBounds.Contains(p)) ||
                (!m.BranchBtnBounds.IsEmpty && m.BranchBtnBounds.Contains(p)) ||
                (!m.VersionPrevBounds.IsEmpty && m.VersionPrevBounds.Contains(p)) ||
                (!m.VersionNextBounds.IsEmpty && m.VersionNextBounds.Contains(p)))
            {
                newHovered = i;
                if ((!m.EditBtnBounds.IsEmpty && m.EditBtnBounds.Contains(p)) ||
                    (!m.RegenerateBtnBounds.IsEmpty && m.RegenerateBtnBounds.Contains(p)) ||
                    (!m.BranchBtnBounds.IsEmpty && m.BranchBtnBounds.Contains(p)) ||
                    (!m.VersionPrevBounds.IsEmpty && m.VersionPrevBounds.Contains(p)) ||
                    (!m.VersionNextBounds.IsEmpty && m.VersionNextBounds.Contains(p)))
                {
                    isActionButton = true;
                }
                break;
            }
        }
        if (newHovered != hoveredIndex)
        {
            hoveredIndex = newHovered;
            Invalidate();
        }
        Cursor = isActionButton || isThoughtHeader || ActionAt(e.Location) is not null || link is not null || CopyButtonAt(e.Location) is not null ? Cursors.Hand
            : HitTest(e.Location) >= 0 ? Cursors.IBeam : Cursors.Default;
        if (!pressed || (e.Button & MouseButtons.Left) == 0 || messages.Count == 0)
        {
            return;
        }
        if (!dragSelecting)
        {
            if (Math.Abs(e.X - pressPoint.X) + Math.Abs(e.Y - pressPoint.Y) < 4)
            {
                return;
            }
            dragSelecting = true;
            anchor = TextPositionAt(pressPoint);
            selected = -1;
        }
        // ponytail: only scrolls while the mouse keeps moving past an edge; add a
        // timer if holding still outside the pane should keep scrolling.
        if (scrolling && (e.Y < 0 || e.Y > ClientSize.Height))
        {
            scrollBar.Value = Math.Clamp(scrollBar.Value + (e.Y < 0 ? -20 : 20), 0, MaxScroll());
        }
        caret = TextPositionAt(e.Location);
        Invalidate();
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        // A click (not the end of a drag-selection) on a link opens it.
        if (e.Button == MouseButtons.Left && pressed && !dragSelecting && LinkAt(e.Location) is { } link)
        {
            OpenLink(link);
        }
        pressed = false;
        dragSelecting = false;
    }

    // The link URL under `point`, or null.
    internal string? LinkAt(Point point)
    {
        var index = HitTest(point);
        if (index < 0)
        {
            return null;
        }
        var m = messages[index];
        var x = point.X - m.Bounds.X - PadX;
        var y = point.Y + (scrolling ? scrollBar.Value : 0) - m.Bounds.Y - PadY;
        var allLines = m.ThoughtOpen ? m.ThoughtLines.Concat(m.Lines) : m.Lines;
        foreach (var line in allLines)
        {
            if (y < line.Y || y >= line.Y + line.Height)
            {
                continue;
            }
            foreach (var fragment in line.Fragments)
            {
                if (fragment.Link is not null && x >= fragment.X && x < fragment.X + fragment.Width)
                {
                    return fragment.Link;
                }
            }
        }
        return null;
    }

    // Opens web and mail links only -- the reply is model text, possibly
    // echoing web content, so no file:, ms-settings: or other handlers.
    internal static bool IsSafeLink(string link) =>
        Uri.TryCreate(link, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" or "mailto";

    private static void OpenLink(string link)
    {
        if (!IsSafeLink(link))
        {
            return;
        }
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(new Uri(link).AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Console.WriteLine($"ChatView: couldn't open {link}: {ex.Message}");
        }
    }

    // ---- Text selection -------------------------------------------------

    internal bool HasTextSelection => anchor is { } a && caret is { } c && Compare(a, c) != 0;

    internal void SelectText((int Msg, int Offset) from, (int Msg, int Offset) to)
    {
        anchor = from;
        caret = to;
        selected = -1;
        Invalidate();
    }

    private void ClearTextSelection()
    {
        if (anchor is not null || caret is not null)
        {
            anchor = caret = null;
            Invalidate();
        }
    }

    private static int Compare((int Msg, int Offset) a, (int Msg, int Offset) b) =>
        a.Msg != b.Msg ? a.Msg.CompareTo(b.Msg) : a.Offset.CompareTo(b.Offset);

    // The selected range within message `index`, as [from, to) offsets, or null.
    private (int From, int To)? SelectionIn(int index)
    {
        if (!HasTextSelection)
        {
            return null;
        }
        var (start, end) = Compare(anchor!.Value, caret!.Value) <= 0 ? (anchor.Value, caret.Value) : (caret.Value, anchor.Value);
        if (index < start.Msg || index > end.Msg)
        {
            return null;
        }
        return (index == start.Msg ? start.Offset : 0, index == end.Msg ? end.Offset : messages[index].Text.Length);
    }

    // Selected text; spans across bubbles are separated by a blank line.
    internal string SelectedText()
    {
        var parts = new List<string>();
        for (var i = 0; i < messages.Count; i++)
        {
            if (SelectionIn(i) is var (from, to))
            {
                var text = messages[i].Text;
                from = Math.Clamp(from, 0, text.Length);
                to = Math.Clamp(to, from, text.Length);
                parts.Add(text[from..to]);
            }
        }
        return string.Join(Environment.NewLine + Environment.NewLine, parts);
    }

    // Maps a point in the pane to the nearest (message, character offset).
    internal (int Msg, int Offset) TextPositionAt(Point point)
    {
        var y = point.Y + (scrolling ? scrollBar.Value : 0);
        for (var i = 0; i < messages.Count; i++)
        {
            var m = messages[i];
            if (y < m.Bounds.Top)
            {
                return (i, 0);
            }
            if (y <= m.Bounds.Bottom)
            {
                return (i, OffsetInMessage(m, point.X - m.Bounds.X - PadX, y - m.Bounds.Y - PadY));
            }
        }
        var last = messages.Count - 1;
        return (last, messages[last].Text.Length);
    }

    private static int OffsetInMessage(Message m, int x, int y)
    {
        if (m.Lines.Count == 0)
        {
            return 0;
        }
        var line = m.Lines[0];
        foreach (var candidate in m.Lines)
        {
            if (candidate.Y <= y)
            {
                line = candidate;
            }
        }
        var first = line.Fragments[0];
        var lastFragment = line.Fragments[^1];
        if (x <= first.X)
        {
            return first.Start;
        }
        foreach (var fragment in line.Fragments)
        {
            if (x < fragment.X + fragment.Width)
            {
                return fragment.Start + CharIndexAt(fragment, x - fragment.X);
            }
        }
        return lastFragment.Start + lastFragment.Text.Length;
    }

    // The character boundary in the fragment nearest to x.
    private static int CharIndexAt(Fragment fragment, int x)
    {
        var previous = 0;
        for (var k = 1; k <= fragment.Text.Length; k++)
        {
            var width = Measure(fragment.Text[..k], fragment.Font);
            if (width >= x)
            {
                return width - x < x - previous ? k : k - 1;
            }
            previous = width;
        }
        return fragment.Text.Length;
    }

    private void PaintActions(Graphics g, Message message, Point origin)
    {
        for (var a = 0; a < message.Actions.Count; a++)
        {
            var action = message.Actions[a];
            var rect = message.ActionBounds[a];
            rect.Offset(origin);
            var faded = message.ActionRunning;
            if (action.Primary)
            {
                using var fill = new SolidBrush(faded ? Color.FromArgb(140, DarkTheme.Accent) : DarkTheme.Accent);
                FillRound(g, fill, rect, ButtonRadius);
                var labelRect = action.Menu is null ? rect : new Rectangle(rect.X, rect.Y, rect.Width - MenuArrowWidth, rect.Height);
                TextRenderer.DrawText(g, action.Label, bodyFont, labelRect, DarkTheme.OnAccent,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
                if (action.Menu is not null)
                {
                    // #1426: a primary split button too (Allow, and its arrow's other answers).
                    var arrow = new Rectangle(rect.Right - MenuArrowWidth, rect.Y, MenuArrowWidth, rect.Height);
                    using var divider = new Pen(Color.FromArgb(110, DarkTheme.OnAccent));
                    g.DrawLine(divider, arrow.X, rect.Y + 5, arrow.X, rect.Bottom - 6);
                    TextRenderer.DrawText(g, "▾", bodyFont, arrow, DarkTheme.OnAccent,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
                }
            }
            else
            {
                using var fill = new SolidBrush(DarkTheme.IsGlass ? GlassSurface.Veil(190) : DarkTheme.Panel2);
                FillRound(g, fill, rect, ButtonRadius);
                using var border = new Pen(DarkTheme.Border);
                DrawRound(g, border, rect, ButtonRadius);
                var labelRect = action.Menu is null ? rect : new Rectangle(rect.X, rect.Y, rect.Width - MenuArrowWidth, rect.Height);
                TextRenderer.DrawText(g, action.Label, bodyFont, labelRect, faded ? DarkTheme.Muted : DarkTheme.Text,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
                if (action.Menu is not null)
                {
                    var arrow = new Rectangle(rect.Right - MenuArrowWidth, rect.Y, MenuArrowWidth, rect.Height);
                    g.DrawLine(border, arrow.X, rect.Y + 5, arrow.X, rect.Bottom - 6);
                    TextRenderer.DrawText(g, "\u25BE", bodyFont, arrow, faded ? DarkTheme.Muted : DarkTheme.Text,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
                }
            }
        }
        if (message.Note is not null)
        {
            var rect = message.NoteBounds;
            rect.Offset(origin);
            TextRenderer.DrawText(g, message.Note, bodyFont, rect, DarkTheme.Muted, TextFlags | TextFormatFlags.EndEllipsis);
        }
    }

    // The action button under `point`, as (message, button index), or null.
    private (int Msg, int Action, Rectangle Rect)? ActionAt(Point point)
    {
        var scroll = scrolling ? scrollBar.Value : 0;
        for (var i = 0; i < messages.Count; i++)
        {
            var m = messages[i];
            for (var a = 0; a < m.ActionBounds.Count; a++)
            {
                var rect = m.ActionBounds[a];
                rect.Offset(m.Bounds.X + PadX, m.Bounds.Y + PadY - scroll);
                if (rect.Contains(point))
                {
                    return (i, a, rect);
                }
            }
        }
        return null;
    }

    // A split button's dropdown, under its arrow (or the button, from the keyboard).
    private void ShowActionMenu(int index, int actionIndex, Point at)
    {
        var message = messages[index];
        if (message.ActionRunning || message.Actions[actionIndex].Menu is not { } items)
        {
            return;
        }
        var menu = new ContextMenuStrip();
        foreach (var item in items)
        {
            menu.Items.Add(new ToolStripMenuItem(item.Label, null, (_, _) => _ = RunMenuItemAsync(message, item)) { Enabled = item.Enabled });
        }
        menu.Closed += (_, _) => BeginInvoke(menu.Dispose); // after the clicked item's handler
        menu.Show(this, at);
    }

    private async Task RunMenuItemAsync(Message message, ChatMenuItem item)
    {
        try
        {
            await item.Run();
        }
        catch (Exception ex)
        {
            message.Note = $"Couldn't do that: {ex.Message}";
            message.Invalidate();
            Relayout(forceScroll: false);
        }
    }

    // Runs a button's action; a returned note replaces the buttons (e.g. "Approved").
    internal async Task RunActionAsync(int index, int actionIndex)
    {
        var message = messages[index];
        if (message.ActionRunning || actionIndex >= message.Actions.Count)
        {
            return;
        }
        message.ActionRunning = true;
        Invalidate();
        string? note;
        try
        {
            note = await message.Actions[actionIndex].Run();
        }
        catch (Exception ex)
        {
            note = $"Couldn't do that: {ex.Message}";
        }
        if (IsDisposed)
        {
            return;
        }
        message.ActionRunning = false;
        if (note is not null)
        {
            message.Actions.RemoveAll(a => !a.Keep);
            message.Note = note;
            message.Invalidate();
            Relayout(forceScroll: false);
        }
        Invalidate();
    }

    private void PaintSelection(Graphics g, int index, Fragment fragment, int originX, int lineTop, int lineHeight)
    {
        if (SelectionIn(index) is not var (from, to))
        {
            return;
        }
        var a = Math.Max(from, fragment.Start);
        var b = Math.Min(to, fragment.Start + fragment.Text.Length);
        if (a >= b)
        {
            return;
        }
        var x1 = a == fragment.Start ? 0 : Measure(fragment.Text[..(a - fragment.Start)], fragment.Font);
        var x2 = Measure(fragment.Text[..(b - fragment.Start)], fragment.Font);
        using var highlight = new SolidBrush(Color.FromArgb(DarkTheme.IsLight ? 90 : 120, DarkTheme.Accent));
        g.FillRectangle(highlight, originX + fragment.X + x1, lineTop, Math.Max(1, x2 - x1), lineHeight);
    }

    internal int HitTest(Point point)
    {
        var scroll = scrolling ? scrollBar.Value : 0;
        var y = point.Y + scroll;
        for (var i = 0; i < messages.Count; i++)
        {
            if (messages[i].Bounds.Contains(point.X, y) || messages[i].LabelBounds.Contains(point.X, y))
            {
                return i;
            }
        }
        return -1;
    }

    // #701: a clicked chat bubble -- selects (and scrolls to) Mana's latest
    // message containing that sentence, else her latest message.
    public void SelectMessageContaining(string sentence)
    {
        var index = LatestManaMessage(sentence);
        if (index >= 0)
        {
            Select(index);
        }
    }

    // -1 when Mana has no messages.
    internal int LatestManaMessage(string sentence)
    {
        var mana = Enumerable.Range(0, messages.Count).Reverse().Where(i => !messages[i].FromUser).ToList();
        return mana.Count == 0
            ? -1
            : mana.FirstOrDefault(i => messages[i].PlainText.Contains(sentence.Trim(), StringComparison.OrdinalIgnoreCase), mana[0]);
    }

    internal void Select(int index)
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
        if (!scrolling)
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
        keyData is Keys.Up or Keys.Down or Keys.Left or Keys.Right or Keys.Home or Keys.End or Keys.Escape or Keys.Enter or Keys.E or Keys.F2 or Keys.R or Keys.B or (Keys.Alt | Keys.Down) || base.IsInputKey(keyData);

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
            case Keys.Control | Keys.A:
                SelectText((0, 0), (messages.Count - 1, messages[^1].Text.Length));
                e.Handled = true;
                break;
            case Keys.Escape:
                ClearTextSelection();
                e.Handled = true;
                break;
            case Keys.Alt | Keys.Down when selected >= 0 && messages[selected].Actions.FindIndex(a => a.Menu is not null) is var menuAt and >= 0:
            {
                var rect = messages[selected].ActionBounds[menuAt];
                rect.Offset(messages[selected].Bounds.X + PadX, messages[selected].Bounds.Y + PadY - (scrolling ? scrollBar.Value : 0));
                ShowActionMenu(selected, menuAt, new Point(rect.X, rect.Bottom));
                e.Handled = true;
                break;
            }
            case Keys.Enter when selected >= 0 && messages[selected].Actions.Count > 0:
                _ = RunActionAsync(selected, 0);
                e.Handled = true;
                break;
            case Keys.E or Keys.F2 when selected >= 0 && selected < messages.Count && messages[selected].FromUser && messages[selected].TurnIndex >= 0:
                OnEditMessage?.Invoke(messages[selected].TurnIndex, messages[selected].PlainText);
                e.Handled = true;
                break;
            case Keys.R when selected >= 0 && selected < messages.Count && !messages[selected].FromUser && messages[selected].TurnIndex >= 0:
                OnRegenerateReply?.Invoke(messages[selected].TurnIndex);
                e.Handled = true;
                break;
            case Keys.B when selected >= 0 && selected < messages.Count && messages[selected].TurnIndex >= 0:
                OnBranchFromMessage?.Invoke(messages[selected].TurnIndex);
                e.Handled = true;
                break;
            case Keys.Left when selected >= 0 && selected < messages.Count && messages[selected].Versions is { Count: > 1 } v && messages[selected].VersionIndex > 0:
                OnSwitchTurnVersion?.Invoke(messages[selected].TurnIndex, messages[selected].VersionIndex - 1);
                e.Handled = true;
                break;
            case Keys.Right when selected >= 0 && selected < messages.Count && messages[selected].Versions is { Count: > 1 } v && messages[selected].VersionIndex < v.Count - 1:
                OnSwitchTurnVersion?.Invoke(messages[selected].TurnIndex, messages[selected].VersionIndex + 1);
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
        if (scrolling)
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
                var scroll = view.scrolling ? view.scrollBar.Value : 0;
                var b = view.messages[index].Bounds;
                return view.RectangleToScreen(b with { Y = b.Y - scroll });
            }
        }
        public override void Select(AccessibleSelection flags) => view.Select(index);
        public override void DoDefaultAction() => view.Select(index);
        public override int GetChildCount() => view.messages[index].Actions.Count;
        public override AccessibleObject? GetChild(int child) =>
            child >= 0 && child < view.messages[index].Actions.Count ? new ActionAccessibleObject(view, this, index, child) : null;
    }

    private sealed class ActionAccessibleObject : AccessibleObject
    {
        private readonly ChatView view;
        private readonly AccessibleObject parent;
        private readonly int index;
        private readonly int action;

        public ActionAccessibleObject(ChatView view, AccessibleObject parent, int index, int action)
        {
            this.view = view;
            this.parent = parent;
            this.index = index;
            this.action = action;
        }

        public override string Name => view.messages[index].Actions[action].Label;
        public override AccessibleRole Role => AccessibleRole.PushButton;
        public override AccessibleObject Parent => parent;
        public override string DefaultAction => "Press";
        public override void DoDefaultAction() => _ = view.RunActionAsync(index, action);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            bodyFont.Dispose();
            foreach (var font in styledFonts.Values)
            {
                font.Dispose();
            }
            headerFont.Dispose();
            codeFont.Dispose();
            labelFont.Dispose();
            stampFont.Dispose();
            greetingFont.Dispose();
            linkTip.Dispose();
            glow?.Dispose();
            ContextMenuStrip?.Dispose();
            foreach (var image in messages.SelectMany(m => m.Images))
            {
                image.Dispose();
            }
        }
        base.Dispose(disposing);
    }

    // ---- Model ----------------------------------------------------------

    internal sealed class Message
    {
        public Message(bool fromUser) => FromUser = fromUser;

        public bool FromUser { get; }
        // #914: the character's name on her messages (null: Mana).
        public string? Name { get; init; }
        // When you sent it (your messages only), for the time under the bubble.
        public DateTime? At { get; set; }
        public string? AnswerModel { get; set; }
        public bool CloudFallback { get; set; }
        public string Speaker => FromUser ? "You" : (Name ?? "Mana") + (AnswerModel is null ? "" : $" · {AnswerModel}{(CloudFallback ? " (fallback)" : "")}");
        public List<MarkdownBlock> Blocks { get; } = new();
        public List<Line> Lines { get; set; } = new();
        public string Text { get; set; } = "";
        public int LaidOutWidth { get; set; } = -1;
        public int ContentWidth { get; set; }
        public int ContentHeight { get; set; }
        public Rectangle Bounds { get; set; }
        public Rectangle LabelBounds { get; set; }
        public List<ChatAction> Actions { get; } = new();
        public List<ChatAction> AnalysisActions { get; } = new();
        public List<MarkdownBlock> AnalysisBlocks { get; } = new();
        public List<Rectangle> ActionBounds { get; } = new();
        public string? Note { get; set; }
        public Rectangle NoteBounds { get; set; }
        public bool ActionRunning { get; set; }
        public List<(Rectangle Bounds, bool Header)> Cells { get; } = new(); // table cells, in content coordinates
        // Mockup A: each code block's top and bottom (content coordinates) and its text, for its Copy button.
        public List<(int Top, int Bottom, string Code, string Language)> CodeBlocks { get; } = new();
        public List<Bitmap> Images { get; } = new(); // #679: thumbnails of a user message's images
        public List<Rectangle> ImageBounds { get; } = new(); // in content coordinates

        // The full reply text once VoiceLoop reported it; later sentences start a new bubble.
        public string? FinalText { get; set; }

        // #1426: set on a request card (ShowApprovalCard): the approval's id.
        public string? ApprovalId { get; init; }

        // #1318: set on a grey step-group line (no bubble, no label) placed
        // after the reply text of its segment; clicking it toggles StepsOpen.
        public StepGroup? Steps { get; set; }
        public bool StepsOpen { get; set; }

        // #1354: reasoning tokens / thought deliberation dropdown
        public string? Thought { get; set; }
        public bool ThoughtOpen { get; set; }
        public Rectangle ThoughtHeaderBounds { get; set; }
        public List<Line> ThoughtLines { get; set; } = new();

        // #1329: verified web sources cited in the reply
        public List<WebSourceCitation>? Sources { get; set; }

        // #1322: chat branching and version stepping
        public int TurnIndex { get; set; } = -1;
        public IReadOnlyList<string>? Versions { get; set; }
        public int VersionIndex { get; set; }
        public Rectangle EditBtnBounds { get; set; }
        public Rectangle RegenerateBtnBounds { get; set; }
        public Rectangle BranchBtnBounds { get; set; }
        public Rectangle VersionPrevBounds { get; set; }
        public Rectangle VersionNextBounds { get; set; }
        public Rectangle VersionLabelBounds { get; set; }

        public void Invalidate() => LaidOutWidth = -1;

        public string PlainText
        {
            get
            {
                var text = new StringBuilder();
                if (Images.Count > 0)
                {
                    text.Append(Images.Count == 1 ? "[image]" : $"[{Images.Count} images]");
                }
                if (ThoughtOpen && !string.IsNullOrWhiteSpace(Thought))
                {
                    if (text.Length > 0)
                    {
                        text.AppendLine();
                    }
                    text.Append($"[Thought Process: {Thought.Trim()}]");
                }
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
                    if (block.Rows is { } rows)
                    {
                        text.AppendJoin(Environment.NewLine,
                            rows.Select(row => string.Join("\t", row.Select(cell => string.Concat(cell.Select(r => r.Text))))));
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

    internal sealed record Line(int Y, int Height, bool Code, List<Fragment> Fragments, bool Quote = false);

    // A button under one of Mana's messages. Run returns a note to show in
    // place of the buttons once it's done, or null to keep them. Keep: stays
    // when a note or a new set of buttons replaces the others.
    // Menu makes it a split button: its arrow part lists these (Alt+Down from the keyboard).
    internal sealed record ChatAction(string Label, bool Primary, Func<Task<string?>> Run, bool Keep = false,
        IReadOnlyList<ChatMenuItem>? Menu = null);

    internal sealed record ChatMenuItem(string Label, bool Enabled, Func<Task<string?>> Run);

    // Start: offset of Text within the message's Text. Link: its URL, if it's part of a link.
    internal sealed record Fragment(string Text, Font Font, int X, int Width, bool IsCode, int Start, string? Link = null);
}
