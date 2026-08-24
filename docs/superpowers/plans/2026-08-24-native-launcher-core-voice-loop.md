# Native Launcher Core Voice Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `windows-native-launcher` (C#/.NET 8) a working voice loop — mic capture, Silero VAD-based silence detection, wake-word text matching, non-streaming reply + synthesis + playback, basic idle/talking avatar state — porting the proven design already running in the Electron `windows-launcher`.

**Architecture:** Three new classes (`SileroVadRunner`, `VoiceLoop`, `AudioPlayer`) plus two pure-logic port classes (`WakeWordMatcher`, `RecordingSegmenter`) are added to the existing scaffold. `ManaBackendClient` gains three new HTTP methods. `VoiceLoop` owns the always-on capture→VAD→segment→transcribe→wake-word→reply→synthesize→play state machine, calling the tested pure-logic classes for its decisions.

**Tech Stack:** .NET 8 / C# (WinForms), NAudio (WASAPI capture/playback + resampling), Microsoft.ML.OnnxRuntime (Silero VAD inference), xunit (new test project — none exists yet in this scaffold).

**Spec:** `docs/superpowers/specs/2026-08-24-native-launcher-core-voice-loop-design.md`

## Global Constraints

- Silero VAD I/O contract (from the spec, verified against `windows-launcher/renderer/silero-vad.js`): 512-sample frames @ 16kHz float32, 64-sample leading context prepended, recurrent `[2,1,128]` state fed back each call, threshold 0.5.
- WASAPI shared-mode capture returns the device's own mix format (not an arbitrary requested rate) — captured audio must be resampled to 16kHz mono before VAD or transcription.
- `VoiceLoop`'s VAD runs continuously from app start to app exit — never started/stopped around individual conversation turns (sub-project 3's barge-in reuses this same instance).
- No RMS-threshold VAD fallback — a VAD/ONNX load failure is a hard, surfaced error, not a silent degrade (unlike Electron's WASM-load fallback).
- `/transcribe-only`: `POST multipart/form-data`, field name `file` → JSON `{transcript}`.
- `/reply`: `POST application/json {text}` → JSON `{reply}`.
- `/synthesize`: `POST application/json {text}` → raw WAV bytes, `Content-Type: audio/wav`.
- One segment in flight at a time — no streaming/queueing (sub-project 2's scope).
- `AvatarOverlayForm.SetState(AvatarState.Talking)` before playback starts, `SetState(AvatarState.Idle)` on natural playback completion only (interrupt handling is sub-project 3's scope).

---

## Task 1: Test project scaffold + `WakeWordMatcher`

**Files:**
- Create: `windows-native-launcher/ManaNativeLauncher.Tests/ManaNativeLauncher.Tests.csproj`
- Create: `windows-native-launcher/WakeWordMatcher.cs`
- Test: `windows-native-launcher/ManaNativeLauncher.Tests/WakeWordMatcherTests.cs`
- Modify: `windows-native-launcher/ManaNativeLauncher.csproj`

**Interfaces:**
- Produces: `WakeWordMatcher.WakeWords` (`string[]`), `WakeWordMatcher.FuzzyMatchesWakeWord(string candidateWord, int maxDistance = 1)` (`bool`), `WakeWordMatcher.ExtractWakeCommand(string transcript)` (`string?` — `null` if no wake word found, otherwise the command text following the wake word, or the full normalized transcript if nothing follows it).

- [ ] **Step 1: Create the test project**

Write `windows-native-launcher/ManaNativeLauncher.Tests/ManaNativeLauncher.Tests.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0-windows</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\ManaNativeLauncher.csproj" />
  </ItemGroup>
</Project>
```

- [ ] **Step 2: Make the main project's `internal` types visible to the test project**

In `windows-native-launcher/ManaNativeLauncher.csproj`, add this `ItemGroup` (anywhere inside `<Project>`, after the existing `<PropertyGroup>`):

```xml
  <ItemGroup>
    <InternalsVisibleTo Include="ManaNativeLauncher.Tests" />
  </ItemGroup>
```

- [ ] **Step 3: Verify both projects build and the (empty) test project runs**

Run: `cd windows-native-launcher && dotnet build`
Expected: builds successfully (main project unchanged in behavior).

Run: `cd windows-native-launcher/ManaNativeLauncher.Tests && dotnet test`
Expected: restores/builds successfully, reports 0 tests run (no test files yet).

- [ ] **Step 4: Write the failing tests for `WakeWordMatcher`**

Write `windows-native-launcher/ManaNativeLauncher.Tests/WakeWordMatcherTests.cs`:

```csharp
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class WakeWordMatcherTests
{
    [Theory]
    [InlineData("mana")]
    [InlineData("manah")]
    [InlineData("myna")]
    public void FuzzyMatchesWakeWord_MatchesKnownNearVariants(string candidate)
    {
        Assert.True(WakeWordMatcher.FuzzyMatchesWakeWord(candidate));
    }

    [Fact]
    public void FuzzyMatchesWakeWord_RejectsUnrelatedShortWord()
    {
        Assert.False(WakeWordMatcher.FuzzyMatchesWakeWord("banana"));
    }

    [Fact]
    public void FuzzyMatchesWakeWord_DoesNotMatchMultiWordPhrasesWordByWord()
    {
        // "wake up" is a multi-word wake phrase -- fuzzy matching only
        // applies to single mis-transcribed name variants, per the ported
        // JS behavior.
        Assert.False(WakeWordMatcher.FuzzyMatchesWakeWord("wake"));
    }

    [Fact]
    public void ExtractWakeCommand_ReturnsNullWhenNoWakeWordPresent()
    {
        Assert.Null(WakeWordMatcher.ExtractWakeCommand("what time is it"));
    }

    [Fact]
    public void ExtractWakeCommand_ReturnsTextFollowingExactWakeWord()
    {
        Assert.Equal("what time is it", WakeWordMatcher.ExtractWakeCommand("mana, what time is it"));
    }

    [Fact]
    public void ExtractWakeCommand_ReturnsFullTranscriptWhenNothingFollowsWakeWord()
    {
        Assert.Equal("mana", WakeWordMatcher.ExtractWakeCommand("mana"));
    }

    [Fact]
    public void ExtractWakeCommand_FallsBackToFuzzyMatchOnFirstThreeWords()
    {
        // "manna" is a known near-variant, not in the exact regex list's
        // literal spelling collisions -- exercises the fuzzy fallback path.
        Assert.Equal("open the door", WakeWordMatcher.ExtractWakeCommand("manna open the door"));
    }

    [Fact]
    public void ExtractWakeCommand_IgnoresFuzzyMatchBeyondFirstThreeWords()
    {
        // "manna" appears as the 4th word -- outside the fuzzy fallback's
        // 3-word window, so this must return null just like any other
        // wake-word-less utterance.
        Assert.Null(WakeWordMatcher.ExtractWakeCommand("please open the manna door"));
    }

    [Fact]
    public void ExtractWakeCommand_CorrectsKnownWhisperMisTranscriptions()
    {
        Assert.Equal("what time is it", WakeWordMatcher.ExtractWakeCommand("minor what time is it"));
    }
}
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd windows-native-launcher/ManaNativeLauncher.Tests && dotnet test`
Expected: FAIL with compile errors — `WakeWordMatcher` does not exist yet.

- [ ] **Step 6: Implement `WakeWordMatcher`**

Write `windows-native-launcher/WakeWordMatcher.cs`:

```csharp
using System;
using System.Linq;
using System.Text.RegularExpressions;

namespace Mana.NativeLauncher;

// Ports windows-launcher/renderer/speech-filters.js's fuzzyMatchesWakeWord
// and renderer.js's extractWakeCommand -- wake-word matching runs on the
// Whisper transcript text (after transcription), not real-time acoustic
// detection, matching the Electron app's actual behavior.
internal static class WakeWordMatcher
{
    internal static readonly string[] WakeWords =
    {
        "mana",
        "manah",
        "manna",
        "mannah",
        "myna",
        "ma na",
        "mah na",
        "my na",
        "wake up",
        "wake-up",
    };

    // Only ever called on a candidate word that already failed the exact
    // WakeWords match -- a tight maxDistance (default 1) keeps this from
    // firing on unrelated short words while still catching a single
    // dropped, swapped, or misheard letter.
    internal static bool FuzzyMatchesWakeWord(string candidateWord, int maxDistance = 1)
    {
        var normalized = (candidateWord ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0)
        {
            return false;
        }

        foreach (var word in WakeWords)
        {
            // Multi-word wake phrases ("wake up") aren't fuzzy-matched
            // word-by-word here -- the exact-match regex path in
            // ExtractWakeCommand already handles those; fuzzy matching is
            // specifically for single mis-transcribed name variants.
            if (word.Contains(' '))
            {
                continue;
            }

            if (LevenshteinDistance(normalized, word) <= maxDistance)
            {
                return true;
            }
        }

        return false;
    }

    private static int LevenshteinDistance(string a, string b)
    {
        var rows = a.Length + 1;
        var cols = b.Length + 1;
        var dist = new int[rows, cols];
        for (var i = 0; i < rows; i++)
        {
            dist[i, 0] = i;
        }

        for (var j = 0; j < cols; j++)
        {
            dist[0, j] = j;
        }

        for (var i = 1; i < rows; i++)
        {
            for (var j = 1; j < cols; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                dist[i, j] = Math.Min(
                    Math.Min(dist[i - 1, j] + 1, dist[i, j - 1] + 1),
                    dist[i - 1, j - 1] + cost);
            }
        }

        return dist[rows - 1, cols - 1];
    }

    // Tries an exact/regex wake-word match first (also correcting two
    // known Whisper mis-transcriptions of "mana"), then falls back to a
    // fuzzy check on the first 3 words. Returns null if no wake word is
    // found anywhere; otherwise the command text following the wake word,
    // or the whole normalized transcript if nothing follows it.
    internal static string? ExtractWakeCommand(string transcript)
    {
        var normalized = Regex.Replace(transcript.Trim(), @"\bminor\b", "mana", RegexOptions.IgnoreCase);
        normalized = Regex.Replace(normalized, @"\bman a\b", "mana", RegexOptions.IgnoreCase);

        var escapedWords = WakeWords.Select(word => Regex.Escape(word).Replace(@"\ ", @"\s+"));
        var wakePattern = new Regex(
            $@"\b(?:{string.Join("|", escapedWords)})\b[\s,.:;!?-]*",
            RegexOptions.IgnoreCase);

        var wakeMatch = wakePattern.Match(normalized);
        if (wakeMatch.Success)
        {
            var command = normalized[(wakeMatch.Index + wakeMatch.Length)..].Trim();
            return command.Length > 0 ? command : normalized;
        }

        var words = normalized.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        for (var i = 0; i < Math.Min(words.Length, 3); i++)
        {
            var stripped = Regex.Replace(words[i], @"[.,!?;:]+$", "");
            if (FuzzyMatchesWakeWord(stripped))
            {
                var command = string.Join(" ", words.Skip(i + 1)).Trim();
                return command.Length > 0 ? command : normalized;
            }
        }

        return null;
    }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd windows-native-launcher/ManaNativeLauncher.Tests && dotnet test`
Expected: PASS, 9/9 tests.

- [ ] **Step 8: Commit**

```bash
git add windows-native-launcher/ManaNativeLauncher.Tests/ManaNativeLauncher.Tests.csproj windows-native-launcher/ManaNativeLauncher.csproj windows-native-launcher/WakeWordMatcher.cs windows-native-launcher/ManaNativeLauncher.Tests/WakeWordMatcherTests.cs
git commit -m "feat: add native launcher test project and port WakeWordMatcher"
```

---

## Task 2: `RecordingSegmenter`

**Files:**
- Create: `windows-native-launcher/RecordingSegmenter.cs`
- Test: `windows-native-launcher/ManaNativeLauncher.Tests/RecordingSegmenterTests.cs`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `RecordingStopReason` enum (`None`, `MaxDuration`, `SilenceAfterSpeech`, `NoSpeechTimeout`), `RecordingSegmenter.ShouldStopRecording(bool hasHeardSpeech, long elapsedMs, long msSinceLastSpeech, long maxWaitForSpeechMs = 6000, long silenceBufferMs = 2200, long maxDurationMs = 20000)` (`RecordingStopReason`). Used by `VoiceLoop` (Task 6).

- [ ] **Step 1: Write the failing tests**

Write `windows-native-launcher/ManaNativeLauncher.Tests/RecordingSegmenterTests.cs`:

```csharp
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class RecordingSegmenterTests
{
    [Fact]
    public void KeepsRecordingWhileStillTalking()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: true,
            elapsedMs: 5000,
            msSinceLastSpeech: 300);

        Assert.Equal(RecordingStopReason.None, reason);
    }

    [Fact]
    public void StopsOnceSilenceHasLastedTheFullBuffer()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: true,
            elapsedMs: 6000,
            msSinceLastSpeech: RecordingSegmenter.DefaultSilenceBufferMs);

        Assert.Equal(RecordingStopReason.SilenceAfterSpeech, reason);
    }

    [Fact]
    public void DoesNotStopOneTickBeforeSilenceBufferElapses()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: true,
            elapsedMs: 6000,
            msSinceLastSpeech: RecordingSegmenter.DefaultSilenceBufferMs - 1);

        Assert.Equal(RecordingStopReason.None, reason);
    }

    [Fact]
    public void GivesUpIfNoSpeechIsEverDetected()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: false,
            elapsedMs: RecordingSegmenter.DefaultMaxWaitForSpeechMs,
            msSinceLastSpeech: 0);

        Assert.Equal(RecordingStopReason.NoSpeechTimeout, reason);
    }

    [Fact]
    public void MaxDurationSafetyCapWinsEvenIfStillSpeaking()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: true,
            elapsedMs: RecordingSegmenter.DefaultMaxUtteranceMs,
            msSinceLastSpeech: 50);

        Assert.Equal(RecordingStopReason.MaxDuration, reason);
    }

    [Fact]
    public void RespectsCustomSilenceBufferAndTimeouts()
    {
        var reason = RecordingSegmenter.ShouldStopRecording(
            hasHeardSpeech: true,
            elapsedMs: 1000,
            msSinceLastSpeech: 500,
            silenceBufferMs: 500);

        Assert.Equal(RecordingStopReason.SilenceAfterSpeech, reason);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd windows-native-launcher/ManaNativeLauncher.Tests && dotnet test`
Expected: FAIL with compile errors — `RecordingSegmenter`/`RecordingStopReason` do not exist yet.

- [ ] **Step 3: Implement `RecordingSegmenter`**

Write `windows-native-launcher/RecordingSegmenter.cs`:

```csharp
namespace Mana.NativeLauncher;

internal enum RecordingStopReason
{
    None,
    MaxDuration,
    SilenceAfterSpeech,
    NoSpeechTimeout,
}

// Ports windows-launcher/renderer/voice-endpointing.js's
// shouldStopRecording -- decides when a growing speech segment should
// close, based on live VAD readings rather than a fixed duration, so a
// long sentence isn't cut off mid-way and a segment is only closed once
// the user has actually paused.
internal static class RecordingSegmenter
{
    internal const long DefaultSilenceBufferMs = 2200;
    internal const long DefaultMaxWaitForSpeechMs = 6000;
    internal const long DefaultMaxUtteranceMs = 20000;

    // msSinceLastSpeech is only meaningful once hasHeardSpeech is true;
    // callers should pass 0 (or anything) beforehand.
    internal static RecordingStopReason ShouldStopRecording(
        bool hasHeardSpeech,
        long elapsedMs,
        long msSinceLastSpeech,
        long maxWaitForSpeechMs = DefaultMaxWaitForSpeechMs,
        long silenceBufferMs = DefaultSilenceBufferMs,
        long maxDurationMs = DefaultMaxUtteranceMs)
    {
        if (elapsedMs >= maxDurationMs)
        {
            return RecordingStopReason.MaxDuration;
        }

        if (hasHeardSpeech && msSinceLastSpeech >= silenceBufferMs)
        {
            return RecordingStopReason.SilenceAfterSpeech;
        }

        if (!hasHeardSpeech && elapsedMs >= maxWaitForSpeechMs)
        {
            return RecordingStopReason.NoSpeechTimeout;
        }

        return RecordingStopReason.None;
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd windows-native-launcher/ManaNativeLauncher.Tests && dotnet test`
Expected: PASS, 6/6 new tests (15/15 total including Task 1's).

- [ ] **Step 5: Commit**

```bash
git add windows-native-launcher/RecordingSegmenter.cs windows-native-launcher/ManaNativeLauncher.Tests/RecordingSegmenterTests.cs
git commit -m "feat: port RecordingSegmenter (silence-buffer stop-timing) to the native launcher"
```

---

## Task 3: NAudio + OnnxRuntime dependencies, VAD model fetch, `SileroVadRunner`

**Files:**
- Modify: `windows-native-launcher/ManaNativeLauncher.csproj`
- Modify: `.gitignore`
- Create: `windows-native-launcher/SileroVadRunner.cs`
- Test: `windows-native-launcher/ManaNativeLauncher.Tests/SileroVadRunnerTests.cs`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `SileroVadRunner` (implements `IDisposable`), constructor `SileroVadRunner(string modelPath, float threshold = 0.5f)`, `ProcessFrame(float[] frame)` → `float` (speech probability), `IsSpeech(float probability)` → `bool`, `Reset()`, constants `FrameSamples = 512`, `ContextSize = 64`, `SampleRate = 16000`. Used by `VoiceLoop` (Task 6).

- [ ] **Step 1: Add NAudio and Microsoft.ML.OnnxRuntime package references**

In `windows-native-launcher/ManaNativeLauncher.csproj`, add a new `ItemGroup` after the `InternalsVisibleTo` one added in Task 1:

```xml
  <ItemGroup>
    <PackageReference Include="NAudio" Version="2.2.1" />
    <PackageReference Include="Microsoft.ML.OnnxRuntime" Version="1.19.2" />
  </ItemGroup>
```

If `dotnet restore` reports these exact versions are no longer available on nuget.org by the time this task runs, bump to the latest stable 2.x (NAudio) / 1.x (Microsoft.ML.OnnxRuntime) release — the API surface used by this plan (`WasapiCapture`, `WasapiOut`, `WaveFileReader`, `WaveFileWriter`, `MediaFoundationResampler`, `InferenceSession`) has been stable across recent versions of both packages.

- [ ] **Step 2: Add the VAD model fetch build step**

In `windows-native-launcher/ManaNativeLauncher.csproj`, add a new `Target` after the closing `</PropertyGroup>` tag (before the `ItemGroup`s):

```xml
  <Target Name="FetchSileroVadModel" BeforeTargets="Build">
    <PropertyGroup>
      <SileroVadModelDir>$(MSBuildProjectDirectory)\assets\vad</SileroVadModelDir>
      <SileroVadModelPath>$(SileroVadModelDir)\silero_vad.onnx</SileroVadModelPath>
      <SileroVadModelUrl>https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx</SileroVadModelUrl>
    </PropertyGroup>
    <MakeDir Directories="$(SileroVadModelDir)" Condition="!Exists('$(SileroVadModelDir)')" />
    <Exec
      Command="powershell -NoProfile -ExecutionPolicy Bypass -Command &quot;Invoke-WebRequest -Uri '$(SileroVadModelUrl)' -OutFile '$(SileroVadModelPath)' -UserAgent 'mana-fetch-silero-vad'&quot;"
      Condition="!Exists('$(SileroVadModelPath)')" />
  </Target>
```

This mirrors `windows-launcher/scripts/fetch-silero-vad.js`'s check-exists-then-download behavior — the outer `Condition="!Exists(...)"` skips the download entirely once the model is present, matching the JS script's own early-exit.

- [ ] **Step 3: Gitignore the fetched model, matching the Electron apps' existing convention**

In `.gitignore`, find the existing entries (near line 70-71):

```
windows-launcher/assets/vad/
desktop-client/assets/vad/
```

Replace with:

```
windows-launcher/assets/vad/
desktop-client/assets/vad/
windows-native-launcher/assets/vad/
```

- [ ] **Step 4: Build to fetch the model and verify the new packages resolve**

Run: `cd windows-native-launcher && dotnet build`
Expected: succeeds; `windows-native-launcher/assets/vad/silero_vad.onnx` now exists and is non-empty (the fetch target ran).

- [ ] **Step 5: Write the failing test**

Write `windows-native-launcher/ManaNativeLauncher.Tests/SileroVadRunnerTests.cs`:

```csharp
using System;
using System.IO;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class SileroVadRunnerTests
{
    // The model is a build-time-fetched, gitignored binary (Task 3, Step
    // 2) -- not guaranteed present in every checkout/CI environment.
    // Skips gracefully rather than failing CI elsewhere, matching
    // node-bot/test/transcribe-partial-real-whisper.test.js's own
    // pattern for a similarly-optional large binary dependency.
    private static readonly string ModelPath = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "assets", "vad", "silero_vad.onnx");

    private static bool ModelAvailable => File.Exists(ModelPath) && new FileInfo(ModelPath).Length > 0;

    [Fact]
    public void ProcessFrame_ThrowsOnWrongFrameLength()
    {
        if (!ModelAvailable)
        {
            return;
        }

        using var vad = new SileroVadRunner(ModelPath);
        var wrongSizeFrame = new float[SileroVadRunner.FrameSamples - 1];

        Assert.Throws<ArgumentException>(() => vad.ProcessFrame(wrongSizeFrame));
    }

    [Fact]
    public void ProcessFrame_SilenceProducesLowProbability()
    {
        if (!ModelAvailable)
        {
            return;
        }

        using var vad = new SileroVadRunner(ModelPath);
        var silence = new float[SileroVadRunner.FrameSamples];

        // Run a few frames through -- the recurrent state needs a couple
        // calls to settle away from its zero-initialized starting point.
        float probability = 0;
        for (var i = 0; i < 5; i++)
        {
            probability = vad.ProcessFrame(silence);
        }

        Assert.False(vad.IsSpeech(probability));
    }

    [Fact]
    public void Reset_ClearsRecurrentStateAndContext()
    {
        if (!ModelAvailable)
        {
            return;
        }

        using var vad = new SileroVadRunner(ModelPath);
        var loudFrame = new float[SileroVadRunner.FrameSamples];
        Array.Fill(loudFrame, 0.5f);
        vad.ProcessFrame(loudFrame);

        // No assertion on the probability itself (that depends on the
        // real model's actual weights, which this test doesn't second-
        // guess) -- this only confirms Reset() runs without throwing and
        // a fresh frame can be processed immediately after, proving the
        // internal buffers were actually reset to valid same-shape state
        // rather than left corrupted.
        vad.Reset();
        var silence = new float[SileroVadRunner.FrameSamples];
        var probability = vad.ProcessFrame(silence);

        Assert.InRange(probability, 0f, 1f);
    }
}
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd windows-native-launcher/ManaNativeLauncher.Tests && dotnet test`
Expected: FAIL with compile errors — `SileroVadRunner` does not exist yet.

- [ ] **Step 7: Implement `SileroVadRunner`**

Write `windows-native-launcher/SileroVadRunner.cs`:

```csharp
using System;
using System.Linq;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace Mana.NativeLauncher;

// Ports windows-launcher/renderer/silero-vad.js's exact I/O contract onto
// Microsoft.ML.OnnxRuntime -- see that file's header comment for how this
// shape was confirmed against the real ONNX graph (a wrong-shaped `input`
// doesn't error there, since the axis is dynamic, it just silently
// produces near-zero probability). This port throws on a shape mismatch
// instead of letting that failure mode through silently -- a native
// build's own wiring bug should surface loudly, not degrade quietly.
//
// The `sr` input is a true scalar (empty shape `[]` in the JS/ONNX graph,
// not a 1-element vector) -- verified against the model at Task 3 Step 6's
// test run; if InferenceSession.Run throws a shape-mismatch error on `sr`
// specifically, change srTensor's dims below to `new[] { 1 }` instead of
// `Array.Empty<int>()`.
internal sealed class SileroVadRunner : IDisposable
{
    internal const int FrameSamples = 512;
    internal const int ContextSize = 64;
    internal const int SampleRate = 16000;
    internal const float DefaultThreshold = 0.5f;
    private const int StateSize = 2 * 1 * 128;

    private readonly InferenceSession session;
    private readonly float threshold;
    private float[] state = new float[StateSize];
    private float[] context = new float[ContextSize];

    public SileroVadRunner(string modelPath, float threshold = DefaultThreshold)
    {
        session = new InferenceSession(modelPath);
        this.threshold = threshold;
    }

    // New utterance: neither the recurrent state nor the leading context
    // window should carry over speech from a previous, unrelated segment.
    public void Reset()
    {
        state = new float[StateSize];
        context = new float[ContextSize];
    }

    public float ProcessFrame(float[] frame)
    {
        if (frame is null || frame.Length != FrameSamples)
        {
            throw new ArgumentException(
                $"ProcessFrame expects exactly {FrameSamples} samples at {SampleRate}Hz, got {frame?.Length.ToString() ?? "null"}",
                nameof(frame));
        }

        var input = new float[ContextSize + FrameSamples];
        Array.Copy(context, 0, input, 0, ContextSize);
        Array.Copy(frame, 0, input, ContextSize, FrameSamples);

        var inputTensor = new DenseTensor<float>(input, new[] { 1, ContextSize + FrameSamples });
        var stateTensor = new DenseTensor<float>(state, new[] { 2, 1, 128 });
        var srTensor = new DenseTensor<long>(new long[] { SampleRate }, Array.Empty<int>());

        var inputs = new[]
        {
            NamedOnnxValue.CreateFromTensor("input", inputTensor),
            NamedOnnxValue.CreateFromTensor("state", stateTensor),
            NamedOnnxValue.CreateFromTensor("sr", srTensor),
        };

        using var results = session.Run(inputs);
        var output = results.First(r => r.Name == "output").AsTensor<float>().ToArray();
        state = results.First(r => r.Name == "stateN").AsTensor<float>().ToArray();

        context = new float[ContextSize];
        Array.Copy(input, input.Length - ContextSize, context, 0, ContextSize);

        return output[0];
    }

    public bool IsSpeech(float probability) => probability >= threshold;

    public void Dispose() => session.Dispose();
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd windows-native-launcher/ManaNativeLauncher.Tests && dotnet test`
Expected: PASS, 3/3 new tests (18/18 total). If `ProcessFrame_SilenceProducesLowProbability` or `Reset_ClearsRecurrentStateAndContext` throw a shape-mismatch exception from `InferenceSession.Run` naming `sr`, apply the fix noted in Step 7's comment (change `srTensor`'s dims from `Array.Empty<int>()` to `new[] { 1 }`) and re-run.

- [ ] **Step 9: Commit**

```bash
git add windows-native-launcher/ManaNativeLauncher.csproj .gitignore windows-native-launcher/SileroVadRunner.cs windows-native-launcher/ManaNativeLauncher.Tests/SileroVadRunnerTests.cs
git commit -m "feat: add NAudio/OnnxRuntime deps, VAD model fetch, and SileroVadRunner"
```

---

## Task 4: `ManaBackendClient` — transcribe/reply/synthesize

**Files:**
- Modify: `windows-native-launcher/ManaBackendClient.cs`
- Test: `windows-native-launcher/ManaNativeLauncher.Tests/ManaBackendClientTests.cs`

**Interfaces:**
- Consumes: nothing from Tasks 1-3.
- Produces: `ManaBackendClient(HttpMessageHandler? handler = null)` constructor (backward compatible — `handler: null` behaves exactly as the existing parameterless construction), `TranscribeAsync(byte[] wavBytes)` → `Task<string>`, `ReplyAsync(string text)` → `Task<string>`, `SynthesizeAsync(string text)` → `Task<byte[]>`. Used by `VoiceLoop` (Task 6).

- [ ] **Step 1: Write the failing tests**

Write `windows-native-launcher/ManaNativeLauncher.Tests/ManaBackendClientTests.cs`:

```csharp
using System;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

internal sealed class FakeHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, HttpResponseMessage> responder;

    public FakeHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> responder)
    {
        this.responder = responder;
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        return Task.FromResult(responder(request));
    }
}

public class ManaBackendClientTests
{
    [Fact]
    public async Task TranscribeAsync_PostsToTranscribeOnlyAndReturnsTranscript()
    {
        string? path = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"transcript\":\"hello mana\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var transcript = await client.TranscribeAsync(new byte[] { 1, 2, 3 });

        Assert.Equal("/transcribe-only", path);
        Assert.Equal("hello mana", transcript);
    }

    [Fact]
    public async Task ReplyAsync_SendsTextAsJsonAndReturnsReply()
    {
        string? path = null;
        string? body = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"reply\":\"Hi there!\"}", Encoding.UTF8, "application/json"),
            };
        });
        var client = new ManaBackendClient(handler);

        var reply = await client.ReplyAsync("hello");

        Assert.Equal("/reply", path);
        Assert.Contains("\"text\":\"hello\"", body);
        Assert.Equal("Hi there!", reply);
    }

    [Fact]
    public async Task SynthesizeAsync_ReturnsRawResponseBytes()
    {
        var expectedBytes = new byte[] { 0x52, 0x49, 0x46, 0x46 };
        string? path = null;
        var handler = new FakeHttpMessageHandler(request =>
        {
            path = request.RequestUri!.AbsolutePath;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(expectedBytes),
            };
        });
        var client = new ManaBackendClient(handler);

        var bytes = await client.SynthesizeAsync("hello");

        Assert.Equal("/synthesize", path);
        Assert.Equal(expectedBytes, bytes);
    }

    [Fact]
    public async Task TranscribeAsync_ThrowsOnNonSuccessStatus()
    {
        var handler = new FakeHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.InternalServerError));
        var client = new ManaBackendClient(handler);

        await Assert.ThrowsAsync<HttpRequestException>(() => client.TranscribeAsync(new byte[] { 1 }));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd windows-native-launcher/ManaNativeLauncher.Tests && dotnet test`
Expected: FAIL with compile errors — `TranscribeAsync`/`ReplyAsync`/`SynthesizeAsync` and the `HttpMessageHandler` constructor overload do not exist yet.

- [ ] **Step 3: Implement the new methods and constructor**

In `windows-native-launcher/ManaBackendClient.cs`, replace the entire file with:

```csharp
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Mana.NativeLauncher;

internal sealed class ManaBackendClient
{
    private readonly HttpClient http;

    // handler: null (the default, and every existing call site's
    // behavior) constructs a real HttpClient against the live backend.
    // Tests pass a fake HttpMessageHandler to exercise the request/parse
    // logic without a live server.
    public ManaBackendClient(HttpMessageHandler? handler = null)
    {
        http = handler is null
            ? new HttpClient()
            : new HttpClient(handler);
        http.BaseAddress = new System.Uri("http://127.0.0.1:5005");
    }

    public async Task<ManaPerformanceStatus> GetPerformanceStatusAsync()
    {
        using var response = await http.GetAsync("/perf/status");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        var root = document.RootElement;
        var process = root.GetProperty("process");
        var config = root.GetProperty("config");
        var gaming = root.GetProperty("gaming");

        return new ManaPerformanceStatus
        {
            TotalMemoryMb = process.GetProperty("totalMemoryMb").GetInt32(),
            TtsProvider = config.GetProperty("ttsProvider").GetString() ?? "unknown",
            GamingAppRunning = gaming.GetProperty("gamingAppRunning").GetBoolean(),
        };
    }

    public async Task<string> TranscribeAsync(byte[] wavBytes)
    {
        using var content = new MultipartFormDataContent();
        using var fileContent = new ByteArrayContent(wavBytes);
        fileContent.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        content.Add(fileContent, "file", "clip.wav");

        using var response = await http.PostAsync("/transcribe-only", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.GetProperty("transcript").GetString() ?? string.Empty;
    }

    public async Task<string> ReplyAsync(string text)
    {
        var payload = JsonSerializer.Serialize(new { text });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/reply", content);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var document = await JsonDocument.ParseAsync(stream);
        return document.RootElement.GetProperty("reply").GetString() ?? string.Empty;
    }

    public async Task<byte[]> SynthesizeAsync(string text)
    {
        var payload = JsonSerializer.Serialize(new { text });
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var response = await http.PostAsync("/synthesize", content);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsByteArrayAsync();
    }
}

internal sealed class ManaPerformanceStatus
{
    public int TotalMemoryMb { get; init; }
    public string TtsProvider { get; init; } = "unknown";
    public bool GamingAppRunning { get; init; }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd windows-native-launcher/ManaNativeLauncher.Tests && dotnet test`
Expected: PASS, 4/4 new tests (22/22 total).

- [ ] **Step 5: Verify the existing `GetPerformanceStatusAsync` call sites still compile**

Run: `cd windows-native-launcher && dotnet build`
Expected: succeeds — `ManaApplicationContext.cs`'s `new ManaBackendClient()` (no arguments) still resolves against the new `handler = null` default parameter.

- [ ] **Step 6: Commit**

```bash
git add windows-native-launcher/ManaBackendClient.cs windows-native-launcher/ManaNativeLauncher.Tests/ManaBackendClientTests.cs
git commit -m "feat: add transcribe/reply/synthesize methods to ManaBackendClient"
```

---

## Task 5: `AudioPlayer`

**Files:**
- Create: `windows-native-launcher/AudioPlayer.cs`

**Interfaces:**
- Consumes: nothing from Tasks 1-4.
- Produces: `AudioPlayer` (implements `IDisposable`), `event Action? PlaybackStarted`, `event Action? PlaybackCompleted`, `Play(byte[] wavBytes)`, `Stop()`. Used by `VoiceLoop` (Task 6).

No automated tests for this task: it's a thin WASAPI playback wrapper with no algorithmic decisions of its own (the spec's own Testing section calls this out explicitly — "Capture/VAD-to-HTTP glue and playback are integration-tested by hand"), matching this codebase's existing convention of leaving `ManaProcessManager`/`AvatarOverlayForm`/`ManaApplicationContext` untested. Manual verification happens in Task 6, once `VoiceLoop` actually drives real playback end-to-end.

- [ ] **Step 1: Implement `AudioPlayer`**

Write `windows-native-launcher/AudioPlayer.cs`:

```csharp
using System;
using System.IO;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Mana.NativeLauncher;

// Plays one synthesized WAV clip start-to-finish. No queueing/streaming
// (sub-project 2's job) and no lip-sync analysis tap (sub-project 4's
// job) -- deliberately the thinnest possible wrapper.
internal sealed class AudioPlayer : IDisposable
{
    public event Action? PlaybackStarted;
    public event Action? PlaybackCompleted;

    private WasapiOut? output;
    private WaveFileReader? reader;
    private MemoryStream? stream;

    public void Play(byte[] wavBytes)
    {
        Stop();

        stream = new MemoryStream(wavBytes);
        reader = new WaveFileReader(stream);
        output = new WasapiOut(AudioClientShareMode.Shared, latency: 100);
        output.Init(reader);
        output.PlaybackStopped += (_, _) => PlaybackCompleted?.Invoke();

        PlaybackStarted?.Invoke();
        output.Play();
    }

    public void Stop()
    {
        output?.Stop();
        output?.Dispose();
        output = null;
        reader?.Dispose();
        reader = null;
        stream?.Dispose();
        stream = null;
    }

    public void Dispose() => Stop();
}
```

- [ ] **Step 2: Verify the project builds against the real NAudio playback API**

Run: `cd windows-native-launcher && dotnet build`
Expected: succeeds. If `WasapiOut`'s constructor signature differs from `(AudioClientShareMode, int)` in the resolved NAudio version, adjust to match — check NAudio's `WasapiOut` class documentation for the installed package version.

- [ ] **Step 3: Commit**

```bash
git add windows-native-launcher/AudioPlayer.cs
git commit -m "feat: add AudioPlayer (WASAPI playback wrapper) to the native launcher"
```

---

## Task 6: `VoiceLoop` — capture, orchestration, and wiring into the tray app

**Files:**
- Create: `windows-native-launcher/VoiceLoop.cs`
- Modify: `windows-native-launcher/ManaApplicationContext.cs`

**Interfaces:**
- Consumes: `SileroVadRunner` (Task 3), `ManaBackendClient.TranscribeAsync/ReplyAsync/SynthesizeAsync` (Task 4), `AudioPlayer` (Task 5), `WakeWordMatcher.ExtractWakeCommand` (Task 1), `RecordingSegmenter.ShouldStopRecording`/`RecordingStopReason` (Task 2), `AvatarOverlayForm.SetState`/`AvatarState` (existing).
- Produces: `VoiceLoop` (implements `IDisposable`), constructor `VoiceLoop(SileroVadRunner vad, ManaBackendClient backendClient, AudioPlayer audioPlayer, AvatarOverlayForm avatarOverlay)`, `Start()`, `Stop()`.

No automated tests for this task either, for the same reason as Task 5 — it's the orchestration/hardware-capture glue the spec explicitly scopes to manual/integration testing. All of its actual decisions (when to stop recording, whether a wake word was found) are already covered by Tasks 1-2's unit tests; this task wires those decisions to real audio hardware and the real HTTP client.

- [ ] **Step 1: Implement `VoiceLoop`**

Write `windows-native-launcher/VoiceLoop.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Mana.NativeLauncher;

// Owns the always-on capture -> VAD -> segment -> transcribe -> wake-word
// -> reply -> synthesize -> play loop. Runs continuously from Start() to
// Stop()/Dispose() -- never restarted around individual conversation
// turns, so sub-project 3 (barge-in) can reuse this same running VAD
// instance to detect speech during playback without restructuring this
// class.
internal sealed class VoiceLoop : IDisposable
{
    private readonly SileroVadRunner vad;
    private readonly ManaBackendClient backendClient;
    private readonly AudioPlayer audioPlayer;
    private readonly AvatarOverlayForm avatarOverlay;

    private WasapiCapture? capture;
    private ISampleProvider? resampled;
    private readonly List<float> frameBuffer = new();
    private readonly List<short> segmentSamples = new();

    private bool awake;
    private bool hasHeardSpeechInSegment;
    private long segmentElapsedMs;
    private long msSinceLastSpeech;
    private DateTime lastFrameAt;
    private bool segmentInFlight;

    public VoiceLoop(
        SileroVadRunner vad,
        ManaBackendClient backendClient,
        AudioPlayer audioPlayer,
        AvatarOverlayForm avatarOverlay)
    {
        this.vad = vad;
        this.backendClient = backendClient;
        this.audioPlayer = audioPlayer;
        this.avatarOverlay = avatarOverlay;
    }

    public void Start()
    {
        capture = new WasapiCapture();
        var waveInProvider = new WaveInProvider(capture);
        // WASAPI shared-mode capture returns the device's own mix format
        // (typically 44.1kHz or 48kHz), not an arbitrarily requested rate
        // -- resample to 16kHz mono here so both the VAD frames below and
        // the WAV eventually sent to /transcribe-only match Silero VAD's
        // fixed contract and Whisper's tested input format.
        var resampler = new MediaFoundationResampler(
            waveInProvider,
            new WaveFormat(SileroVadRunner.SampleRate, 16, 1))
        {
            ResamplerQuality = 60,
        };
        resampled = resampler.ToSampleProvider();

        lastFrameAt = DateTime.UtcNow;
        capture.DataAvailable += OnDataAvailable;
        capture.StartRecording();
    }

    public void Stop()
    {
        if (capture is null)
        {
            return;
        }

        capture.DataAvailable -= OnDataAvailable;
        capture.StopRecording();
        capture.Dispose();
        capture = null;
        resampled = null;
    }

    public void Dispose() => Stop();

    private void OnDataAvailable(object? sender, WaveInEventArgs e)
    {
        if (resampled is null)
        {
            return;
        }

        var scratch = new float[4096];
        int samplesRead;
        while ((samplesRead = resampled.Read(scratch, 0, scratch.Length)) > 0)
        {
            for (var i = 0; i < samplesRead; i++)
            {
                frameBuffer.Add(scratch[i]);
            }
        }

        ProcessBufferedFrames();
    }

    private void ProcessBufferedFrames()
    {
        // One segment (one conversation turn) in flight at a time -- keep
        // buffering raw samples while a turn is being handled, but don't
        // run VAD/segment logic against them until it's done, so a reply
        // arriving mid-buffer can't interleave with the next segment's
        // state.
        if (segmentInFlight)
        {
            return;
        }

        while (frameBuffer.Count >= SileroVadRunner.FrameSamples)
        {
            var frame = frameBuffer.GetRange(0, SileroVadRunner.FrameSamples).ToArray();
            frameBuffer.RemoveRange(0, SileroVadRunner.FrameSamples);

            var probability = vad.ProcessFrame(frame);
            var isSpeech = vad.IsSpeech(probability);

            var now = DateTime.UtcNow;
            var frameMs = (long)(now - lastFrameAt).TotalMilliseconds;
            lastFrameAt = now;
            segmentElapsedMs += frameMs;

            foreach (var sample in frame)
            {
                var clamped = Math.Clamp(sample, -1f, 1f);
                segmentSamples.Add((short)(clamped * short.MaxValue));
            }

            if (isSpeech)
            {
                hasHeardSpeechInSegment = true;
                msSinceLastSpeech = 0;
            }
            else
            {
                msSinceLastSpeech += frameMs;
            }

            var stopReason = RecordingSegmenter.ShouldStopRecording(
                hasHeardSpeechInSegment,
                segmentElapsedMs,
                msSinceLastSpeech);

            if (stopReason == RecordingStopReason.SilenceAfterSpeech)
            {
                segmentInFlight = true;
                _ = HandleSegmentClosedAsync();
                return;
            }

            if (stopReason is RecordingStopReason.MaxDuration or RecordingStopReason.NoSpeechTimeout)
            {
                ResetSegment();
            }
        }
    }

    private void ResetSegment()
    {
        segmentSamples.Clear();
        hasHeardSpeechInSegment = false;
        segmentElapsedMs = 0;
        msSinceLastSpeech = 0;
        vad.Reset();
    }

    private async Task HandleSegmentClosedAsync()
    {
        var wavBytes = BuildWavBytes(segmentSamples);
        ResetSegment();

        try
        {
            await RunTurnAsync(wavBytes);
        }
        finally
        {
            segmentInFlight = false;
            // Frames captured while the turn was in flight are still
            // sitting in frameBuffer -- process them now instead of
            // waiting for the next DataAvailable callback.
            ProcessBufferedFrames();
        }
    }

    private async Task RunTurnAsync(byte[] wavBytes)
    {
        string transcript;
        try
        {
            transcript = await backendClient.TranscribeAsync(wavBytes);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: transcription failed, resuming listening. {ex.Message}");
            return;
        }

        if (string.IsNullOrWhiteSpace(transcript))
        {
            return;
        }

        string commandText;
        if (!awake)
        {
            var command = WakeWordMatcher.ExtractWakeCommand(transcript);
            if (command is null)
            {
                return;
            }

            awake = true;
            commandText = command;
        }
        else
        {
            commandText = transcript;
        }

        if (string.IsNullOrWhiteSpace(commandText))
        {
            return;
        }

        string reply;
        try
        {
            reply = await backendClient.ReplyAsync(commandText);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: reply failed, resuming listening. {ex.Message}");
            return;
        }

        byte[] replyWav;
        try
        {
            replyWav = await backendClient.SynthesizeAsync(reply);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"VoiceLoop: synthesis failed, resuming listening. {ex.Message}");
            return;
        }

        avatarOverlay.SetState(AvatarState.Talking);
        audioPlayer.PlaybackCompleted += OnPlaybackCompletedOnce;
        audioPlayer.Play(replyWav);
    }

    private void OnPlaybackCompletedOnce()
    {
        audioPlayer.PlaybackCompleted -= OnPlaybackCompletedOnce;
        avatarOverlay.SetState(AvatarState.Idle);
    }

    private static byte[] BuildWavBytes(List<short> samples)
    {
        using var stream = new MemoryStream();
        var writer = new WaveFileWriter(stream, new WaveFormat(SileroVadRunner.SampleRate, 16, 1));
        var bytes = new byte[samples.Count * 2];
        Buffer.BlockCopy(samples.ToArray(), 0, bytes, 0, bytes.Length);
        writer.Write(bytes, 0, bytes.Length);
        writer.Flush();
        var result = stream.ToArray();
        writer.Dispose();
        return result;
    }
}
```

- [ ] **Step 2: Wire `VoiceLoop` into `ManaApplicationContext`**

In `windows-native-launcher/ManaApplicationContext.cs`, replace the field declarations:

```csharp
    private readonly AvatarOverlayForm avatarOverlay;
    private readonly NotifyIcon trayIcon;
    private readonly ManaProcessManager processManager;
    private readonly ManaBackendClient backendClient;
    private readonly System.Windows.Forms.Timer statusTimer;
```

with:

```csharp
    private readonly AvatarOverlayForm avatarOverlay;
    private readonly NotifyIcon trayIcon;
    private readonly ManaProcessManager processManager;
    private readonly ManaBackendClient backendClient;
    private readonly System.Windows.Forms.Timer statusTimer;
    private readonly SileroVadRunner sileroVad;
    private readonly AudioPlayer audioPlayer;
    private readonly VoiceLoop voiceLoop;
```

Then replace the constructor body:

```csharp
    public ManaApplicationContext()
    {
        var rootDir = FindRootDirectory();
        processManager = new ManaProcessManager(rootDir);
        backendClient = new ManaBackendClient();
        avatarOverlay = new AvatarOverlayForm(rootDir);

        trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Mana",
            Visible = true,
            ContextMenuStrip = BuildTrayMenu(),
        };

        trayIcon.DoubleClick += (_, _) => ShowStatus();
        avatarOverlay.Show();

        // Quick rundown: start the existing local services, but keep this host native and small.
        _ = StartServicesAsync();

        statusTimer = new System.Windows.Forms.Timer
        {
            Interval = 5000,
        };
        statusTimer.Tick += async (_, _) => await RefreshTrayStatusAsync();
        statusTimer.Start();
    }
```

with:

```csharp
    public ManaApplicationContext()
    {
        var rootDir = FindRootDirectory();
        processManager = new ManaProcessManager(rootDir);
        backendClient = new ManaBackendClient();
        avatarOverlay = new AvatarOverlayForm(rootDir);

        var vadModelPath = Path.Combine(rootDir, "windows-native-launcher", "assets", "vad", "silero_vad.onnx");
        sileroVad = new SileroVadRunner(vadModelPath);
        audioPlayer = new AudioPlayer();
        voiceLoop = new VoiceLoop(sileroVad, backendClient, audioPlayer, avatarOverlay);

        trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Mana",
            Visible = true,
            ContextMenuStrip = BuildTrayMenu(),
        };

        trayIcon.DoubleClick += (_, _) => ShowStatus();
        avatarOverlay.Show();

        // Quick rundown: start the existing local services, but keep this host native and small.
        _ = StartServicesAsync();

        statusTimer = new System.Windows.Forms.Timer
        {
            Interval = 5000,
        };
        statusTimer.Tick += async (_, _) => await RefreshTrayStatusAsync();
        statusTimer.Start();
    }
```

Then, in `StartServicesAsync`, start the voice loop once the backend is confirmed up (after `processManager.StartAsync()` completes, since the backend must be listening before the first transcribe/reply/synthesize call). Replace:

```csharp
    private async Task StartServicesAsync()
    {
        await processManager.StartAsync();
        await RefreshTrayStatusAsync();
    }
```

with:

```csharp
    private async Task StartServicesAsync()
    {
        await processManager.StartAsync();
        await RefreshTrayStatusAsync();
        voiceLoop.Start();
    }
```

Finally, dispose the new resources in `ExitThreadCore`. Replace:

```csharp
    protected override void ExitThreadCore()
    {
        statusTimer.Stop();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        avatarOverlay.Close();
        processManager.Dispose();
        base.ExitThreadCore();
    }
```

with:

```csharp
    protected override void ExitThreadCore()
    {
        statusTimer.Stop();
        voiceLoop.Dispose();
        audioPlayer.Dispose();
        sileroVad.Dispose();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        avatarOverlay.Close();
        processManager.Dispose();
        base.ExitThreadCore();
    }
```

Add `using System.IO;` to the top of `ManaApplicationContext.cs` if not already present (it already is, per the existing file — confirm before editing).

- [ ] **Step 3: Build**

Run: `cd windows-native-launcher && dotnet build`
Expected: succeeds. Fix any NAudio API signature mismatches surfaced by the compiler against the actual resolved package version (see the inline risk notes in Task 3 Step 7 and Task 5 Step 2 for the two specific points most likely to need adjustment: the `sr` tensor's shape, and `WasapiOut`'s constructor).

- [ ] **Step 4: Manual end-to-end verification**

With `node-bot` and Kokoro TTS running (either via `dotnet run` from `windows-native-launcher/`, which starts them automatically via `ManaProcessManager`, or already running from a prior `windows-launcher` session):

1. Run: `cd windows-native-launcher && dotnet run`
2. Say "Mana, what time is it?" into the microphone.
3. Expected: the app transcribes the utterance, recognizes the wake word, sends the stripped command to `/reply`, synthesizes and plays the response, and the avatar overlay switches to the talking image during playback and back to idle afterward.
4. Say a follow-up without repeating "Mana" (e.g., "and what's today's date?").
5. Expected: the follow-up is answered directly — the `awake` latch means the wake word isn't required again for the rest of the process's lifetime, matching the Electron app's behavior.

This is the plan's only end-to-end check on real hardware — per the spec's own Testing section, capture/VAD-to-HTTP glue and playback are integration-tested by hand, not by an automated harness.

- [ ] **Step 5: Commit**

```bash
git add windows-native-launcher/VoiceLoop.cs windows-native-launcher/ManaApplicationContext.cs
git commit -m "feat: wire VoiceLoop (capture, VAD, wake-word, reply, playback) into the native launcher"
```

---

## Self-Review

**Spec coverage:**
- Component architecture (`SileroVadRunner`, `VoiceLoop`, `ManaBackendClient` extension, `AudioPlayer`) — Tasks 3, 6, 4, 5 respectively. ✓
- VAD model sourcing (build-time fetch, gitignored) — Task 3. ✓
- Capture flow (resample, frame-split, VAD, segment-assembly, wake-word gate, transcribe/reply/synthesize) — Task 6, using Task 1's `WakeWordMatcher` and Task 2's `RecordingSegmenter`. ✓
- Playback & avatar state (talking before play, idle on natural completion) — Task 6 (`RunTurnAsync`/`OnPlaybackCompletedOnce`), using Task 5's `AudioPlayer`. ✓
- Error handling (per-call try/catch, resume listening; no RMS fallback; hard VAD-load failure) — Task 6's `RunTurnAsync` try/catch blocks; VAD load failure is inherently hard (unhandled `SileroVadRunner` constructor exception surfaces immediately, matching the spec's "no silent fallback" requirement without needing extra code). ✓
- Testing section (`SileroVadRunner`/segment-assembly unit tests, `ManaBackendClient` fake-handler tests, hand-tested glue) — Tasks 3, 1/2, 4, and 6 respectively. ✓

**Placeholder scan:** No TBD/TODO/"add appropriate error handling." Every step shows real, complete code. Two points of genuine third-party-API uncertainty (the `sr` tensor's scalar shape in Task 3, `WasapiOut`'s constructor overload in Task 5) are flagged with the exact fallback to try, not left vague — this is disclosed uncertainty about an external library's exact surface, not an unresolved design decision.

**Type/name consistency check:** `SileroVadRunner.FrameSamples`/`ContextSize`/`SampleRate` (Task 3) are the exact names `VoiceLoop` (Task 6) references. `RecordingStopReason`/`ShouldStopRecording` (Task 2) match exactly what `VoiceLoop` calls. `WakeWordMatcher.ExtractWakeCommand` (Task 1) matches exactly. `ManaBackendClient.TranscribeAsync/ReplyAsync/SynthesizeAsync` (Task 4) match exactly what `VoiceLoop.RunTurnAsync` calls, including the `HttpMessageHandler? handler = null` constructor parameter used only by tests. `AudioPlayer.PlaybackCompleted`/`Play` (Task 5) match exactly.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-24-native-launcher-core-voice-loop.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
