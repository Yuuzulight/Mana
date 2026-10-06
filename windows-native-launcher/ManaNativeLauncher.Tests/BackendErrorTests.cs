using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1426: a failed call says what the backend said, not just its status.
public class BackendErrorTests
{
    private static ManaBackendClient Answering(HttpStatusCode status, string? json) =>
        new(new FakeHttpMessageHandler(_ => new HttpResponseMessage(status)
        {
            Content = json is null ? new StringContent("") : new StringContent(json, Encoding.UTF8, "application/json"),
        }));

    [Fact]
    public async Task ABackendMessage_IsWhatAFailureSays()
    {
        var client = Answering(HttpStatusCode.Forbidden, "{\"error\":\"Cron Scheduler is disabled. Enable it in Settings > Plugins.\"}");
        var ex = await Assert.ThrowsAsync<HttpRequestException>(() => client.GetHeartbeatItemsAsync());
        Assert.Equal("Cron Scheduler is disabled. Enable it in Settings > Plugins.", BackendError.Describe(ex));
    }

    [Fact]
    public async Task WithoutOne_TheStatusIsSaid()
    {
        var ex = await Assert.ThrowsAsync<HttpRequestException>(() => Answering(HttpStatusCode.Forbidden, null).GetHeartbeatItemsAsync());
        Assert.Equal("Forbidden (403)", BackendError.Describe(ex));

        ex = await Assert.ThrowsAsync<HttpRequestException>(() => Answering(HttpStatusCode.InternalServerError, "{\"ok\":false}").GetHeartbeatItemsAsync());
        Assert.Equal("Internal Server Error (500)", BackendError.Describe(ex));
    }

    [Fact]
    public void OtherFailures_AreLeftAsTheyAre()
    {
        Assert.Equal("No connection could be made", BackendError.Describe(new HttpRequestException("No connection could be made")));
    }
}
