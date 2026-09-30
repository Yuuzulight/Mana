using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using NAudio.Wave;

namespace Mana.NativeLauncher;

// #1112: "Record training lines" from Settings > Voice -- a TrainingSession
// in a window, over the single-line script or the conversations with Mana,
// whose replies she says through the backend's /synthesize (just the caption
// if TTS isn't there). Settings pauses listening while it's open.
internal sealed class TrainingLinesForm : Form
{
    private readonly ManaBackendClient backendClient;
    private readonly MicRecorder recorder = new();
    private readonly AudioPlayer player = new();
    private readonly ComboBox mode = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 240 };
    private readonly Label heading = new() { AutoSize = true, ForeColor = DarkTheme.Muted };
    private readonly Label line = new() { Dock = DockStyle.Fill, ForeColor = DarkTheme.Text, Font = new Font("Segoe UI", 16f), TextAlign = ContentAlignment.MiddleLeft };
    private readonly Label caption = new() { Dock = DockStyle.Fill, ForeColor = DarkTheme.Accent, Font = new Font("Segoe UI", 11f), TextAlign = ContentAlignment.TopLeft };
    private readonly Label status = new() { AutoSize = true, ForeColor = DarkTheme.Muted };
    private readonly Button record = new() { AutoSize = true };
    private readonly Button play = new() { Text = "Play back", AutoSize = true };
    private readonly Button next = new() { AutoSize = true };
    private TrainingSession session = null!;
    private bool busy;

    public TrainingLinesForm(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;
        Text = "Record training lines";
        Width = 760;
        Height = 380;
        StartPosition = FormStartPosition.CenterParent;
        DarkTheme.ApplyForm(this);

        mode.BackColor = DarkTheme.Panel2;
        mode.ForeColor = DarkTheme.Text;
        mode.Items.AddRange(new object[] { "Single lines", "Conversations with Mana" });
        foreach (var button in new[] { record, play, next })
        {
            DarkTheme.ApplyButton(button);
        }

        var top = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, BackColor = DarkTheme.Background };
        top.Controls.Add(mode);
        top.Controls.Add(heading);
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, BackColor = DarkTheme.Background };
        buttons.Controls.Add(record);
        buttons.Controls.Add(play);
        buttons.Controls.Add(next);
        buttons.Controls.Add(status);
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(12), BackColor = DarkTheme.Background };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 60));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 40));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(top);
        layout.Controls.Add(line);
        layout.Controls.Add(caption);
        layout.Controls.Add(buttons);
        Controls.Add(layout);

        mode.SelectedIndexChanged += (_, _) => StartSession();
        record.Click += async (_, _) => await ToggleAsync();
        play.Click += async (_, _) => await PlayTakeAsync();
        next.Click += (_, _) =>
        {
            session.Next();
            caption.Text = "";
            ShowState();
        };
        mode.SelectedIndex = 0;
    }

    // Space records and stops, wherever the focus is.
    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == Keys.Space)
        {
            _ = ToggleAsync();
            return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    private void StartSession()
    {
        var conversations = mode.SelectedIndex == 1;
        var script = Path.Combine(ManaApplicationContext.FindRootDirectory(), "windows-native-launcher", "assets", "voice-data",
            conversations ? "conversations.json" : "lines.json");
        caption.Text = "";
        try
        {
            var prompts = conversations ? TrainingSession.LoadConversations(script) : TrainingSession.LoadLines(script);
            session = new TrainingSession(VoiceData.Folder(conversations ? "conversations" : "readings"), prompts, recorder, SayReplyAsync);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            session = new TrainingSession(VoiceData.Folder("readings"), Array.Empty<TrainingPrompt>(), recorder, SayReplyAsync);
            ShowState();
            status.Text = $"Couldn't read the script {script}: {ex.Message}";
            return;
        }
        ShowState();
    }

    private async Task ToggleAsync()
    {
        if (busy)
        {
            return;
        }
        busy = true;
        player.Stop(); // not while a take plays back
        string? error = null;
        try
        {
            var toggle = session.ToggleRecordingAsync();
            ShowState();
            await toggle;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            error = $"Couldn't record: {ex.Message}";
        }
        finally
        {
            busy = false;
        }
        ShowState();
        if (error is not null && !IsDisposed)
        {
            status.Text = error;
        }
    }

    // Her scripted answer: said aloud when the backend's TTS works, always
    // shown as the caption.
    private async Task SayReplyAsync(string text)
    {
        caption.Text = "Mana: " + text;
        ShowState();
        try
        {
            await player.PlayAsync(await backendClient.SynthesizeAsync(text));
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            Console.WriteLine($"TrainingLinesForm: couldn't say Mana's line, showing it only. {ex.Message}");
        }
    }

    private async Task PlayTakeAsync()
    {
        if (session.TakePath is not { } take || session.State != TrainingSession.Step.Ready)
        {
            return;
        }
        try
        {
            await player.PlayAsync(await File.ReadAllBytesAsync(take));
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            status.Text = $"Couldn't play it back: {ex.Message}";
        }
    }

    private void ShowState()
    {
        if (IsDisposed)
        {
            return;
        }
        var prompt = session.Current;
        var state = session.State;
        var (done, total, minutes) = session.Totals();
        heading.Text = prompt is null ? ""
            : prompt.ConversationId is null ? $"Line {session.Index + 1} of {total}"
            : $"{prompt.Title}: turn {prompt.Turn} of {prompt.Turns}";
        line.Text = prompt?.Text ?? "That's the whole script. Thank you!";
        record.Text = state == TrainingSession.Step.Recording ? "Stop (Space)" : session.TakePath is null ? "Record (Space)" : "Record again (Space)";
        var ready = state == TrainingSession.Step.Ready;
        record.Enabled = prompt is not null && state != TrainingSession.Step.Replying;
        play.Enabled = ready && session.TakePath is not null;
        next.Enabled = ready && prompt is not null;
        mode.Enabled = ready;
        next.Text = session.TakePath is null ? "Skip" : "Next";
        status.Text = session.Problem
            ?? (state == TrainingSession.Step.Recording ? "Recording... press Space when you're done."
            : state == TrainingSession.Step.Replying ? "Mana is answering..."
            : $"{done} of {total} recorded, {minutes:F1} min");
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);
        player.Stop();
        recorder.Dispose(); // a take still recording is dropped
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            player.Dispose();
            recorder.Dispose();
        }
        base.Dispose(disposing);
    }
}

