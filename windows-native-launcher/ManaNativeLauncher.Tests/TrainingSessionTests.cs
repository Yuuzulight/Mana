using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1112: "Record training lines" -- the session's record/save/reply/next
// steps and resume, with a fake recorder and a fake Mana; plus the built-in
// scripts. Temp folders only; no mic, no TTS.
public sealed class TrainingSessionTests : IDisposable
{
    private readonly string folder = Directory.CreateTempSubdirectory("mana-training-").FullName;
    private readonly FakeRecorder recorder = new();
    private readonly List<string> said = new();

    public void Dispose() => Directory.Delete(folder, true);

    private sealed class FakeRecorder : ITrainingRecorder
    {
        public short[] Take = Speech();
        public int Starts;

        public void Start() => Starts++;

        public Task<short[]> StopAsync() => Task.FromResult(Take);
    }

    // A second of a loud-enough 220 Hz tone passes the speech filters.
    private static short[] Speech() =>
        Enumerable.Range(0, 16000).Select(i => (short)(0.3 * short.MaxValue * Math.Sin(2 * Math.PI * 220 * i / 16000))).ToArray();

    private static readonly TrainingPrompt[] Lines = { new("line-001", "Mana, wake up."), new("line-002", "What's on my calendar?") };

    private TrainingSession Session(IReadOnlyList<TrainingPrompt>? prompts = null, Func<string, Task>? reply = null) =>
        new(folder, prompts ?? Lines, recorder, reply ?? (text => { said.Add(text); return Task.CompletedTask; }));

    private JsonElement Sidecar(string name) => JsonDocument.Parse(File.ReadAllText(Path.Combine(folder, name + ".json"))).RootElement;

    [Fact]
    public async Task RecordsATakeWithTheScriptAsGroundTruth_ThenMovesOnAndResumesThere()
    {
        var session = Session();
        Assert.Equal("line-001", session.Current!.Name);

        await session.ToggleRecordingAsync();
        Assert.Equal(TrainingSession.Step.Recording, session.State);
        await session.ToggleRecordingAsync();

        Assert.Equal(TrainingSession.Step.Ready, session.State);
        Assert.Equal(Path.Combine(folder, "line-001.wav"), session.TakePath);
        var sidecar = Sidecar("line-001");
        Assert.Equal("Mana, wake up.", sidecar.GetProperty("text").GetString());
        Assert.Equal(1, sidecar.GetProperty("durationSec").GetDouble());
        Assert.True(sidecar.TryGetProperty("recordedAt", out _));
        Assert.False(sidecar.TryGetProperty("conversationId", out _));
        var (done, total, minutes) = session.Totals();
        Assert.Equal((1, 2), (done, total));
        Assert.Equal(1 / 60.0, minutes, 4);

        session.Next();
        Assert.Equal("line-002", session.Current!.Name);
        Assert.Null(session.TakePath);

        // A new session (the window opened again) picks up where I left off.
        Assert.Equal(1, Session().Index);
    }

    [Fact]
    public async Task AQuietTakeIsNotKept()
    {
        var session = Session();
        recorder.Take = new short[16000];

        await session.ToggleRecordingAsync();
        await session.ToggleRecordingAsync();

        Assert.Null(session.TakePath);
        Assert.Contains("couldn't hear", session.Problem);
        Assert.Equal(TrainingSession.Step.Ready, session.State);
        Assert.Empty(Directory.GetFiles(folder));
    }

    [Fact]
    public async Task RecordingAgainReplacesTheTake()
    {
        var session = Session();
        await session.ToggleRecordingAsync();
        await session.ToggleRecordingAsync();
        recorder.Take = Speech().Concat(Speech()).ToArray();

        await session.ToggleRecordingAsync();
        await session.ToggleRecordingAsync();

        Assert.Equal(new[] { "line-001.json", "line-001.wav" }, Directory.GetFiles(folder).Select(Path.GetFileName).Order());
        Assert.Equal(2, Sidecar("line-001").GetProperty("durationSec").GetDouble());
        Assert.Equal(1, session.Totals().Done);
    }

