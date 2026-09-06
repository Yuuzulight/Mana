using System.Text;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class CaptionWebSocketClientTests
{
    private static byte[] Json(string json) => Encoding.UTF8.GetBytes(json);

    [Fact]
    public void TryParseCaptionText_ParsesCaptionFrame()
    {
        var text = CaptionWebSocketClient.TryParseCaptionText(
            Json("""{"type":"caption","ts":1,"payload":{"text":"hello there","words":[]}}"""));

        Assert.Equal("hello there", text);
    }

    [Fact]
    public void TryParseCaptionText_TrimsWhitespace()
    {
        var text = CaptionWebSocketClient.TryParseCaptionText(
            Json("""{"type":"caption","payload":{"text":"  padded  "}}"""));

        Assert.Equal("padded", text);
    }

    [Fact]
    public void TryParseCaptionText_ReturnsNullForWrongType()
    {
        var text = CaptionWebSocketClient.TryParseCaptionText(
            Json("""{"type":"dream","payload":{"text":"hello"}}"""));

        Assert.Null(text);
    }

    [Fact]
    public void TryParseCaptionText_ReturnsNullForMissingText()
    {
        var text = CaptionWebSocketClient.TryParseCaptionText(
            Json("""{"type":"caption","payload":{"words":[]}}"""));

        Assert.Null(text);
    }

    [Fact]
    public void TryParseCaptionText_ReturnsNullForEmptyText()
    {
        var text = CaptionWebSocketClient.TryParseCaptionText(
            Json("""{"type":"caption","payload":{"text":"   "}}"""));

        Assert.Null(text);
    }

    [Fact]
    public void TryParseCaptionText_ReturnsNullForMalformedJson()
    {
        var text = CaptionWebSocketClient.TryParseCaptionText(Json("not json"));

        Assert.Null(text);
    }

    [Fact]
    public void TryParseCaptionText_ReturnsNullForNonObjectPayload()
    {
        var text = CaptionWebSocketClient.TryParseCaptionText(
            Json("""{"type":"caption","payload":"oops"}"""));

        Assert.Null(text);
    }

    [Fact]
    public void TryParseCaptionText_ReturnsNullForNonStringType()
    {
        var text = CaptionWebSocketClient.TryParseCaptionText(
            Json("""{"type":5,"payload":{"text":"hi"}}"""));

        Assert.Null(text);
    }
}
