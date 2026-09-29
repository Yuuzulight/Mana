using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #687: the chat window's status line, as Electron's #statustxt.
public class VoiceStatusTests
{
    [Theory]
    [InlineData(null, true, (int)ListenMode.Idle, false, null, "Waiting for Mana...")]
    [InlineData(null, true, (int)ListenMode.Idle, true, null, "Mana is awake...")]
    [InlineData(null, true, (int)ListenMode.Processing, true, null, "Mana is thinking...")]
    [InlineData(null, true, (int)ListenMode.Processing, true, 1, "Synthesizing sentence 1...")]
    [InlineData(null, true, (int)ListenMode.Speaking, true, 3, "Speaking, synthesizing sentence 3...")]
    [InlineData(null, true, (int)ListenMode.Speaking, true, null, "Speaking...")]
    [InlineData(null, false, (int)ListenMode.Idle, false, null, "Not listening")]
    [InlineData("Reply failed: timeout", true, (int)ListenMode.Idle, true, null, "Reply failed: timeout")]
    public void FormatStatus(string? error, bool listening, int mode, bool awake, int? synthesizing, string expected)
    {
        Assert.Equal(expected, VoiceLoop.FormatStatus(error, listening, (ListenMode)mode, awake, synthesizing));
    }
}
