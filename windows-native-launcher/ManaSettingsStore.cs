using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mana.NativeLauncher;

// #565: launcher-level connection preferences (which node-bot to talk to,
// and the admin bearer token to send it) -- kept in a small per-user JSON
// file rather than threaded through every constructor that needs one,
// since nothing here has live state to keep in sync: every consumer
// (ManaBackendClient, TrayNotificationClient) reads it once at startup,
// and the Settings UI just reads/writes the same file directly. A
// missing or corrupt file degrades to defaults instead of failing
// construction -- this is a "nice to have" override, not a required config.
internal sealed class ManaSettingsStore
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Mana",
        "native-launcher-settings.json");

    public string BackendBaseUrl { get; set; } = "http://127.0.0.1:5005";

    // #645 (Q19): the admin token is stored encrypted with Windows DPAPI
    // (CurrentUser scope: only this Windows account can read it) as
    // AdminTokenProtected. An older file's plain "AdminToken" is read once
    // and moved into the encrypted field on the next load. If DPAPI isn't
    // available, Save falls back to the plain field so the token isn't lost.
    [JsonIgnore]
    public string? AdminToken { get; set; }

    [JsonPropertyName("AdminToken")]
    public string? PlainAdminToken { get; set; }

    public string? AdminTokenProtected { get; set; }

    private static readonly byte[] AdminTokenEntropy = Encoding.UTF8.GetBytes("Mana.NativeLauncher.AdminToken");

    // #342/#682: acoustic wake-word pre-filter -- "off" (null, default),
    // "loose" or "normal", chosen in Settings > Voice; see
    // WakeWordClassifier.ResolveThreshold. Replaces the old
    // WakeWordConfidenceThreshold (0.9), which a saved file may still
    // hold and is now ignored, so existing installs get the new default.
    public string? WakePrefilter { get; set; }

    // #619: echo cancellation on the microphone (EchoCancellation); null =
    // default (on). Settings > Voice; MANA_VOICE_AEC overrides it.
    public bool? EchoCancellation { get; set; }

    // #858: Settings > Voice; null = default. MANA_SILENCE_BUFFER_MS and
    // MANA_VAD_THRESHOLD override them (RecordingSegmenter/SileroVadRunner
    // .Resolve*). Read each time listening starts.
    public long? SilenceBufferMs { get; set; }
    public float? VadThreshold { get; set; }

    // #670: local-only mode for the node-bot this launcher starts (passed
    // as MANA_LAUNCHER_LOCAL_ONLY=1). Settings > Connection; applies on the
    // next start. MANA_LOCAL_ONLY=1 in node-bot/.env turns it on regardless.
    public bool LocalOnly { get; set; }

    // Part of #700: no gentle check-ins from Mana (passed as
    // MANA_LAUNCHER_CHECK_INS=0). Settings > Briefing; applies on the next
    // start. MANA_CHECK_INS=0 in node-bot/.env turns them off regardless.
    public bool NoCheckIns { get; set; }

    // #665: what talking over Mana does (BargeInMode: "minWords" -- the
    // default when null -- "always" or "notWhileSpeaking"). Settings >
    // Voice; MANA_BARGE_IN_MODE overrides it.
    public string? BargeInMode { get; set; }

    // #678: SpeakerGate.ModeNames (null = off) and my enrolled voiceprint,
    // an averaged speaker embedding. Stays in this local file, never uploaded.
    // #922: DPAPI-encrypted like the admin token (VoiceprintProtected); one
    // this account can't decrypt counts as not enrolled.
    public string? VoiceprintGate { get; set; }

    [JsonIgnore]
    public float[]? Voiceprint { get; set; }

    [JsonPropertyName("Voiceprint")]
    public float[]? PlainVoiceprint { get; set; }

    public string? VoiceprintProtected { get; set; }

    // #965: Settings > Voice; null = SpeakerGate.DefaultThreshold.
    // MANA_SPEAKER_THRESHOLD overrides it. Read each time listening starts.
    public float? SpeakerThreshold { get; set; }

    private static readonly byte[] VoiceprintEntropy = Encoding.UTF8.GetBytes("Mana.NativeLauncher.Voiceprint");

    // #681: the prompt preset sent as presetId with every reply; null =
    // none. Chosen in Settings > Presets (windows-launcher kept the same
    // choice in localStorage's manaSelectedPresetId).
    public string? ActivePresetId { get; set; }

    // #662: the avatar overlay -- fully click-through (the pre-#662
    // behaviour, for gaming/streaming; tray menu), and where she was last
    // dragged to (screen coordinates; null = the default spot).
    public bool AvatarClickThrough { get; set; }
    public int? AvatarLeft { get; set; }
    public int? AvatarTop { get; set; }

    // #689: Settings > Hotkeys -- action key (HotkeyBindings.Actions) to a
    // combination like "Ctrl+Alt+Shift+W", "" = off; a missing key uses the default.
    public Dictionary<string, string>? Hotkeys { get; set; }

    // #701: Mana's spoken sentences as bubbles beside the avatar while the
    // chat window isn't in view (tray menu); off by default.
    public bool ChatBubbles { get; set; }

    // The caption bar under the avatar (tray menu), independent of the
    // bubbles. Null = saved before this toggle, when bubbles on meant no
    // captions (#701), so CaptionsShown keeps that until it's changed.
    public bool? Captions { get; set; }
    public bool CaptionsShown() => Captions ?? !ChatBubbles;

    // #849: hold a key to dictate anywhere and type cleaned transcript into focused window
    public bool DictateAnywhere { get; set; }
    public string? DictateKey { get; set; }
    public int? DictateHoldThresholdMs { get; set; }

    // #684: Electron's "minimized Mana" -- the avatar steps aside while the
    // chat window is open and comes back when it's closed or minimized.
    // Off keeps her always showing. Tray menu.
    public bool AvatarHidesWithChat { get; set; } = true;

    // The tray's Show avatar: off keeps the overlay hidden.
    public bool ShowAvatar { get; set; } = true;

    // #574/#688: gaming-mode detection (tray menu and Settings >
    // Performance); off ignores the backend's watched-game scan.
    public bool GamingModeDetection { get; set; } = true;

    // #697: hold speech during calls or media playback (another app using audio/mic);
    // on by default. When active, remarks show as toasts and spoken version waits.
    public bool HoldSpeechDuringAudio { get; set; } = true;

    // #912: Settings > Voice's camera toggle; off by default.
    public bool CameraSnapshots { get; set; }

    // #1107: Settings > Voice's "Keep my voice clips for training" (VoiceData);
    // off by default. Read at each turn, so switching it off stops at once.
    public bool KeepVoiceClips { get; set; }

    // #962: where "save that" puts a camera snapshot; null = Pictures\Mana.
    public string? CameraSnapshotFolder { get; set; }

    // #911: the folders Mana may move and rename files in (full paths);
    // null = Desktop, Downloads, Pictures and Documents, empty = none.
    // Settings > Desktop (#997) edits it; read again on every move.
    public List<string>? DesktopActionFolders { get; set; }

    // #685: the chat window's live avatar framing -- "full", "waist" or
    // "bust" (see LiveAvatarPanel); null = full.
    public string? AvatarFraming { get; set; }

    // #899: the overlay's framing ("full", "upperHalf" or "bust") and size
    // (AvatarOverlayForm.OverlayScales); null = the defaults. Tray menu.
    public string? OverlayFraming { get; set; }
    public float? OverlayScale { get; set; }

    // #687: the chat session open when the launcher last ran, reopened on
    // launch, and whether it was auto-started (Q62: those still rotate).
    public string? LastSessionId { get; set; }
    public bool LastSessionAuto { get; set; }

    // #1118: the chat window's tool panel -- the open rail tool (null =
    // closed), whether it's pinned (a pinned one reopens on launch), and
    // its width. See ToolPanelHost.
    public string? RailTool { get; set; }
    public bool RailToolPinned { get; set; }
    public int? RailToolWidth { get; set; }

    // #1426: the Settings window -- where it was ("x,y,width,height") and
    // the group last open. See SettingsDialog.
    public string? SettingsWindowBounds { get; set; }
    public string? SettingsGroup { get; set; }

    // filePath: null (every real call site) uses the real per-user
    // settings file. Tests pass a temp file path to exercise
    // load/save/corruption handling without touching LocalApplicationData.
    public static ManaSettingsStore Load(string? filePath = null)
    {
        ManaSettingsStore settings;
        try
        {
            var json = File.ReadAllText(filePath ?? FilePath);
            settings = JsonSerializer.Deserialize<ManaSettingsStore>(json) ?? new ManaSettingsStore();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return new ManaSettingsStore();
        }

        settings.AdminToken = Unprotect(settings.AdminTokenProtected, AdminTokenEntropy, "admin token") is { } token
            ? Encoding.UTF8.GetString(token)
            : settings.PlainAdminToken;
        settings.Voiceprint = Unprotect(settings.VoiceprintProtected, VoiceprintEntropy, "voiceprint") is { } voiceprint
            ? MemoryMarshal.Cast<byte, float>(voiceprint).ToArray()
            : settings.PlainVoiceprint;
        if ((settings.AdminTokenProtected is null && settings.PlainAdminToken is not null)
            || (settings.VoiceprintProtected is null && settings.PlainVoiceprint is not null))
        {
            // First run after the upgrade: move the plain values into DPAPI.
            try
            {
                settings.Save(filePath);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Console.WriteLine($"ManaSettingsStore: couldn't encrypt the saved settings yet. {ex.Message}");
            }
        }
        return settings;
    }

    public void Save(string? filePath = null)
    {
        // Fallback: better a plain value than none (the pre-#645/#922 format).
        AdminTokenProtected = AdminToken is null ? null : Protect(Encoding.UTF8.GetBytes(AdminToken), AdminTokenEntropy, "admin token");
        PlainAdminToken = AdminTokenProtected is null ? AdminToken : null;
        VoiceprintProtected = Voiceprint is null ? null : Protect(MemoryMarshal.AsBytes(Voiceprint.AsSpan()).ToArray(), VoiceprintEntropy, "voiceprint");
        PlainVoiceprint = VoiceprintProtected is null ? Voiceprint : null;
        var path = filePath ?? FilePath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(this));
    }

    // Another Windows account's (or a damaged) blob gives null: the value
    // has to be entered (or taught) again in Settings.
    private static byte[]? Unprotect(string? blob, byte[] entropy, string what)
    {
        if (blob is null)
        {
            return null;
        }
        try
        {
            return ProtectedData.Unprotect(Convert.FromBase64String(blob), entropy, DataProtectionScope.CurrentUser);
        }
        catch (Exception ex) when (ex is CryptographicException or FormatException or PlatformNotSupportedException)
        {
            Console.WriteLine($"ManaSettingsStore: couldn't decrypt the {what}. {ex.Message}");
            return null;
        }
    }

    // null when DPAPI isn't available; Save then keeps the plain value.
    private static string? Protect(byte[] data, byte[] entropy, string what)
    {
        try
        {
            return Convert.ToBase64String(ProtectedData.Protect(data, entropy, DataProtectionScope.CurrentUser));
        }
        catch (Exception ex) when (ex is CryptographicException or PlatformNotSupportedException)
        {
            Console.WriteLine($"ManaSettingsStore: DPAPI unavailable, saving the {what} unencrypted. {ex.Message}");
            return null;
        }
    }
}
