using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1122: the rail's Browser tool and the floating window, against a fake
// backend. Real controls on an STA thread, never shown; nothing opens a
// browser.
public class BrowserToolTests
{
    private const string NotTakenOver = """{"active":false,"needsYou":null}""";

    private static string Activity(string lastAt, string takeOver = NotTakenOver, string blocked = "null") => $$"""
        {"log":[{"action":"navigate","status":"ok","summary":"Navigating to https://shop.test/","at":"{{lastAt}}"}],
         "screenshot":null,
         "page":{"url":"https://shop.test/cart","title":"Cart"},
         "turnPages":[{"source":"web search","url":"https://a.test/x"},{"source":"web page","url":"javascript:alert(1)"}],
         "takeOver":{{takeOver}},
         "blocked":{{blocked}}}
        """;

    // #1140: /web/read's reader answer: Markdown, a fetched image as data:,
    // and one that isn't data: (never handed to Folio).
    private const string ReaderPage = """
        {"url":"https://a.test/x","title":"Chocobo racing","text":"# Chocobo racing\n\nBack at the [Gold Saucer](/saucer).\n\n| Track | Length |\n| --- | --- |\n| Sagolii | 3 min |\n\n![Start line](/start.png) ![Tracker](https://t.test/p.png)",
         "truncated":true,"needsBrowser":null,
         "images":{"/start.png":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","https://t.test/p.png":"https://t.test/p.png"}}
        """;

    private static ManaBackendClient Backend(List<string> requests, Func<string> activity, string? readerPage = ReaderPage) =>
        new(new FakeHttpMessageHandler(request =>
        {
            var path = request.RequestUri!.AbsolutePath;
            var body = request.Content?.ReadAsStringAsync().Result;
            requests.Add(body is { Length: > 2 } ? $"{request.Method} {path} {body}" : $"{request.Method} {path}");
            var json = path switch
            {
                "/browser-automation/activity" => activity(),
                "/browser/close" => """{"ok":true}""",
                "/browser/take-over" or "/browser/hand-back" => NotTakenOver,
                "/browser/manual/start" => """{"token":"manual-test-token"}""",
                "/browser/manual/done" or "/browser/manual/input" => """{"active":false}""",
                "/browser/manual/frame" => """{"image":null,"width":800,"height":600,"url":"https://shop.test/cart"}""",
                "/browser-automation/site-test" => """{"url":"","title":"Site test: shop.test","text":"# Site test: shop.test\n\n### phone\n![phone screenshot](shot-1)\n\n- Console errors: none","images":{"shot-1":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="},"truncated":false,"needsBrowser":null}""",
                "/browser/offer-files" => """{"offered":["C:\\files\\cv.pdf"]}""",
                "/web/read" => readerPage,
                _ => null,
            };
            return json is null
                ? new HttpResponseMessage(HttpStatusCode.NotFound)
                : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }));

    [Fact]
    public async Task Client_ReadsThePageAndThisTurnsPages()
    {
        var activity = await Backend([], () => Activity("t1")).GetBrowserAutomationActivityAsync();
        Assert.Equal("https://shop.test/cart", activity.PageUrl);
        Assert.Equal("Cart", activity.PageTitle);
        Assert.Equal(["web search", "web page"], activity.TurnPages.Select(p => p.Source));

        Assert.False(activity.TakenOver);
        Assert.Null(activity.NeedsYou);

        var before = await Backend([], () => """{"log":[],"screenshot":null}""").GetBrowserAutomationActivityAsync();
        Assert.Null(before.PageUrl);
        Assert.Empty(before.TurnPages);
        Assert.False(before.TakenOver);

        var asking = await Backend([], () => Activity("t1", """{"active":true,"needsYou":"Log in"}""")).GetBrowserAutomationActivityAsync();
        Assert.True(asking.TakenOver);
        Assert.Equal("Log in", asking.NeedsYou);
    }

    [Theory]
    [InlineData("https://a.test/x", true)]
    [InlineData("http://a.test", true)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("file:///C:/Windows/System32/calc.exe", false)]
    [InlineData(null, false)]
    public void OnlyWebPagesOpen(string? url, bool opens) => Assert.Equal(opens, BrowserTool.IsWebUrl(url));

