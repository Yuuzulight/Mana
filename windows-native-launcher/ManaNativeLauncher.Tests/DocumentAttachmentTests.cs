using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1325: attached chat documents (PDF, Word .docx, Excel .xlsx, PowerPoint .pptx, CSV, TXT, MD)
// shown as chips with name and size, extracted locally, and rendered in chat bubbles.
[Collection("DarkTheme palette")]
public class DocumentAttachmentTests
{
    [Theory]
    [InlineData("report.pdf", true)]
    [InlineData("DOC.DOCX", true)]
    [InlineData("sheet.xlsx", true)]
    [InlineData("presentation.pptx", true)]
    [InlineData("data.csv", true)]
    [InlineData("notes.txt", true)]
    [InlineData("README.MD", true)]
    [InlineData("script.py", false)]
    [InlineData("archive.zip", false)]
    [InlineData("app.exe", false)]
    [InlineData("image.png", false)]
    public void IsDocumentFile_RecognizesSupportedDocumentExtensions(string filename, bool expected)
    {
        Assert.Equal(expected, ImageAttachmentStrip.IsDocumentFile(filename));
    }

    [Theory]
    [InlineData("test.pdf", true)]
    [InlineData("photo.png", true)]
    [InlineData("calc.xlsx", true)]
    [InlineData("program.exe", false)]
    public void IsSupportedFile_AcceptsBothImagesAndDocuments(string filename, bool expected)
    {
        Assert.Equal(expected, ImageAttachmentStrip.IsSupportedFile(filename));
    }

    [Theory]
    [InlineData(500, "500 B")]
    [InlineData(1024, "1.0 KB")]
    [InlineData(2048, "2.0 KB")]
    [InlineData(1048576, "1.0 MB")]
    [InlineData(5242880, "5.0 MB")]
    public void FormatFileSize_FormatsUnitsAppropriately(long bytes, string expected)
    {
        Assert.Equal(expected, ImageAttachmentStrip.FormatFileSize(bytes));
    }

    [Fact]
    public void Strip_AddsDocumentFileChipsAndExposesDocumentPaths()
    {
        DarkTheme.ApplyPreset("violet", null);
        using var strip = new ImageAttachmentStrip();
        var tempFile = Path.Combine(Path.GetTempPath(), $"mana_test_{Guid.NewGuid():N}.docx");
        try
        {
            File.WriteAllText(tempFile, "hello world docx content");

            Assert.True(strip.AddDocumentFile(tempFile));
            Assert.True(strip.Visible);
            Assert.Equal(1, strip.Count);
            Assert.Single(strip.Documents);
            Assert.Equal(tempFile, strip.Documents[0]);
            Assert.Empty(strip.Images);

            strip.Clear();
            Assert.Equal(0, strip.Count);
            Assert.Empty(strip.Documents);
            Assert.False(strip.Visible);
        }
        finally
        {
            if (File.Exists(tempFile))
            {
                File.Delete(tempFile);
            }
        }
    }

    [Fact]
    public void Strip_AddFile_RoutesImagesAndDocumentsProperly()
    {
        DarkTheme.ApplyPreset("violet", null);
        using var strip = new ImageAttachmentStrip();
        var tempDoc = Path.Combine(Path.GetTempPath(), $"doc_{Guid.NewGuid():N}.pdf");
        var tempImg = Path.Combine(Path.GetTempPath(), $"img_{Guid.NewGuid():N}.png");
        try
        {
            File.WriteAllText(tempDoc, "%PDF-1.4 dummy");
            using (var bmp = new Bitmap(10, 10))
            {
                bmp.Save(tempImg, System.Drawing.Imaging.ImageFormat.Png);
            }

            strip.AddFile(tempDoc);
            strip.AddFile(tempImg);

            Assert.Equal(2, strip.Count);
            Assert.Single(strip.Documents);
            Assert.Equal(tempDoc, strip.Documents[0]);
            Assert.Single(strip.Images);
            Assert.StartsWith("data:image/jpeg;base64,", strip.Images[0]);
        }
        finally
        {
            if (File.Exists(tempDoc)) File.Delete(tempDoc);
            if (File.Exists(tempImg)) File.Delete(tempImg);
        }
    }

    [Fact]
    public void ChatView_AppendsDocumentAttachmentsAsBlocks()
    {
        DarkTheme.ApplyPreset("violet", null);
        using var view = new ChatView { Dock = System.Windows.Forms.DockStyle.None, Size = new Size(700, 500) };
        view.CreateControl();

        var tempDoc = Path.Combine(Path.GetTempPath(), $"specs_{Guid.NewGuid():N}.pdf");
        try
        {
            File.WriteAllBytes(tempDoc, new byte[2048]);

            view.AppendUserMessage("Here is the doc", Array.Empty<string>(), new[] { tempDoc });

            var message = view.Messages.Single();
            Assert.True(message.Blocks.Count >= 2);
            var firstBlock = message.Blocks[0];
            Assert.Contains(Path.GetFileName(tempDoc), firstBlock.Runs[0].Text);
            Assert.Contains("2.0 KB", firstBlock.Runs[0].Text);
            Assert.Contains("📎", firstBlock.Runs[0].Text);
        }
        finally
        {
            if (File.Exists(tempDoc)) File.Delete(tempDoc);
        }
    }

    private sealed class CaptureHandler : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; private set; }
        public string? LastPayload { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            if (request.Content != null)
            {
                LastPayload = await request.Content.ReadAsStringAsync(cancellationToken);
            }

            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"type\":\"final\",\"reply\":\"acknowledged\"}\n")
            };
            return response;
        }
    }

    [Fact]
    public async Task ReplyStreamAsync_SendsDocumentsFieldInPayload()
    {
        var handler = new CaptureHandler();
        var backend = new ManaBackendClient(handler);

        var docList = new[] { @"C:\docs\budget.xlsx", @"C:\docs\presentation.pptx" };
        var events = await backend.ReplyStreamAsync("Analyze these", documents: docList).ToListAsync();

        Assert.Single(events);
        Assert.Equal("acknowledged", events[0].Reply);
        Assert.NotNull(handler.LastPayload);

        using var json = JsonDocument.Parse(handler.LastPayload);
        var root = json.RootElement;
        Assert.True(root.TryGetProperty("documents", out var docsEl));
        Assert.Equal(JsonValueKind.Array, docsEl.ValueKind);
        var docs = docsEl.EnumerateArray().Select(e => e.GetString()).ToArray();
        Assert.Equal(docList, docs);
    }
}
