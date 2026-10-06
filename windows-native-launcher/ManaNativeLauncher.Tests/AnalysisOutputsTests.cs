using System.Drawing;
using System.Text.Json;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

[Collection("DarkTheme palette")]
public class AnalysisOutputsTests
{
    private static AnalysisOutputs Outputs()
    {
        using var bitmap = new Bitmap(800, 400);
        using (var graphics = Graphics.FromImage(bitmap)) graphics.Clear(Color.ForestGreen);
        using var stream = new MemoryStream();
        bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
        var json = JsonSerializer.Serialize(new { analysisOutputs = new {
            charts = new[] { new { dataUrl = "data:image/png;base64," + Convert.ToBase64String(stream.ToArray()) } },
            files = new[] { new { name = "results.csv", data = Convert.ToBase64String("value\n42\n"u8) } },
            tables = new[] { new { columns = new[] { "value" }, rows = new[] { new[] { "42" } } } }
        } });
        using var document = JsonDocument.Parse(json);
        return AnalysisOutputs.Parse(document.RootElement);
    }

    [Fact]
    public void RejectsExternalImagesTraversalDevicesAndNoncanonicalData()
    {
        using var document = JsonDocument.Parse("""
            {"analysisOutputs":{"charts":[{"dataUrl":"https://example.com/chart.png"}],
            "files":[{"name":"../out.csv","data":"YQ=="},{"name":"NUL.txt","data":"YQ=="},{"name":"data.csv","data":"YR=="}]}}
            """);
        var outputs = AnalysisOutputs.Parse(document.RootElement);
        Assert.Empty(outputs.Charts);
        Assert.Empty(outputs.Files);
    }

    [Theory]
    [InlineData(700)]
    [InlineData(360)]
    public void ChartsAreInlineAndDownloadsShareOneMenuAfterHistoryReload(int width)
    {
        using var view = new ChatView { Size = new Size(width, 600) };
        view.CreateControl();
        view.AppendUserMessage("Analyze");
        view.ReportReply("Done");
        var outputs = Outputs();
        view.ReportAnalysisOutputs(outputs);
        var reply = view.Messages.Last();
        var image = Assert.Single(reply.Images);
        var bounds = Assert.Single(reply.ImageBounds);
        Assert.True(bounds.Width > 120);
        Assert.True(bounds.Width <= width);
        Assert.Equal(2, Assert.Single(reply.Actions).Menu!.Count);
        Assert.Single(reply.Blocks.Where(block => block.Type == MarkdownBlockType.Table));
        view.ReportAnalysisOutputs(outputs);
        Assert.Single(reply.Images);
        Assert.Single(reply.Actions);
        Assert.Single(reply.Blocks.Where(block => block.Type == MarkdownBlockType.Table));
        view.ShowHistory(new[] { new ManaSessionTurn { TurnIndex = 0, User = "Analyze", Assistant = "Done", AnalysisOutputs = outputs } });
        reply = view.Messages.Last();
        Assert.Single(reply.Images);
        Assert.Equal(2, Assert.Single(reply.Actions).Menu!.Count);
        using var rendered = new Bitmap(width, 600);
        view.DrawToBitmap(rendered, new Rectangle(0, 0, width, 600));
        Assert.Contains(Enumerable.Range(0, width * 600), pixel => rendered.GetPixel(pixel % width, pixel / width).ToArgb() == Color.ForestGreen.ToArgb());
        if (Environment.GetEnvironmentVariable("MANA_TEST_RENDER_DIR") is { Length: > 0 } directory)
            rendered.Save(Path.Combine(directory, $"mana-analysis-{width}.png"));
    }
}
