using System.Drawing;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ScreenOcrGateTests
{
    private static readonly IntPtr Window = new(0x1234);

    [Fact]
    public async Task ReadAsync_TwoReadsOfAnUnchangedScreenRunOcrOnce()
    {
        var gate = new ScreenOcrGate();
        var ocrRuns = 0;
        Task<string> Ocr() { ocrRuns++; return Task.FromResult("inventory full"); }
        var hash = new ulong[] { 1, 2 };

        var first = await gate.ReadAsync(Window, hash, Ocr);
        var second = await gate.ReadAsync(Window, new ulong[] { 1, 2 }, Ocr);

        Assert.Equal(1, ocrRuns);
        Assert.Equal("inventory full", first);
        Assert.Equal("inventory full", second);
    }

    [Fact]
    public async Task ReadAsync_RerunsOcrWhenTheHashOrTheWindowChanges()
    {
        var gate = new ScreenOcrGate();
        var ocrRuns = 0;
        Task<string> Ocr() { ocrRuns++; return Task.FromResult($"read {ocrRuns}"); }

        await gate.ReadAsync(Window, new ulong[] { 1 }, Ocr);
        var changedScreen = await gate.ReadAsync(Window, new ulong[] { 2 }, Ocr);
        var otherWindow = await gate.ReadAsync(new IntPtr(0x5678), new ulong[] { 2 }, Ocr);

        Assert.Equal("read 2", changedScreen);
        Assert.Equal("read 3", otherWindow);
    }

    [Fact]
    public async Task ReadAsync_AFailedOcrIsNotCached()
    {
        var gate = new ScreenOcrGate();
        var hash = new ulong[] { 1 };

        await Assert.ThrowsAsync<HttpRequestException>(() => gate.ReadAsync(Window, hash, () => throw new HttpRequestException()));
        var retried = await gate.ReadAsync(Window, hash, () => Task.FromResult("ok"));

        Assert.Equal("ok", retried);
    }

    [Fact]
    public void DifferenceHash_SameForIdenticalCapturesAndDifferentWhenTextChanges()
    {
        using var before = Screenshot(withExtraLine: false);
        using var same = Screenshot(withExtraLine: false);
        using var after = Screenshot(withExtraLine: true);

        Assert.Equal(ScreenOcrGate.DifferenceHash(before), ScreenOcrGate.DifferenceHash(same));
        Assert.NotEqual(ScreenOcrGate.DifferenceHash(before), ScreenOcrGate.DifferenceHash(after));
    }

    [Fact]
    public void DifferenceHash_ChangesWhenASingleNumberChanges()
    {
        using var before = Screenshot(withExtraLine: false, hp: "HP 41230");
        using var after = Screenshot(withExtraLine: false, hp: "HP 41730");

        Assert.NotEqual(ScreenOcrGate.DifferenceHash(before), ScreenOcrGate.DifferenceHash(after));
    }

    // A fake 1280x720 "window" with a few lines of chat text; one extra
    // line stands in for a new chat message arriving.
    private static Bitmap Screenshot(bool withExtraLine, string hp = "HP 41230")
    {
        var bitmap = new Bitmap(1280, 720);
        using var g = Graphics.FromImage(bitmap);
        using var font = new Font(FontFamily.GenericSansSerif, 14);
        g.Clear(Color.White);
        for (var line = 0; line < 5; line++)
        {
            g.DrawString($"Party member {line}: ready for the next pull", font, Brushes.Black, 20, 20 + line * 30);
        }
        g.DrawString(hp, font, Brushes.Black, 900, 400);
        if (withExtraLine)
        {
            g.DrawString("Tank: pulling in 5", font, Brushes.Black, 200, 170);
        }
        return bitmap;
    }
}
