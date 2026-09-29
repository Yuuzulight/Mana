using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #683: mana-avatar.json + MANA_LIVE2D_* parsing/merging, mirroring
// live2d-logic.js's normalizeAvatarConfig/mergeStateMappings.
public class AvatarConfigTests
{
    private static Func<string, string?> Env(params (string Key, string Value)[] vars) =>
        key => vars.FirstOrDefault(v => v.Key == key).Value;

    [Fact]
    public void Parse_NoFileNoEnv_GivesTheDefaults()
    {
        var config = AvatarConfig.Parse(null, Env());

        Assert.Empty(config.StateMotions);
        Assert.Empty(config.StateExpressions);
        Assert.Empty(config.RandomMotions);
        Assert.Equal("ParamMouthOpenY", config.MouthParam);
        Assert.Equal(18f, config.MouthGain);
        Assert.Equal(0.8f, config.MouthMaxOpen);
        Assert.Equal(16f, config.AnimatedTiltDeg);
        Assert.Equal(["ParamEyeLOpen", "ParamEyeROpen"], config.EyeBlinkParams);
        Assert.Equal(AvatarGaze.DefaultTiltDegrees, config.IdleTiltDeg);
        Assert.Equal(AvatarGaze.DefaultMaxPitchDegrees, config.IdleMaxPitchDeg);
        Assert.Equal(AvatarGaze.DefaultGazeDegrees, config.IdleGazeDeg);
        Assert.Equal(AvatarGaze.DefaultGazePeriodMs, config.IdleGazePeriodMs);
    }

    [Fact]
    public void Parse_ReadsTheFile_AndKeepsExplicitZeros()
    {
        var config = AvatarConfig.Parse("""
            {
              "stateMotions": { "Excited": "curious", "idle": ["sleepy", "Idle"], "sad": [] },
              "stateExpressions": { "idle": "hug-pillow" },
              "mouthParam": "MouthA", "mouthGain": 12, "mouthMaxOpen": 0.6, "animatedTiltDeg": 12,
              "eyeBlinkParams": [],
              "idleTiltDeg": 0, "idleMaxPitchDeg": 90, "idleGazeDeg": 3, "idleGazePeriodMs": 4500
            }
            """, Env());

        Assert.Equal(["curious"], config.StateMotions["excited"]);
        Assert.Equal(["sleepy", "Idle"], config.StateMotions["idle"]);
        Assert.False(config.StateMotions.ContainsKey("sad"));
        Assert.Equal(["hug-pillow"], config.StateExpressions["idle"]);
        Assert.Equal("MouthA", config.MouthParam);
        Assert.Equal(12f, config.MouthGain);
        Assert.Equal(0.6f, config.MouthMaxOpen);
        Assert.Equal(12f, config.AnimatedTiltDeg);
        Assert.Empty(config.EyeBlinkParams); // [] disables the backfill
        Assert.Equal(0f, config.IdleTiltDeg);
        Assert.Equal(90f, config.IdleMaxPitchDeg);
        Assert.Equal(3f, config.IdleGazeDeg);
        Assert.Equal(4500f, config.IdleGazePeriodMs);
    }

    [Fact]
    public void Parse_EnvBeatsTheFile_AndStateMappingsMergeEnvFirst()
    {
        var config = AvatarConfig.Parse(
            """{ "stateMotions": { "idle": "sleepy" }, "mouthGain": 12, "idleTiltDeg": 4 }""",
            Env(
                ("MANA_LIVE2D_STATE_MOTIONS", """{"idle":"Idle","angry":["Shake"]}"""),
                ("MANA_LIVE2D_MOUTH_GAIN", "20"),
                ("MANA_LIVE2D_MOUTH_PARAM", "MouthB"),
                ("MANA_LIVE2D_EYE_BLINK_PARAMS", " EyeL , ,EyeR "),
                ("MANA_LIVE2D_IDLE_TILT_DEG", "0"),
                ("MANA_LIVE2D_MOUTH_MAX_OPEN", "0.7"),
                ("MANA_LIVE2D_ANIMATED_TILT_DEG", "20")));

        Assert.Equal(["Idle", "sleepy"], config.StateMotions["idle"]);
        Assert.Equal(["Shake"], config.StateMotions["angry"]);
        Assert.Equal(20f, config.MouthGain);
        Assert.Equal("MouthB", config.MouthParam);
        Assert.Equal(["EyeL", "EyeR"], config.EyeBlinkParams);
        Assert.Equal(0f, config.IdleTiltDeg);
        Assert.Equal(0.7f, config.MouthMaxOpen);
        Assert.Equal(20f, config.AnimatedTiltDeg);
    }

