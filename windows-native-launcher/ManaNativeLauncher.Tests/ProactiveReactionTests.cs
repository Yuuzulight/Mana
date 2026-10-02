using Mana.NativeLauncher;
using Windows.UI.Notifications;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #697: only the user closing a proactive toast counts as dismissed.
public class ProactiveReactionTests
{
    [Theory]
    [InlineData(ToastDismissalReason.UserCanceled, true)]
    [InlineData(ToastDismissalReason.TimedOut, false)]
    [InlineData(ToastDismissalReason.ApplicationHidden, false)]
    public void IsUserDismissal_OnlyUserCanceled(ToastDismissalReason reason, bool expected) =>
        Assert.Equal(expected, TrayNotificationClient.IsUserDismissal(reason));

    [Fact]
    public async Task HandleActivation_OpenChatStillOpensWithoutBackend()
    {
        var opened = false;
        await TrayNotificationClient.HandleActivationAsync($"action=openChat;{TrayNotificationClient.ProactiveArgument}=checkin", () => opened = true, null);
        Assert.True(opened);
    }
}