// The default mic, 16 kHz mono like listening's segments, from Start to StopAsync.
internal sealed class MicRecorder : ITrainingRecorder, IDisposable
{
    private readonly List<short> samples = new();
    private WaveInEvent? waveIn;
    private TaskCompletionSource? stopped;

    public void Start()
    {
        lock (samples)
        {
            samples.Clear();
        }
        var mic = new WaveInEvent { DeviceNumber = -1, WaveFormat = new WaveFormat(SileroVadRunner.SampleRate, 16, 1) };
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        mic.DataAvailable += (_, e) =>
        {
            lock (samples)
            {
                for (var i = 0; i + 1 < e.BytesRecorded; i += 2)
                {
                    samples.Add(BitConverter.ToInt16(e.Buffer, i));
                }
            }
        };
        mic.RecordingStopped += (_, e) =>
        {
            if (e.Exception is { } ex)
            {
                done.TrySetException(ex);
            }
            else
            {
                done.TrySetResult();
            }
        };
        try
        {
            mic.StartRecording();
        }
        catch
        {
            mic.Dispose();
            throw;
        }
        waveIn = mic;
        stopped = done;
    }

    public async Task<short[]> StopAsync()
    {
        if (waveIn is not { } mic)
        {
            return Array.Empty<short>();
        }
        waveIn = null;
        mic.StopRecording();
        try
        {
            await stopped!.Task;
        }
        finally
        {
            mic.Dispose();
        }
        lock (samples)
        {
            return samples.ToArray();
        }
    }

    public void Dispose()
    {
        var mic = waveIn;
        waveIn = null;
        mic?.StopRecording();
        mic?.Dispose();
    }
}
