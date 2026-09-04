using System.Text;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class TrayNotificationPayloadTests
{
    private static byte[] Json(string json) => Encoding.UTF8.GetBytes(json);

    [Fact]
    public void TryParse_ParsesTypeTitleAndText()
    {
        var payload = TrayNotificationPayload.TryParse(Json("""{"type":"dream","title":"Dream Mode","text":"insight text"}"""));

        Assert.NotNull(payload);
        Assert.Equal("dream", payload!.Type);
        Assert.Equal("Dream Mode", payload.Title);
        Assert.Equal("insight text", payload.Text);
    }

    [Fact]
    public void TryParse_DefaultsTitleToManaWhenMissing()
    {
        var payload = TrayNotificationPayload.TryParse(Json("""{"type":"cron","text":"job finished"}"""));

        Assert.Equal("Mana", payload!.Title);
    }

    [Fact]
    public void TryParse_DefaultsTextToEmptyWhenMissing()
    {
        var payload = TrayNotificationPayload.TryParse(Json("""{"type":"research"}"""));

        Assert.Equal("", payload!.Text);
    }

    [Fact]
    public void TryParse_TypeIsNullWhenMissing()
    {
        var payload = TrayNotificationPayload.TryParse(Json("""{"title":"no type here"}"""));

        Assert.Null(payload!.Type);
    }

    [Fact]
    public void TryParse_ReturnsNullForMalformedJson()
    {
        Assert.Null(TrayNotificationPayload.TryParse(Json("not json at all")));
    }

    [Fact]
    public void TryParse_ReturnsNullInsteadOfThrowingWhenTypeIsNotAString()
    {
        // #524 review: JsonElement.GetString() throws InvalidOperationException
        // (not JsonException) for a present-but-wrong-shaped field -- one
        // malformed message on the wire must not tear down the connection.
        Assert.Null(TrayNotificationPayload.TryParse(Json("""{"type":123}""")));
    }

    [Fact]
    public void TryParse_ReturnsNullWhenRootIsNotAJsonObject()
    {
        Assert.Null(TrayNotificationPayload.TryParse(Json("[1,2,3]")));
    }
}
