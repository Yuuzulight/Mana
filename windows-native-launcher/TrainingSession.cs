using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

// #1112: one thing for me to read aloud in "Record training lines" -- a
// script line, or my turn in a scripted conversation, with Mana's Reply
// after it. Name is the take's file name (without .wav/.json).
internal sealed record TrainingPrompt(string Name, string Text, string? Reply = null, string? ConversationId = null, string? Title = null, int? Turn = null, int? Turns = null);

// Start/stop recording from the mic; 16 kHz mono like listening's segments.
internal interface ITrainingRecorder
{
    void Start();
    Task<short[]> StopAsync();
}

// #1112: the reading session: record (Space or the button) and stop, which
// saves the take as <folder>\<Name>.wav + .json (VoiceData.ReadingClip, the
// script text as ground truth) -- recording again replaces it -- then Mana
// says her scripted Reply, if there is one, after the first take. Next moves
// on, recorded or not, and where I am is kept in progress.json so the next
// session picks up there.
internal sealed class TrainingSession
{
    public enum Step { Ready, Recording, Replying }

    private readonly string folder;
    private readonly IReadOnlyList<TrainingPrompt> prompts;
    private readonly ITrainingRecorder recorder;
    private readonly Func<string, Task> reply;

    public TrainingSession(string folder, IReadOnlyList<TrainingPrompt> prompts, ITrainingRecorder recorder, Func<string, Task> reply)
    {
        this.folder = folder;
        this.prompts = prompts;
        this.recorder = recorder;
        this.reply = reply;
        try
        {
            Index = Math.Clamp(JsonSerializer.Deserialize<Progress>(File.ReadAllText(ProgressPath))?.Next ?? 0, 0, prompts.Count);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            Index = 0; // nothing saved yet (or unreadable): from the top
        }
    }

    private sealed record Progress(int Next);

    private string ProgressPath => Path.Combine(folder, "progress.json");

    public int Index { get; private set; }

    public Step State { get; private set; }

    // What went wrong last (a take not kept, my place not saved), or null.
    public string? Problem { get; private set; }

    // null once every prompt is behind me.
    public TrainingPrompt? Current => Index < prompts.Count ? prompts[Index] : null;

    public string? TakePath => Current is { } prompt && File.Exists(WavPath(prompt)) ? WavPath(prompt) : null;

    private string WavPath(TrainingPrompt prompt) => Path.Combine(folder, prompt.Name + ".wav");

    // Prompts with a take, out of all of them, and the minutes recorded.
    public (int Done, int Total, double Minutes) Totals() =>
        (prompts.Count(p => File.Exists(WavPath(p))), prompts.Count, VoiceData.Totals(folder).Minutes);

    // Record, or stop and keep the take. Ignored while Mana is replying.
    public async Task ToggleRecordingAsync()
    {
        if (State == Step.Replying || Current is not { } prompt)
        {
            return;
        }
        if (State == Step.Ready)
        {
            Problem = null;
            recorder.Start();
            State = Step.Recording;
            return;
        }

        short[] samples;
        try
        {
            samples = await recorder.StopAsync();
        }
        finally
        {
            State = Step.Ready;
        }
        var (boosted, _) = SpeechFilters.ApplySpeechGain(samples, SpeechFilters.GainTargetPeak, SpeechFilters.GainMaxBoost);
        if (SpeechFilters.GetSpeechRejectReason(boosted, SpeechFilters.MinSpeechRms, SpeechFilters.MinSpeechPeak, SpeechFilters.MaxClickyZcr) is { } reason)
        {
            Problem = $"I couldn't hear that clearly ({reason}), so it wasn't kept. Check the mic and try again.";
            return;
        }
        var firstTake = TakePath is null;
        VoiceData.Save(folder, prompt.Name, samples, new VoiceData.ReadingClip(prompt.Text, prompt.ConversationId, prompt.Turn,
            Math.Round(samples.Length / (double)SileroVadRunner.SampleRate, 2), DateTimeOffset.Now));
        if (prompt.Reply is { } line && firstTake)
        {
            State = Step.Replying;
            try
            {
                await reply(line);
            }
            finally
            {
                State = Step.Ready;
            }
        }
    }

    // On to the next prompt, recorded or skipped. Not while recording or replying.
    public void Next()
    {
        if (State != Step.Ready || Current is null)
        {
            return;
        }
        Index++;
        Problem = null;
        try
        {
            Directory.CreateDirectory(folder);
            File.WriteAllText(ProgressPath, JsonSerializer.Serialize(new Progress(Index)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Problem = $"Couldn't save my place ({ex.Message}), so next time starts from an earlier line.";
        }
    }

    // The built-in scripts (windows-native-launcher\assets\voice-data): lines.json
    // is a list of sentences, conversations.json a list of
    // { id, title, turns: [{ me, mana }] }. Adding to either is fine; the
    // take names come from positions and ids, so change existing entries only
    // by adding new ones after them.
    public static IReadOnlyList<TrainingPrompt> LoadLines(string path) =>
        JsonSerializer.Deserialize<string[]>(File.ReadAllText(path))!
            .Select((text, i) => new TrainingPrompt($"line-{i + 1:000}", text))
            .ToList();

    public static IReadOnlyList<TrainingPrompt> LoadConversations(string path) =>
        JsonSerializer.Deserialize<Conversation[]>(File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!
            .SelectMany(c => c.Turns.Select((t, i) => new TrainingPrompt($"{c.Id}-{i + 1:00}", t.Me, t.Mana, c.Id, c.Title, i + 1, c.Turns.Length)))
            .ToList();

    private sealed record Conversation(string Id, string Title, ConversationTurn[] Turns);

    private sealed record ConversationTurn(string Me, string? Mana);
}
