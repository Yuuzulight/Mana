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
    public void TryParse_ReadsTheSpokenLineWhenPresent()
    {
        var reminder = TrayNotificationPayload.TryParse(Json("""{"type":"cron","kind":"reminder-late","emotion":"sad","title":"Reminder","text":"raid","speak":"Yuuzu, raid!"}"""));
        var job = TrayNotificationPayload.TryParse(Json("""{"type":"cron","text":"job finished"}"""));

        Assert.Equal("Yuuzu, raid!", reminder!.Speak);
        Assert.Equal(("reminder-late", "sad"), (reminder.Kind, reminder.Emotion));
        Assert.Null(job!.Speak);
        Assert.Null(job.Kind);
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

    // #914: a character switch carries her Live2D model, or none for the default.
    [Fact]
    public void TryParse_ReadsTheCharactersModel()
    {
        var evil = TrayNotificationPayload.TryParse(Json("""{"type":"character","title":"Evil Mana","model":"C:\\m\\evil.model3.json"}"""));
        var mana = TrayNotificationPayload.TryParse(Json("""{"type":"character","title":"Mana","model":null}"""));

        Assert.Equal(@"C:\m\evil.model3.json", evil!.Model);
        Assert.Null(mana!.Model);
    }

    // #1337
    [Fact]
    public void TryParse_ReadsABackgroundTaskEnding()
    {
        var payload = TrayNotificationPayload.TryParse(Json("""{"type":"background_task_done","sessionId":"c1","taskId":"t1","title":"Draft M6","status":"failed"}"""));

        Assert.Equal(("background_task_done", "c1", "t1", "Draft M6", "failed"), (payload!.Type, payload.SessionId, payload.TaskId, payload.Title, payload.Status));
    }
}
