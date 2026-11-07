using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// The mockups' status under her name: her mood, then what she's doing.
public class AvatarStatusLineTests
{
    [Theory]
    [InlineData("Idle", "Not listening", null, "tired, chatty", "tired, chatty · mic off")]
    [InlineData("Idle", "Waiting for Mana...", null, "happy", "happy · listening")]
    [InlineData("Working", "Waiting for Mana...", null, "happy", "happy · working")]
    [InlineData("Idle", "Mana is thinking...", null, "happy", "Mana is thinking...")]
    [InlineData("Idle", "Waiting for Mana...", "hello", "happy", "Hearing: \"hello\"")]
    [InlineData("Idle", "Not listening", null, null, "Not listening")]
    [InlineData("Working", "Not listening", null, null, "Working")]
    public void MoodThenWhatSheIsDoing(string state, string voice, string? hearing, string? mood, string expected) =>
        Assert.Equal(expected, SessionListForm.StatusLine(Enum.Parse<AvatarState>(state), voice, hearing, mood));
}
