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

    private static ManaBackendClient Backend(List<string> requests, Func<string> activity) =>
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
            // The javascript: link from outside content never opens.
            Assert.Equal(["https://a.test/x"], opened);

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
    public void Tool_TakesOverInAWindow_ShowsWhySheAsked_AndHandsBackOnDone()
    {
        RunSta(() =>
        {
            var requests = new List<string>();
            var takeOverState = """{"active":false,"needsYou":"Log in to the shop"}""";
            using var tool = new BrowserTool(Backend(requests, () => Activity("t1", takeOverState)));
            var opened = new List<string>();
            tool.OpenUrl = opened.Add;
            Label Title() => tool.Controls.OfType<Label>().Last(); // added last: the title
            Button TakeOverButton() => tool.Controls.OfType<Panel>().SelectMany(p => p.Controls.OfType<Button>()).Single(b => b.Dock == DockStyle.Left);

            Pump(tool.RefreshAsync());
            Assert.Equal("She needs you: Log in to the shop", Title().Text);
            var button = TakeOverButton();
            Assert.Equal("Take over", button.Text);

            // Take over asks the backend for the window at her page; it never
            // opens my own browser.
            Click(button);
            Pump(() => requests.Contains("""POST /browser/take-over {"url":"https://shop.test/cart"}""") && button.Enabled);
            takeOverState = """{"active":true,"needsYou":null}""";
            Pump(tool.RefreshAsync());
            Assert.Equal("Done", button.Text);
            Assert.Equal("Done: hand her browser back", button.AccessibleName);
            Assert.Equal("You have her browser. Press Done when you're finished.", Title().Text);
            Assert.True(button.Enabled);

            Click(button);
            Pump(() => requests.Contains("POST /browser/hand-back") && button.Enabled);
            takeOverState = NotTakenOver;
            Pump(tool.RefreshAsync());
            Assert.Equal("Take over", button.Text);
            Assert.Equal("Cart", Title().Text);
            Assert.Empty(opened);
        });
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