    [Fact]
    public async Task InAConversationManaAnswersAfterMyFirstTake_AndNothingElseHappensMeanwhile()
    {
        var turns = new[]
        {
            new TrainingPrompt("raid-night-01", "Raid starts soon.", "I'm up, Oneesan!", "raid-night", "FFXIV raid night", 1, 2),
            new TrainingPrompt("raid-night-02", "We cleared it!", "Congratulations!", "raid-night", "FFXIV raid night", 2, 2),
        };
        var speaking = new TaskCompletionSource();
        var session = Session(turns, text => { said.Add(text); return speaking.Task; });

        await session.ToggleRecordingAsync();
        var stop = session.ToggleRecordingAsync();

        Assert.Equal(TrainingSession.Step.Replying, session.State);
        Assert.Equal(new[] { "I'm up, Oneesan!" }, said);
        await session.ToggleRecordingAsync(); // ignored while she answers
        session.Next(); // likewise
        Assert.Equal(1, recorder.Starts);
        Assert.Equal(0, session.Index);

        speaking.SetResult();
        await stop;
        Assert.Equal(TrainingSession.Step.Ready, session.State);
        var sidecar = Sidecar("raid-night-01");
        Assert.Equal("Raid starts soon.", sidecar.GetProperty("text").GetString());
        Assert.Equal("raid-night", sidecar.GetProperty("conversationId").GetString());
        Assert.Equal(1, sidecar.GetProperty("turn").GetInt32());

        // A second take of the same turn: she doesn't answer again.
        await session.ToggleRecordingAsync();
        await session.ToggleRecordingAsync();
        Assert.Single(said);
    }

    [Fact]
    public void SkippingPastTheLastLineFinishesTheScript()
    {
        var session = Session();
        session.Next();
        session.Next();
        session.Next(); // nothing left to skip

        Assert.Null(session.Current);
        Assert.Equal(2, Session().Index);
    }

    [Fact]
    public void TheBuiltInScriptsLoad()
    {
        var assets = Path.Combine(ManaApplicationContext.FindRootDirectory(), "windows-native-launcher", "assets", "voice-data");

        var lines = TrainingSession.LoadLines(Path.Combine(assets, "lines.json"));
        Assert.InRange(lines.Count, 190, 400);
        Assert.All(lines, l => Assert.False(string.IsNullOrWhiteSpace(l.Text)));
        Assert.Equal(lines.Count, lines.Select(l => l.Text).Distinct().Count());
        Assert.Equal("line-001", lines[0].Name);

        var turns = TrainingSession.LoadConversations(Path.Combine(assets, "conversations.json"));
        var conversations = turns.GroupBy(t => t.ConversationId).ToList();
        Assert.InRange(conversations.Count, 6, 8);
        Assert.All(conversations, c => Assert.InRange(c.Count(), 8, 15));
        Assert.All(turns, t => Assert.False(string.IsNullOrWhiteSpace(t.Text) || string.IsNullOrWhiteSpace(t.Reply) || string.IsNullOrWhiteSpace(t.Title)));
        Assert.Equal(turns.Count, turns.Select(t => t.Name).Distinct().Count());
        Assert.Equal(("raid-night-01", 1, 12), (turns[0].Name, turns[0].Turn!.Value, turns[0].Turns!.Value));
    }
}

// #1112: the window over the real scripts, built on an STA thread and never
// shown; its takes folder is a temp one.
[Collection("DarkTheme palette")]
public sealed class TrainingLinesFormTests
{
    [Fact]
    public void OpensOnTheFirstLine_AndSwitchesToTheConversations()
    {
        var root = Directory.CreateTempSubdirectory("mana-training-form-").FullName;
        var saved = Environment.GetEnvironmentVariable("MANA_VOICE_DATA_DIR");
        Environment.SetEnvironmentVariable("MANA_VOICE_DATA_DIR", root);
        try
        {
            RunSta(() =>
            {
                using var form = new TrainingLinesForm(new ManaBackendClient());
                var texts = Texts(form);
                Assert.Contains("Line 1 of 198", texts);
                Assert.Contains("Mana, wake up, I need you for a bit.", texts);
                Assert.Contains("Record (Space)", texts);
                Assert.Contains("Skip", texts);

                form.Controls.OfType<Control>().SelectMany(Descendants).OfType<ComboBox>().Single().SelectedIndex = 1;
                texts = Texts(form);
                Assert.Contains("FFXIV raid night: turn 1 of 12", texts);
                Assert.Contains("Mana, wake up, raid starts in twenty minutes.", texts);
            });
        }
        finally
        {
            Environment.SetEnvironmentVariable("MANA_VOICE_DATA_DIR", saved);
            Directory.Delete(root, true);
        }
    }

    private static IEnumerable<Control> Descendants(Control control) => control.Controls.OfType<Control>().SelectMany(Descendants).Prepend(control);

    private static List<string> Texts(Form form) => form.Controls.OfType<Control>().SelectMany(Descendants).Select(c => c.Text).ToList();

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
