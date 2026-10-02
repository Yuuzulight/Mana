using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// Part of #624: no glance or capture while a password box has focus.
public class ScreenPrivacyGuardPasswordFieldTests
{
    [Fact]
    public void AllowsWhenFocusIsNotAPasswordField() =>
        Assert.Null(ScreenPrivacyGuard.PasswordFieldBlockReason(() => false));

    [Fact]
    public void BlocksWhenFocusIsAPasswordField() =>
        Assert.Equal("a password field has focus", ScreenPrivacyGuard.PasswordFieldBlockReason(() => true));

    [Fact]
    public void FailsClosedWhenUiaCannotAnswer() =>
        Assert.NotNull(ScreenPrivacyGuard.PasswordFieldBlockReason(() => null));
}
