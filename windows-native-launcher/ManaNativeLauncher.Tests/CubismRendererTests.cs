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
            "windows-launcher", "avatar", "test-models", "hiyori_free", "runtime", "hiyori_free_t08.model3.json");
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

    // A mesh's multiply and screen colours (Cubism 4.2+): multiply first, then screen, as Live2D's own renderer does.
    // A multiply of black with a skin-tone screen turns a mesh into a flat skin-tone patch whatever its texture.
    [Theory]
    [InlineData(0f, 0f, 0f, 1f, 0.9f, 0.8f, 0.0f, 0.0f, 0.0f, 1f, 0.9f, 0.8f)] // black ring -> skin patch
    [InlineData(0f, 0f, 0f, 1f, 0.9f, 0.8f, 1f, 1f, 1f, 1f, 0.9f, 0.8f)] // white centre -> skin patch
    [InlineData(0.5f, 1f, 1f, 0f, 0f, 0f, 0.8f, 0.8f, 0.8f, 0.4f, 0.8f, 0.8f)] // multiply only
    [InlineData(1f, 1f, 1f, 0.5f, 0f, 0f, 0.5f, 0.2f, 0.2f, 0.75f, 0.2f, 0.2f)] // screen only: 1-(1-c)(1-s)
    public void Tint_MultipliesThenScreens(float mr, float mg, float mb, float sr, float sg, float sb, float r, float g, float b, float er, float eg, float eb)
    {
        var matrix = CubismRenderer.TintMatrix((mr, mg, mb), (sr, sg, sb));
        Assert.NotNull(matrix);
        float Row(int row, float c0, float c1, float c2) => matrix![row * 5] * c0 + matrix[row * 5 + 1] * c1 + matrix[row * 5 + 2] * c2 + matrix[row * 5 + 4];
        Assert.Equal(er, Row(0, r, g, b), 3);
        Assert.Equal(eg, Row(1, r, g, b), 3);
        Assert.Equal(eb, Row(2, r, g, b), 3);
        Assert.Equal(1f, matrix![18]); // alpha passes through
    }

    [Fact]
    public void Tint_IsNoneForAnUntintedMesh() => Assert.Null(CubismRenderer.TintMatrix((1f, 1f, 1f), (0f, 0f, 0f)));

    // A mask is its source's real shape, as Live2D draws it: an L-shaped eye-white doesn't let its iris show in the notch
    // (a convex outline of the L would).
    [Theory]
    [InlineData(false, 255, 0)]
    [InlineData(true, 0, 255)]
    public void Mask_IsTheSourcesRealShape(bool inverted, int insideAlpha, int notchAlpha)
    {
        using var renderer = new CubismRenderer([SolidTexture()]);
        var lShape = Mesh(0, [(0, 0, 100, 50), (0, 50, 50, 100)], visible: false);
        var masked = Mesh(0, [(0, 0, 100, 100)], masks: [0], inverted: inverted);
        using var frame = renderer.Render([lShape, masked], Canvas100, 100, 100, SKColors.Transparent);
        Assert.Equal(insideAlpha, frame.GetPixel(25, 25).Alpha);
        Assert.Equal(notchAlpha, frame.GetPixel(60, 60).Alpha);
    }

    // Meshes drawn one after another under the same mask (an iris, its pupil) are all kept to it; an unmasked mesh
    // drawn between them isn't.
    [Fact]
    public void Mask_HoldsForEveryMeshUnderItAndNoOther()
    {
        using var renderer = new CubismRenderer([SolidTexture()]);
        var lShape = Mesh(0, [(0, 0, 100, 50), (0, 50, 50, 100)], visible: false);
        var iris = Mesh(0, [(0, 0, 50, 50)], masks: [0]);
        var pupil = Mesh(0, [(50, 50, 100, 100)], masks: [0]);
        var free = Mesh(0, [(0, 90, 10, 100)]);
        var highlight = Mesh(0, [(90, 90, 100, 100)], masks: [0]);
        using var frame = renderer.Render([lShape, iris, pupil, free, highlight], Canvas100, 100, 100, SKColors.Transparent);
        Assert.Equal(255, frame.GetPixel(25, 25).Alpha);
        Assert.Equal(0, frame.GetPixel(60, 60).Alpha);
        Assert.Equal(0, frame.GetPixel(95, 95).Alpha);
        Assert.Equal(255, frame.GetPixel(5, 95).Alpha);
    }

    // ...and its texture's alpha: where the mask's own art is see-through, nothing shows.
    [Fact]
    public void Mask_FollowsItsTexturesAlpha()
    {
        using var renderer = new CubismRenderer([SolidTexture(), SolidTexture(opaqueColumns: 2)]);
        var halfSeeThrough = Mesh(1, [(0, 0, 100, 100)], visible: false);
        var masked = Mesh(0, [(0, 0, 100, 100)], masks: [0]);
        using var frame = renderer.Render([halfSeeThrough, masked], Canvas100, 100, 100, SKColors.Transparent);
        Assert.Equal(255, frame.GetPixel(12, 50).Alpha);
        Assert.Equal(0, frame.GetPixel(88, 50).Alpha);
    }

    // A closer framing starts at the top of her head, not the top of the canvas: the empty space above her is cut.
    [Fact]
    public void CloseFraming_StartsAtTheTopOfTheFigure()
    {
        using var renderer = new CubismRenderer([SolidTexture()]);
        var figure = Mesh(0, [(0, 40, 100, 100)]);
        using var frame = renderer.Render([figure], Canvas100, 100, 100, SKColors.Transparent, heightFraction: 0.5f);
        Assert.Equal(0, frame.GetPixel(50, 2).Alpha);
        Assert.Equal(255, frame.GetPixel(50, 6).Alpha);
    }

    // The render thread draws the same frame as drawing directly, on the GPU where there is one (CI has none: CPU).
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Worker_DrawsTheSameFrameOffTheUiThread(bool tryGpu)
    {
        var lShape = Mesh(0, [(0, 0, 100, 50), (0, 50, 50, 100)], visible: false);
        var masked = Mesh(0, [(0, 0, 100, 100)], masks: [0]);
        using var worker = new AvatarRenderWorker(new CubismRenderer([SolidTexture()]), tryGpu);
        var got = new TaskCompletionSource<SKBitmap[]>();
        Assert.True(worker.TrySubmit([lShape, masked], Canvas100, [new(100, 100, 1f), new(50, 50, 1f)], got.SetResult));
        Assert.True(got.Task.Wait(TimeSpan.FromSeconds(30)));
        var frames = got.Task.Result;
        try
        {
            Assert.Equal((100, 100), (frames[0].Width, frames[0].Height));
            Assert.Equal((50, 50), (frames[1].Width, frames[1].Height));
            Assert.Equal(255, frames[0].GetPixel(25, 25).Alpha);
            Assert.Equal(0, frames[0].GetPixel(60, 60).Alpha);
            Assert.Equal(new SKColor(255, 255, 255, 255), frames[0].GetPixel(25, 25));
        }
        finally
        {
            foreach (var frame in frames)
            {
                frame.Dispose();
            }
        }
        if (!tryGpu)
        {
            Assert.False(worker.UsesGpu.Result);
        }
    }

    // A huge atlas is kept at most MaxTextureSide on its longer side (DeepSeek-chan's 8192px ones took ~0.9 GB).
    [Fact]
    public void Textures_AreCutDownToTheLargestSizeShown()
    {
        using var renderer = new CubismRenderer([SolidTexture(width: 8192, height: 256), SolidTexture()]);
        Assert.Equal(new SKSizeI(CubismRenderer.MaxTextureSide, 128), renderer.TextureSize(0));
        Assert.Equal(new SKSizeI(4, 4), renderer.TextureSize(1));
    }

    // A 100x100 model canvas, one unit per pixel, model y = -pixel y.
    private static readonly CubismRenderer.CanvasInfo Canvas100 = new(new() { X = 100, Y = 100 }, new() { X = 0, Y = 0 }, 1f);

    // A white texture (4x4 by default), opaque in its first opaqueColumns columns and see-through after.
    private static string SolidTexture(int opaqueColumns = int.MaxValue, int width = 4, int height = 4)
    {
        using var bitmap = new SKBitmap(width, height);
        bitmap.Erase(SKColors.Transparent);
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < Math.Min(width, opaqueColumns); x++)
            {
                bitmap.SetPixel(x, y, SKColors.White);
            }
        }
        var path = Path.Combine(Path.GetTempPath(), $"mana-cubism-test-{Guid.NewGuid():N}.png");
        using (var stream = File.OpenWrite(path))
        {
            bitmap.Encode(stream, SKEncodedImageFormat.Png, 100);
        }
        return path;
    }

    // A mesh of axis-aligned pixel rectangles, each mapped onto the whole texture.
    private static CubismModel.Drawable Mesh(int texture, (float X0, float Y0, float X1, float Y1)[] quads, int[]? masks = null, bool inverted = false, bool visible = true)
    {
        var positions = new List<CubismCoreNative.Vector2>();
        var uvs = new List<CubismCoreNative.Vector2>();
        var indices = new List<ushort>();
        foreach (var (x0, y0, x1, y1) in quads)
        {
            var first = (ushort)positions.Count;
            foreach (var (x, y, u, v) in new[] { (x0, y0, 0f, 1f), (x1, y0, 1f, 1f), (x1, y1, 1f, 0f), (x0, y1, 0f, 0f) })
            {
                positions.Add(new() { X = x, Y = -y });
                uvs.Add(new() { X = u, Y = v });
            }
            indices.AddRange([first, (ushort)(first + 1), (ushort)(first + 2), first, (ushort)(first + 2), (ushort)(first + 3)]);
        }
        return new CubismModel.Drawable
        {
            Id = "mesh", TextureIndex = texture, Opacity = 1f, DrawOrder = 0, RenderOrder = 0, IsVisible = visible,
            IsDoubleSided = true, IsAdditiveBlend = false, IsMultiplicativeBlend = false,
            VertexPositions = positions.ToArray(), VertexUvs = uvs.ToArray(), Indices = indices.ToArray(),
            MaskDrawableIndices = masks ?? [], IsInvertedMask = inverted, MultiplyColor = (1f, 1f, 1f), ScreenColor = (0f, 0f, 0f),
        };
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
