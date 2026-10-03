using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher.Dictation;

// #849: orchestrates dictate-anywhere flow:
// 1. Tracks hold-to-talk key via low-level hook.
// 2. Records microphone audio while held and pauses VoiceLoop.
// 3. On release, transcribes with Whisper, cleans text, and types into focused app.
internal sealed class DictationService : IDisposable
{
    private readonly ManaBackendClient backendClient;
    private readonly Func<VoiceLoop?> getVoiceLoop;
    private readonly HoldToTalkStateMachine stateMachine;
    private readonly LowLevelKeyboardHook keyboardHook;
    private readonly DictationAudioRecorder recorder;
    private readonly DictationIndicatorForm indicatorForm;
    private readonly System.Windows.Forms.Timer stateTickTimer;

    private IDisposable? voiceLoopPauseToken;
    private bool isEnabled;
    private bool disposed;

    public bool IsEnabled
    {
        get => isEnabled;
        set
        {
            if (isEnabled == value)
            {
                return;
            }
            isEnabled = value;
            if (isEnabled)
            {
                keyboardHook.Start();
                stateTickTimer.Start();
            }
            else
            {
                keyboardHook.Stop();
                stateTickTimer.Stop();
                stateMachine.Cancel();
            }
        }
    }

    public HoldToTalkStateMachine StateMachine => stateMachine;

    public DictationService(ManaBackendClient backendClient, Func<VoiceLoop?> getVoiceLoop)
    {
        this.backendClient = backendClient;
        this.getVoiceLoop = getVoiceLoop;

        stateMachine = new HoldToTalkStateMachine();
        keyboardHook = new LowLevelKeyboardHook();
        recorder = new DictationAudioRecorder();
        indicatorForm = new DictationIndicatorForm();

        keyboardHook.KeyDown += stateMachine.OnKeyDown;
        keyboardHook.KeyUp += stateMachine.OnKeyUp;

        stateMachine.HoldStarted += OnHoldStarted;
        stateMachine.HoldReleased += OnHoldReleased;
        stateMachine.HoldCanceled += OnHoldCanceled;

        stateTickTimer = new System.Windows.Forms.Timer { Interval = 25 };
        stateTickTimer.Tick += (_, _) => stateMachine.OnTick();
    }

    private void OnHoldStarted()
    {
        try
        {
            // 1. Pause active voice loop so speech isn't also heard as a conversational command
            var loop = getVoiceLoop();
            voiceLoopPauseToken = loop?.PauseForDictation();

            // 2. Begin recording audio from microphone
            recorder.Start();

            // 3. Show floating listening indicator
            indicatorForm.ShowListening();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"DictationService: error on hold start: {ex.Message}");
            stateMachine.Cancel();
        }
    }

    private void OnHoldCanceled()
    {
        try
        {
            recorder.Stop();
            indicatorForm.HideIndicator();
            voiceLoopPauseToken?.Dispose();
            voiceLoopPauseToken = null;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"DictationService: error on hold cancel: {ex.Message}");
        }
    }

    private void OnHoldReleased(long holdDurationMs)
    {
        indicatorForm.ShowTranscribing();

        _ = Task.Run(async () =>
        {
            byte[] wavBytes;
            try
            {
                wavBytes = recorder.Stop();
            }
            finally
            {
                voiceLoopPauseToken?.Dispose();
                voiceLoopPauseToken = null;
            }

            // Minimum speech duration: ignore very short clicks (< 250ms)
            if (wavBytes.Length < 16000 * 2 * 0.25)
            {
                indicatorForm.BeginInvoke(indicatorForm.HideIndicator);
                stateMachine.OnTranscriptionCompleted();
                return;
            }

            try
            {
                // 1. Transcribe audio with Whisper
                var (transcript, _, _, _) = await backendClient.TranscribeAsync(wavBytes);
                var cleaned = DictationCleaner.Clean(transcript);

                if (string.IsNullOrWhiteSpace(cleaned))
                {
                    indicatorForm.BeginInvoke(indicatorForm.HideIndicator);
                    stateMachine.OnTranscriptionCompleted();
                    return;
                }

                // 2. Inspect target focused window
                var (isPassword, _) = await ForeignWindow.ReadFocusedAsync();
                var hwnd = ForeignWindow.Foreground();

                if (isPassword)
                {
                    indicatorForm.BeginInvoke(() => indicatorForm.ShowMessage("⚠️ Cannot dictate into password fields", isWarning: true));
                    stateMachine.OnTranscriptionCompleted();
                    return;
                }

                if (ForeignWindow.IsElevatedAboveUs(hwnd))
                {
                    // Elevated target: can't SendInput due to UIPI; leave on clipboard as fallback
                    Clipboard.SetText(cleaned);
                    indicatorForm.BeginInvoke(() => indicatorForm.ShowMessage("⚠️ Admin window: text copied to clipboard", isWarning: true));
                    stateMachine.OnTranscriptionCompleted();
                    return;
                }

                // 3. Type into focused app
                indicatorForm.BeginInvoke(indicatorForm.HideIndicator);

                if (cleaned.Length <= 20)
                {
                    ForeignWindow.SendTextUnicode(cleaned);
                }
                else
                {
                    await ForeignWindow.PasteAsync(cleaned);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"DictationService: transcription/typing failed: {ex.Message}");
                indicatorForm.BeginInvoke(() => indicatorForm.ShowMessage($"Error: {ex.Message}", isWarning: true));
            }
            finally
            {
                stateMachine.OnTranscriptionCompleted();
            }
        });
    }

    public void Dispose()
    {
        if (!disposed)
        {
            IsEnabled = false;
            keyboardHook.Dispose();
            recorder.Dispose();
            indicatorForm.Dispose();
            stateTickTimer.Dispose();
            voiceLoopPauseToken?.Dispose();
            disposed = true;
        }
    }
}
