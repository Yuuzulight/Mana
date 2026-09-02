using System;
using System.IO;
using Mana.NativeLauncher.Live2D;
using SkiaSharp;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class CubismRendererTests
{
    private static (CubismModel Model, CubismRenderer Renderer) LoadTestModelAndRenderer()
    {
        CubismCoreLibrary.IsAvailable(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var model3JsonPath = Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..",
            "windows-launcher", "avatar", "model", "hiyori_free", "runtime", "hiyori_free_t08.model3.json");
        var settings = CubismModelSettings.Load(model3JsonPath);
        var model = CubismModel.Load(settings);
        var renderer = new CubismRenderer(settings.TexturePaths);
        return (model, renderer);
    }

    [CubismAvailableFact]
    public void Render_ProducesANonBlankImageWithVariedPixels()
    {
        var (model, renderer) = LoadTestModelAndRenderer();
        using var _ = model;
        using var __ = renderer;

        model.Update();
        using var bitmap = renderer.Render(model, 468, 576, SKColors.Magenta);

        Assert.Equal(468, bitmap.Width);
        Assert.Equal(576, bitmap.Height);

        // A real rendered character should have plenty of pixel variety
        // (skin tones, hair, clothing, the magenta background peeking
        // through) -- not be solid-color or near-empty, which would mean
        // nothing actually drew (e.g. every drawable culled, a broken
        // coordinate transform putting everything off-canvas).
        var distinctColors = CountDistinctColors(bitmap, sampleStride: 4);
        Assert.True(distinctColors > 50, $"expected substantial pixel variety, got only {distinctColors} distinct sampled colors");

        var nonBackgroundPixels = CountNonBackgroundPixels(bitmap, SKColors.Magenta, sampleStride: 4);
        Assert.True(nonBackgroundPixels > 100, $"expected a substantial drawn area, got only {nonBackgroundPixels} non-background sampled pixels");
    }

    // Not a correctness assertion on its own (this repo has no reference
    // image to diff against, and rendering correctness for a textured mesh
    // needs a human looking at it) -- saves the actual render to disk so it
    // can be inspected/sent for visual confirmation. Skipped by
    // CubismAvailableFact like the rest of this file when the SDK/model
    // aren't present, so this never runs unattended in CI either way.
    [CubismAvailableFact]
    public void Render_SavesAVisualInspectionSnapshot()
    {
        var (model, renderer) = LoadTestModelAndRenderer();
        using var _ = model;
        using var __ = renderer;

        model.Update();
        using var idle = renderer.Render(model, 468, 576, SKColors.Magenta);
        SaveSnapshot(idle, "cubism-render-idle.png");

        model.SetParameterValue("ParamMouthOpenY", 1.0f);
        model.Update();
        using var talking = renderer.Render(model, 468, 576, SKColors.Magenta);
        SaveSnapshot(talking, "cubism-render-mouth-open.png");
    }

    private static void SaveSnapshot(SKBitmap bitmap, string fileName)
    {
        var outDir = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "cubism-render-snapshots");
        Directory.CreateDirectory(outDir);
        var path = Path.Combine(outDir, fileName);
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        using var stream = File.OpenWrite(path);
        data.SaveTo(stream);
    }

    private static int CountDistinctColors(SKBitmap bitmap, int sampleStride)
    {
        var seen = new HashSet<uint>();
        for (var y = 0; y < bitmap.Height; y += sampleStride)
        {
            for (var x = 0; x < bitmap.Width; x += sampleStride)
            {
                seen.Add((uint)bitmap.GetPixel(x, y));
            }
        }
        return seen.Count;
    }

    private static int CountNonBackgroundPixels(SKBitmap bitmap, SKColor background, int sampleStride)
    {
        var count = 0;
        for (var y = 0; y < bitmap.Height; y += sampleStride)
        {
            for (var x = 0; x < bitmap.Width; x += sampleStride)
            {
                if (bitmap.GetPixel(x, y) != background)
                {
                    count++;
                }
            }
        }
        return count;
    }
}