    [Fact]
    public void Tool_ShowsThePage_OpensOnlyWebLinks_AndStops()
    {
        RunSta(() =>
        {
            var requests = new List<string>();
            var lastAt = "t1";
            using var tool = new BrowserTool(Backend(requests, () => Activity(lastAt)));
            var opened = new List<string>();
            tool.OpenUrl = opened.Add;

            Pump(tool.RefreshAsync());
            Assert.Contains(tool.Controls.OfType<Label>(), l => l.Text == "Cart");
            Assert.Contains(tool.Controls.OfType<Label>(), l => l.Text == "https://shop.test/cart");
            Assert.Equal(["Navigating to https://shop.test/"], Find<ListBox>(tool).Items.Cast<string>());
            var pages = Find<ListView>(tool);
            Assert.Equal(["https://a.test/x", "javascript:alert(1)"], pages.Items.Cast<ListViewItem>().Select(i => i.SubItems[1].Text));

            var takeOver = tool.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<Button>()).Single(b => b.Text == "Take over");
            _ = pages.Handle; // SelectedItems needs the native list
            foreach (ListViewItem item in pages.Items)
            {
                item.Selected = true;
                Invoke(pages, "OnItemActivate");
                item.Selected = false;
            }
            // #1140: a page opens in the reader, not the browser; the
            // javascript: link from outside content is never read or opened.
            // (#1139: Take over no longer opens my browser either.)
            Pump(() => tool.Reader.Note.Length > 0);
            Assert.Empty(opened);
            Assert.Single(requests, r => r.StartsWith("POST /web/read"));
            Assert.Contains(requests, r => r == """POST /web/read {"url":"https://a.test/x","reader":true}""");

            var stop = tool.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<Button>()).Single(b => b.Text == "Stop");
            Click(stop);
            Pump(() => requests.Contains("POST /browser/close") && stop.Enabled);
            Assert.Contains(tool.Controls.OfType<Label>(), l => l.Text == "Her browser session is closed.");
            Assert.False(takeOver.Enabled);

            // A new step: she's back on a page.
            lastAt = "t2";
            Pump(tool.RefreshAsync());
            Assert.Contains(tool.Controls.OfType<Label>(), l => l.Text == "Cart");
        });
    }

    [Fact]
    public void Tool_TakesOverInsideMana_ShowsWhySheAsked_AndHandsBackOnDone()
    {
        RunSta(() =>
        {
            var requests = new List<string>();
            var takeOverState = """{"active":false,"needsYou":"Log in to the shop"}""";
            using var tool = new BrowserTool(Backend(requests, () => Activity("t1", takeOverState)));
            var opened = new List<string>();
            tool.OpenUrl = opened.Add;
            Label Title() => tool.Controls.OfType<Label>().Last(); // added last: the title
            Button TakeOverButton() => tool.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<Button>()).Single(b => b.Text is "Take over" or "Done");

            Pump(tool.RefreshAsync());
            Assert.Equal("She needs you: Log in to the shop", Title().Text);
            var button = TakeOverButton();
            Assert.Equal("Take over", button.Text);

            // Manual frames and input stay inside Mana; no browser opens.
            Click(button);
            Pump(() => requests.Contains("""POST /browser/manual/start {"url":"https://shop.test/cart"}""") && button.Enabled);
            takeOverState = """{"active":true,"needsYou":null}""";
            Pump(tool.RefreshAsync());
            Assert.Equal("Done", button.Text);
            Assert.Equal("Done: hand her browser back", button.AccessibleName);
            Assert.Equal("You have her browser. Press Done when you're finished.", Title().Text);
            Assert.True(button.Enabled);

            Click(button);
            Pump(() => requests.Contains("POST /browser/manual/done") && button.Enabled);
            takeOverState = NotTakenOver;
            Pump(tool.RefreshAsync());
            Assert.Equal("Take over", button.Text);
            Assert.Equal("Cart", Title().Text);
            Assert.Empty(opened);
        });
    }

    [Fact]
    public void ManualCoordinatesRespectLetterboxing_AndKeyboardModifiers()
    {
        Assert.Equal(new System.Drawing.Point(400, 300), BrowserPageView.PagePoint(new(200, 100), new(400, 200), new(800, 600)));
        Assert.Null(BrowserPageView.PagePoint(new(0, 100), new(400, 200), new(800, 600)));
        Assert.Equal("Control+A", BrowserPageView.BrowserKey(new KeyEventArgs(Keys.Control | Keys.A)));
        Assert.Equal("Shift+Tab", BrowserPageView.BrowserKey(new KeyEventArgs(Keys.Shift | Keys.Tab)));
        Assert.Equal("Space", BrowserPageView.BrowserKey(new KeyEventArgs(Keys.Space)));
        Assert.Null(BrowserPageView.BrowserKey(new KeyEventArgs(Keys.A)));
    }

    [Theory]
    [InlineData(280)]
    [InlineData(640)]
    public void BrowserButtonsFitWithoutOverlapAtNarrowAndWideWidths(int width)
    {
        RunSta(() =>
        {
            using var tool = new BrowserTool(Backend([], () => Activity("t1"))) { Size = new System.Drawing.Size(width, 620) };
            Pump(tool.RefreshAsync());
            tool.CreateControl();
            tool.PerformLayout();
            var row = tool.Controls.OfType<FlowLayoutPanel>().Single();
            row.PerformLayout();
            var buttons = row.Controls.OfType<Button>().ToArray();
            foreach (var button in buttons) Assert.True(row.ClientRectangle.Contains(button.Bounds), $"{button.Text}: {button.Bounds} outside {row.ClientRectangle}");
            for (int i = 0; i < buttons.Length; i++)
                for (int j = i + 1; j < buttons.Length; j++) Assert.False(buttons[i].Bounds.IntersectsWith(buttons[j].Bounds));
            var capture = Environment.GetEnvironmentVariable("MANA_BROWSER_UI_CAPTURE");
            if (!string.IsNullOrEmpty(capture))
            {
                System.IO.Directory.CreateDirectory(capture);
                using var bitmap = new System.Drawing.Bitmap(width, 620);
                tool.DrawToBitmap(bitmap, tool.ClientRectangle);
                bitmap.Save(System.IO.Path.Combine(capture, $"browser-panel-{width}.png"));
            }
        });
    }

    [Fact]
    public void StoppingWhileAFrameIsInFlightDoesNotRestoreItsImage()
    {
        RunSta(() =>
        {
            using var handler = new DelayedBrowserFrameHandler();
            using var tool = new BrowserTool(new ManaBackendClient(handler));
            Pump(tool.RefreshAsync());
            var buttons = tool.Controls.OfType<Panel>().SelectMany(panel => panel.Controls.OfType<Button>()).ToArray();
            Click(buttons.Single(button => button.Text == "Take over"));
            Pump(() => handler.FrameRequested);
            Click(buttons.Single(button => button.Text == "Stop"));
            Pump(() => handler.Stopped);
            handler.Frame.SetResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("""{"image":"late-frame","url":"https://private.test/","width":800,"height":600}""") });
            Pump(() => (bool)typeof(BrowserTool).GetField("polling", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(tool)! == false);
            Pump(tool.RefreshAsync());
            Assert.Null(typeof(BrowserTool).GetField("manualImage", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(tool));
            Assert.Null(tool.Controls.OfType<PictureBox>().Single().Image);
        });
    }

    private sealed class DelayedBrowserFrameHandler : HttpMessageHandler
    {
        public TaskCompletionSource<HttpResponseMessage> Frame { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool FrameRequested { get; private set; }
        public bool Stopped { get; private set; }
        private bool active;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            string json;
            switch (request.RequestUri!.AbsolutePath)
            {
                case "/browser/manual/start": active = true; json = """{"token":"manual-token"}"""; break;
                case "/browser/manual/frame": FrameRequested = true; return Frame.Task;
                case "/browser/close": active = false; Stopped = true; json = "{}"; break;
                default: json = Activity("t1", active ? """{"active":true}""" : NotTakenOver); break;
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json) });
        }
    }

    [Fact]
    public void Tool_OffersMyBrowser_WhenTheSiteMayNeedWhatWasBlocked()
    {
        RunSta(() =>
        {
            var blocked = """{"url":"https://news.test/a","count":3}""";
            using var tool = new BrowserTool(Backend([], () => Activity("t1", blocked: blocked)));
            var opened = new List<string>();
            tool.OpenUrl = opened.Add;
            var open = tool.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<Button>()).Single(b => b.Text == "Open in my browser");

            // Never shown, so the row's Visible reads false either way: check its note.
            Label Note() => open.Parent!.Controls.OfType<Label>().Single();
            Pump(tool.RefreshAsync());
            Assert.Equal("This site may need the 3 ad/tracker request(s) her browser blocked.", Note().Text);
            Click(open);
            Assert.Equal(["https://news.test/a"], opened);

            // Nothing blocked, or not a web page: no offer.
            blocked = """{"url":"javascript:alert(1)","count":3}""";
            Pump(tool.RefreshAsync());
            Assert.Equal("", Note().Text);
            blocked = "null";
            Pump(tool.RefreshAsync());
            Assert.Equal("", Note().Text);
        });
    }

    // #1161: the Test report button opens her latest site test in the
    // reader, drawn by Folio; it's off until there is one.
    [Fact]
    public void Tool_OpensHerLatestSiteTestReport()
    {
        RunSta(() =>
        {
            var requests = new List<string>();
            var siteTest = "null";
            using var tool = new BrowserTool(Backend(requests, () => Activity("t1").Replace("\"takeOver\":", $"\"siteTest\":{siteTest},\"takeOver\":")));
            var report = tool.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<Button>()).Single(b => b.Text == "Test report");
            Pump(tool.RefreshAsync());
            Assert.False(report.Enabled);

            siteTest = """{"title":"Site test: shop.test","at":"t1"}""";
            Pump(tool.RefreshAsync());
            Assert.True(report.Enabled);
            Click(report);
            Pump(() => tool.Reader.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<Label>()).Any(l => l.Text == "Site test: shop.test"));
            Assert.Contains("GET /browser-automation/site-test", requests);
        });
    }

    // #1158: the files she may upload come from my picker; nothing is sent
    // when I cancel it.
    [Fact]
    public void Tool_GivesHerOnlyTheFilesIPick()
    {
        RunSta(() =>
        {
            var requests = new List<string>();
            using var tool = new BrowserTool(Backend(requests, () => Activity("t1")));
            string[]? picked = null;
            tool.PickFiles = () => picked;
            var give = tool.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<Button>()).Single(b => b.Text == "Give her a file");

            Click(give);
            Assert.DoesNotContain(requests, r => r.Contains("offer-files"));

            picked = [@"C:\files\cv.pdf"];
            Click(give);
            Pump(() => tool.Controls.OfType<Label>().Last().Text == "She may upload: cv.pdf");
            Assert.Contains("""POST /browser/offer-files {"paths":["C:\\files\\cv.pdf"]}""", requests);
        });
    }

    // #1169: the hand-over toast's Take over does what the panel's does;
    // Open Chat still opens the chat.
    [Fact]
    public async Task Toast_TakeOver_AsksTheBackendForTheWindow()
    {
        var requests = new List<string>();
        var chats = 0;
        var backend = Backend(requests, () => Activity("t1"));
        await TrayNotificationClient.HandleActivationAsync($"action={TrayNotificationClient.BrowserTakeOverAction}", () => chats++, backend);
        Assert.Equal(["""POST /browser/take-over {"url":null}"""], requests);

        await TrayNotificationClient.HandleActivationAsync("action=openChat", () => chats++, backend);
        await TrayNotificationClient.HandleActivationAsync($"action={TrayNotificationClient.BrowserTakeOverAction}", () => chats++, null);
        Assert.Equal(1, chats);
        Assert.Single(requests);
    }

    [Fact]
    public void Reader_DrawsTheCleanPage_WithOnlyDataImages_AndOpensTheRealOne()
    {
        var page = new ManaReaderPage
        {
            Text = "![Start line](/start.png) ![Tracker](https://t.test/p.png) <script>alert(1)</script>",
            Images = new Dictionary<string, string> { ["/start.png"] = "data:image/png;base64,AQID", ["https://t.test/p.png"] = "https://t.test/p.png" },
        };
        var html = ReaderView.Html(page);
        Assert.Contains("<img src=\"data:image/png;base64,AQID\" alt=\"Start line\">", html);
        Assert.Contains("<em>Tracker</em>", html); // never a web src Folio could fetch
        Assert.DoesNotContain("<script>", html);
        // The extractor escapes \ and | in table cells; the cells show them as written.
        var table = ReaderView.Html(new ManaReaderPage { Text = "| Path | Pipe |\n| --- | --- |\n" + @"| C:\\dir | a\|b |" });
        Assert.Contains(@"<td>C:\dir</td><td>a|b</td>", table);

        RunSta(() =>
        {
            var requests = new List<string>();
            using var reader = new ReaderView(Backend(requests, () => "{}"), () => { }) { Size = new System.Drawing.Size(320, 240) };
            var opened = new List<string>();
            reader.OpenUrl = opened.Add;
            Pump(reader.ShowAsync("https://a.test/x"));

            Assert.Contains(reader.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<Label>()), l => l.Text == "Chocobo racing");
            Assert.Equal("A long page: this is the first part of it.", reader.Note);
            Assert.Contains(reader.Controls.OfType<LinkLabel>(), l => l.Text == "https://a.test/x");

            // Folio draws it off-screen.
            using var bitmap = new System.Drawing.Bitmap(300, 200);
            reader.View.Size = new System.Drawing.Size(300, 200);
            reader.View.DrawToBitmap(bitmap, new System.Drawing.Rectangle(0, 0, 300, 200));
            var background = bitmap.GetPixel(299, 199);
            Assert.Contains(Enumerable.Range(0, 300 * 200), i => bitmap.GetPixel(i % 300, i / 300) != background);

            Click(reader.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<Button>()).Single(b => b.Text == "Open in my browser"));
            Assert.Equal(["https://a.test/x"], opened);
        });
    }

    [Theory]
    [InlineData("""{"url":"https://app.test/","title":"Dashboard","text":"","truncated":false,"needsBrowser":"its content is built by scripts","images":{}}""", "This page needs a browser (its content is built by scripts): open it in your browser to see all of it.")]
    [InlineData(null, "HTTP 404")]
    public void Reader_SaysWhenAPageNeedsTheBrowserOrCantBeRead(string? readerPage, string note)
    {
        RunSta(() =>
        {
            using var reader = new ReaderView(Backend([], () => "{}", readerPage), () => { });
            Pump(reader.ShowAsync("https://app.test/"));
            Assert.Equal(note, reader.Note);
        });
    }

    [Theory]
    [InlineData(true, false, false, true)]   // active, nothing docked: pops up
    [InlineData(true, false, true, false)]   // the docked tool shows it instead
    [InlineData(false, false, false, false)] // idle: hidden
    [InlineData(false, true, true, true)]    // the tray's "Browser activity" keeps it open
    public void FloatingWindow_ShowsOnlyWhenTheDockedToolIsntOnScreen(bool active, bool keepOpen, bool docked, bool shows) =>
        Assert.Equal(shows, BrowserAutomationPanel.ShouldShow(active, keepOpen, docked));

    [Fact]
    public void FloatingWindow_NeverTakesFocus()
    {
        RunSta(() =>
        {
            using var panel = new BrowserAutomationPanel(Backend([], () => """{"log":[]}"""));
            var showWithoutActivation = typeof(Form).GetProperty("ShowWithoutActivation", BindingFlags.NonPublic | BindingFlags.Instance)!;
            Assert.True((bool)showWithoutActivation.GetValue(panel)!);
        });
    }

    private static void Pump(Task task) => Pump(() => task.IsCompleted);

    private static void Pump(Func<bool> done)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!done())
        {
            Assert.True(DateTime.UtcNow < deadline, "timed out");
            Application.DoEvents();
            Thread.Sleep(1);
        }
    }

    private static void Click(Button button) => Invoke(button, "OnClick");

    private static void Invoke(Control control, string method) =>
        control.GetType().GetMethod(method, BindingFlags.NonPublic | BindingFlags.Instance, [typeof(EventArgs)])!.Invoke(control, [EventArgs.Empty]);

    private static T Find<T>(Control root) where T : Control => root.Controls.OfType<T>().Single();

    private static void RunSta(Action body)
    {
        Exception? error = null;
        var thread = new Thread(() =>
        {
            try
            {
                body();
            }
            catch (Exception ex)
            {
                error = ex;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (error is not null)
        {
            ExceptionDispatchInfo.Capture(error).Throw();
        }
    }
}
