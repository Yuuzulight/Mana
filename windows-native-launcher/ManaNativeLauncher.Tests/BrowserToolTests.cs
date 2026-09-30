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
    private static string Activity(string lastAt) => $$"""
        {"log":[{"action":"navigate","status":"ok","summary":"Navigating to https://shop.test/","at":"{{lastAt}}"}],
         "screenshot":null,
         "page":{"url":"https://shop.test/cart","title":"Cart"},
         "turnPages":[{"source":"web search","url":"https://a.test/x"},{"source":"web page","url":"javascript:alert(1)"}]}
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
            requests.Add(path == "/web/read" ? $"{request.Method} {path} {request.Content!.ReadAsStringAsync().Result}" : $"{request.Method} {path}");
            var json = path switch
            {
                "/browser-automation/activity" => activity(),
                "/browser/close" => """{"ok":true}""",
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

        var before = await Backend([], () => """{"log":[],"screenshot":null}""").GetBrowserAutomationActivityAsync();
        Assert.Null(before.PageUrl);
        Assert.Empty(before.TurnPages);
    }

    [Theory]
    [InlineData("https://a.test/x", true)]
    [InlineData("http://a.test", true)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("file:///C:/Windows/System32/calc.exe", false)]
    [InlineData(null, false)]
    public void OnlyWebPagesOpen(string? url, bool opens) => Assert.Equal(opens, BrowserTool.IsWebUrl(url));

    [Fact]
    public void Tool_ShowsThePage_TakesOver_OpensOnlyWebLinks_AndStops()
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
            Click(takeOver);
            _ = pages.Handle; // SelectedItems needs the native list
            foreach (ListViewItem item in pages.Items)
            {
                item.Selected = true;
                Invoke(pages, "OnItemActivate");
                item.Selected = false;
            }
            // #1140: a page opens in the reader, not the browser; the
            // javascript: link from outside content is never read or opened.
            Pump(() => tool.Reader.Note.Length > 0);
            Assert.Equal(["https://shop.test/cart"], opened);
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
