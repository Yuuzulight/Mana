using System.Drawing;
using System.Net;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// The chat window as it really draws, saved as PNGs to look at: only when MANA_WINDOW_SNAPSHOT_DIR is set (it opens a
// window), so ordinary runs skip it. MANA_WINDOW_SNAPSHOT_PRESETS picks presets (comma-separated, default "mana").
public class WindowSnapshotTests
{
    [Fact]
    public void SavesTheChatWindowPerPreset()
    {
        if (Environment.GetEnvironmentVariable("MANA_WINDOW_SNAPSHOT_DIR") is not { Length: > 0 } output)
        {
            return;
        }
        Directory.CreateDirectory(output);
        var presets = (Environment.GetEnvironmentVariable("MANA_WINDOW_SNAPSHOT_PRESETS") ?? "mana").Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        foreach (var preset in presets)
        {
            foreach (var width in new[] { 1180, 640 })
            {
                RunSta(() => Snapshot(preset, width, Path.Combine(output, $"window-{preset}-{width}.png")));
            }
        }
    }

    private static void Snapshot(string preset, int width, string path)
    {
        DarkTheme.ApplyPreset(preset, null);
        var client = new ManaBackendClient(new FakeHttpMessageHandler(request => Json(request.RequestUri?.AbsolutePath switch
        {
            "/sessions" => """{"sessions":[{"sessionId":"a","name":"Folio table speed","updatedAt":"2026-11-05T21:40:00Z"},{"sessionId":"b","name":"Friday stream plan","updatedAt":"2026-11-05T20:10:00Z"},{"sessionId":"c","name":"Bonsai 2 benchmark","updatedAt":"2026-11-05T14:00:00Z"},{"sessionId":"d","name":"Otsumana~ clip picks","updatedAt":"2026-11-04T22:00:00Z"}]}""",
            "/projects" => """{"projects":[]}""",
            _ => "{}",
        })));
        var root = Directory.CreateTempSubdirectory("mana-snapshot-").FullName;
        using var overlay = new AvatarOverlayForm(root);
        using var chat = new ChatView();
        using var player = new AudioPlayer();
        var voice = new VoiceLoop(null, client, player, overlay, chat, chat);
        using var artifacts = new ArtifactViewerForm();
        using var form = new SessionListForm(client, voice, chat, overlay, new BackendLogBuffer(), artifacts)
        {
            StartPosition = FormStartPosition.Manual,
            Location = new Point(-8000, 40), // off every screen: nothing flashes up while it renders
            Size = new Size(width, 720),
            ShowInTaskbar = false,
        };
        SessionListForm.OpenWithoutActivation = true;
        chat.AppendUserMessage("Is the table page under 50 ms yet?");
        chat.AppendManaMessage("Not yet~ It's 56 to 64 ms in the published host. The rounded frame gets clipped three times a frame, so I'm reusing the first clip:\n\n```csharp\nif (_lastRoundedClip is { } last && last.Key.Equals(key))\n    return; // reuse the mask\n```");
        chat.AppendUserMessage("Nice. Pixels still identical?");
        chat.AppendManaMessage("Every one! The render suite still passes, 864 of 864.");
        form.Show();
        var refresh = form.RefreshAsync(); // the app does this once the backend is up
        var until = DateTime.UtcNow.AddSeconds(2.5);
        while (DateTime.UtcNow < until)
        {
            Application.DoEvents();
            Thread.Sleep(20);
        }
        using var bitmap = new Bitmap(form.Width, form.Height);
        using (var g = Graphics.FromImage(bitmap))
        {
            var hdc = g.GetHdc();
            PrintWindow(form.Handle, hdc, PwRenderFullContent);
            g.ReleaseHdc(hdc);
        }
        bitmap.Save(path);
        form.Close();
    }

    private const uint PwRenderFullContent = 2;

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    private static HttpResponseMessage Json(string text) => new(HttpStatusCode.OK) { Content = new StringContent(text, Encoding.UTF8, "application/json") };

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