    [Fact]
    public void Parse_BadValuesFallBack_InsteadOfBreaking()
    {
        var config = AvatarConfig.Parse(
            """{ "stateMotions": "nope", "mouthParam": "", "mouthGain": "loud", "randomMotions": {} }""",
            Env(("MANA_LIVE2D_STATE_EXPRESSIONS", "{not json"), ("MANA_LIVE2D_MOUTH_GAIN", "abc"), ("MANA_LIVE2D_MOUTH_PARAM", "")));

        Assert.Empty(config.StateMotions);
        Assert.Empty(config.StateExpressions);
        Assert.Empty(config.RandomMotions);
        Assert.Equal("ParamMouthOpenY", config.MouthParam);
        Assert.Equal(18f, config.MouthGain);
        Assert.ThrowsAny<System.Text.Json.JsonException>(() => AvatarConfig.Parse("{broken", Env()));
    }

    [Fact]
    public void Parse_RandomMotions_NormalizedLikeElectron()
    {
        var config = AvatarConfig.Parse("""
            {
              "randomMotions": [
                { "group": "spirit", "minIntervalMs": 1000, "states": ["Idle", "TALKING"] },
                { "group": "wave", "minIntervalMs": 60000, "maxIntervalMs": 30000 },
                { "minIntervalMs": 60000 },
                { "group": "stretch" }
              ]
            }
            """, Env());

        Assert.Equal(3, config.RandomMotions.Count);
        var spirit = config.RandomMotions[0];
        Assert.Equal(("spirit", 5000, 20000), (spirit.Group, spirit.MinIntervalMs, spirit.MaxIntervalMs)); // floor 5s, max 4x min
        Assert.Equal(["idle", "talking"], spirit.States);
        Assert.Equal((60000, 60000), (config.RandomMotions[1].MinIntervalMs, config.RandomMotions[1].MaxIntervalMs)); // max >= min
        Assert.Equal(["idle"], config.RandomMotions[1].States);
        Assert.Equal((120000, 480000), (config.RandomMotions[2].MinIntervalMs, config.RandomMotions[2].MaxIntervalMs));
    }

    [Fact]
    public void Load_PrefersTheFileNextToTheModel_SkipsAnInvalidOne_ThenTheModelDirectory()
    {
        var root = Path.Combine(Path.GetTempPath(), "mana-avatar-config-test-" + Guid.NewGuid());
        var modelDir = Path.Combine(root, "hiyori", "runtime");
        Directory.CreateDirectory(modelDir);
        try
        {
            var model3 = Path.Combine(modelDir, "hiyori.model3.json");
            File.WriteAllText(Path.Combine(root, AvatarConfig.FileName), """{ "mouthGain": 7 }""");
            Assert.Equal(7f, AvatarConfig.Load(model3, root, Env()).MouthGain);

            File.WriteAllText(Path.Combine(modelDir, AvatarConfig.FileName), """{ "mouthGain": 5 }""");
            Assert.Equal(5f, AvatarConfig.Load(model3, root, Env()).MouthGain);

            File.WriteAllText(Path.Combine(modelDir, AvatarConfig.FileName), "{ broken");
            Assert.Equal(7f, AvatarConfig.Load(model3, root, Env()).MouthGain);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
