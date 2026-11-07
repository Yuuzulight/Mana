using SkiaSharp;

namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: renders a CubismModel's current drawable state to an
// off-screen SKBitmap using SkiaSharp's software rasterizer -- no GPU/
// OpenGL dependency, a small avatar at a modest frame rate doesn't need
// one. AvatarOverlayForm pushes the result to its layered window each
// frame.
//
// Clipping masks (e.g. an iris clipped to its eye-white) are drawn the
// way Live2D's own renderers draw them, by the mask meshes' texture alpha:
// the masked mesh goes into a layer and the masks are drawn over it with
// DstIn (DstOut when inverted). An earlier convex-hull clip path was close
// enough for Hiyori but not for detailed models (#1518): DeepSeek-chan's
// mouth came out dashed and skin showed past her cheeks.
//
// Coordinate conversion (model space -> pixels, Cubism's Y-up to Skia's
// Y-down) follows Cubism's documented canvas-info convention as best
// understood here -- verified against a real rendered frame, not taken on
// faith (see native/cubism-core/README.md's own note on this).
internal sealed class CubismRenderer : IDisposable
{
    // Per texture, a mip chain: [0] is the decoded atlas, each next level
    // half the size, down to ~64px. The overlay shows these 2048px atlases
    // shrunk ~10x, and sampling the full-size one at that scale picks
    // single stray texels (dark line-art pixels) as specks. Skia's
    // DrawVertices ignores SKMipmapMode -- it picks the mip level from the
    // canvas matrix, which is 1:1 here, not from the UV mapping -- so the
    // level is chosen per drawable in Batch.Add instead.
    private readonly SKSizeI[][] levelSizes;
    private readonly SKImage[][] levelImages;
    // Built once, not per-drawable-per-frame -- re-wrapping a texture in a
    // fresh SKShader on every draw call (this runs at ~60fps indefinitely)
    // would leak a native shader object every time; SKPaint.Shader below
    // only ever borrows these, it doesn't own/dispose them.
    private readonly SKShader[][] levelShaders;
    private static readonly SKSamplingOptions Sampling = new(SKFilterMode.Linear);

    // Atlases are cut down to this on their longer side. The avatar never shows a model anywhere near its atlas size,
    // so bigger levels are never sampled; DeepSeek-chan's 8192px atlases took ~0.9 GB at full size (#1518).
    internal const int MaxTextureSide = 4096;

    // Canvas pixel row of the top of her head in the first frame drawn, where a closer framing starts. Taken once,
    // so her hair swaying doesn't move the crop.
    private float? figureTop;

    public CubismRenderer(IReadOnlyList<string> texturePaths)
    {
        levelSizes = new SKSizeI[texturePaths.Count][];
        levelImages = new SKImage[texturePaths.Count][];
        levelShaders = new SKShader[texturePaths.Count][];
        for (var i = 0; i < texturePaths.Count; i++)
        {
            var levels = new List<SKBitmap>
            {
                SKBitmap.Decode(texturePaths[i]) ?? throw new InvalidDataException($"failed to decode texture: {texturePaths[i]}"),
            };
            while (Math.Min(levels[^1].Width, levels[^1].Height) >= 128)
            {
                var previous = levels[^1];
                // Linear sampling at exactly half size averages each 2x2 block.
                levels.Add(previous.Resize(new SKImageInfo(previous.Width / 2, previous.Height / 2, previous.ColorType, previous.AlphaType), Sampling)
                    ?? throw new InvalidDataException($"failed to downscale texture: {texturePaths[i]}"));
                if (Math.Max(previous.Width, previous.Height) > MaxTextureSide)
                {
                    previous.Dispose();
                    levels.RemoveAt(levels.Count - 2);
                }
            }
            levelSizes[i] = levels.Select(l => new SKSizeI(l.Width, l.Height)).ToArray();
            // Immutable, so the image shares the bitmap's pixels instead of copying them.
            levelImages[i] = levels.Select(l =>
            {
                l.SetImmutable();
                var image = SKImage.FromBitmap(l);
                l.Dispose();
                return image;
            }).ToArray();
            levelShaders[i] = levelImages[i].Select(l => l.ToShader(SKShaderTileMode.Clamp, SKShaderTileMode.Clamp, Sampling)).ToArray();
        }
    }

    internal SKSizeI TextureSize(int texture) => levelSizes[texture][0];

    // heightFraction (#685): how much of the model's height to show, from
    // the top -- 1 is the whole model; see Fit.
    public SKBitmap Render(CubismModel model, int width, int height, SKColor background, float heightFraction = 1f)
    {
        model.ReadCanvasInfo(out var sizeInPixels, out var originInPixels, out var pixelsPerUnit);
        return Render(model.GetDrawables(), new CanvasInfo(sizeInPixels, originInPixels, pixelsPerUnit), width, height, background, heightFraction);
    }

    // csmReadCanvasInfo's three values.
    internal readonly record struct CanvasInfo(CubismCoreNative.Vector2 SizeInPixels, CubismCoreNative.Vector2 OriginInPixels, float PixelsPerUnit);

    // Draws a snapshot of the model's drawables (GetDrawables copies them), so this can run off the thread that animates the model.
    internal SKBitmap Render(IReadOnlyList<CubismModel.Drawable> drawables, CanvasInfo canvasInfo, int width, int height, SKColor background, float heightFraction = 1f)
    {
        var bitmap = new SKBitmap(width, height);
        using var canvas = new SKCanvas(bitmap);
        Draw(canvas, drawables, canvasInfo, width, height, background, heightFraction);
        return bitmap;
    }

    internal void Draw(SKCanvas canvas, IReadOnlyList<CubismModel.Drawable> drawables, CanvasInfo canvasInfo, int width, int height, SKColor background, float heightFraction = 1f)
    {
        var (sizeInPixels, originInPixels, pixelsPerUnit) = canvasInfo;
        if (heightFraction < 1f)
        {
            figureTop ??= FigureTop(drawables, originInPixels, pixelsPerUnit);
        }
        var (scale, offsetX, offsetY) = Fit(sizeInPixels.X, sizeInPixels.Y, width, height, heightFraction, figureTop ?? 0f);

        // Screen-space points for every drawable, keyed by its index in
        // `drawables` -- computed up front, before drawing anything, so a
        // masked drawable can look up its mask sources' geometry
        // regardless of draw order (a mask source doesn't have to be
        // drawn before the drawable it masks; it's a source of shape
        // data, not a prior render pass).
        var screenPoints = new SKPoint[drawables.Count][];
        for (var i = 0; i < drawables.Count; i++)
        {
            screenPoints[i] = ToScreenPoints(drawables[i].VertexPositions, originInPixels, pixelsPerUnit, scale, offsetX, offsetY);
        }

        {
            canvas.Clear(background);

            // Sorts by RenderOrder, NOT DrawOrder -- DrawOrder is the
            // coarse per-drawable "layer" value an artist sets in the
            // editor and commonly ties across many drawables (confirmed
            // against hiyori_free's real eye masks: both eyes' iris/
            // eye-white pairs share one DrawOrder value each). Sorting by
            // DrawOrder alone, with any tiebreak (stable or not), isn't
            // enough -- Core computes a separate, fully disambiguated
            // RenderOrder per drawable specifically to resolve this; using
            // it instead of hand-rolling a tiebreak is what actually fixed
            // a real missing-iris bug (a same-DrawOrder eye-white drawn
            // after, and so painting over, its own iris).
            var drawOrder = Enumerable.Range(0, drawables.Count).OrderBy(i => drawables[i].RenderOrder).ToList();

            var batch = new Batch(this, canvas);
            for (var k = 0; k < drawOrder.Count; k++)
            {
                var i = drawOrder[k];
                var drawable = drawables[i];
                if (!IsDrawn(drawable))
                {
                    continue;
                }
                if (drawable.MaskDrawableIndices.Length == 0)
                {
                    batch.Add(drawable, screenPoints[i], BlendOf(drawable));
                    continue;
                }

                // Live2D's clipping: the mesh goes into a layer, which keeps it only where its mask meshes' own art is
                // (their texture's alpha, not their opacity or visibility -- an invisible mesh still masks), or only
                // where it isn't for an inverted mask; then the layer blends down the way the mesh itself would.
                // The meshes drawn next under the same masks share the layer (an iris, its pupil and highlight under
                // one eye-white): a layer is the costly part, and DeepSeek-chan has 123 masked meshes.
                var run = new List<int> { i };
                var bounds = Bounds(screenPoints[i]);
                while (k + 1 < drawOrder.Count)
                {
                    var next = drawables[drawOrder[k + 1]];
                    if (IsDrawn(next) && !SharesMasks(next, drawable))
                    {
                        break;
                    }
                    k++;
                    if (IsDrawn(next))
                    {
                        run.Add(drawOrder[k]);
                        bounds.Union(Bounds(screenPoints[drawOrder[k]]));
                    }
                }
                using var blend = new SKPaint { BlendMode = BlendOf(drawable) };
                using var keep = new SKPaint { BlendMode = drawable.IsInvertedMask ? SKBlendMode.DstOut : SKBlendMode.DstIn };
                batch.Flush();
                canvas.SaveLayer(bounds, blend);
                foreach (var j in run)
                {
                    batch.Add(drawables[j], screenPoints[j], SKBlendMode.SrcOver);
                }
                batch.Flush();
                canvas.SaveLayer(bounds, keep);
                foreach (var maskIndex in drawable.MaskDrawableIndices)
                {
                    if (maskIndex >= 0 && maskIndex < drawables.Count)
                    {
                        batch.Add(drawables[maskIndex], screenPoints[maskIndex], SKBlendMode.SrcOver, asMask: true);
                    }
                }
                batch.Flush();
                canvas.Restore();
                canvas.Restore();
            }
            batch.Flush();
        }
    }

    // Fits the model's canvas into width x height. heightFraction >= 1: the
    // whole canvas, aspect preserved, centred. Below 1 (#685's waist/bust
    // framing, Electron's computeZoomFraming in live2d-logic.js): the top
    // fraction of the model fills the height under a 4% top margin, centred
    // horizontally, and the rest is cropped off the bottom.
    internal const float TopMargin = 0.04f;

    // A framing under 1 shows heightFraction of the canvas height from figureTop (a canvas pixel row) down.
    internal static (float Scale, float OffsetX, float OffsetY) Fit(float canvasWidth, float canvasHeight, int width, int height, float heightFraction, float figureTop = 0f)
    {
        var valid = canvasWidth > 0 && canvasHeight > 0;
        if (heightFraction >= 1f || !valid)
        {
            var fitScale = valid ? Math.Min(width / canvasWidth, height / canvasHeight) : 1f;
            return (fitScale, (width - canvasWidth * fitScale) / 2f, (height - canvasHeight * fitScale) / 2f);
        }
        var topMargin = height * TopMargin;
        var scale = (height - topMargin) / (canvasHeight * Math.Max(0.05f, heightFraction));
        return (scale, (width - canvasWidth * scale) / 2f, topMargin - figureTop * scale);
    }

    private static float FigureTop(IReadOnlyList<CubismModel.Drawable> drawables, CubismCoreNative.Vector2 originInPixels, float pixelsPerUnit)
    {
        var top = float.MaxValue;
        foreach (var drawable in drawables)
        {
            if (IsDrawn(drawable))
            {
                foreach (var v in drawable.VertexPositions)
                {
                    top = Math.Min(top, originInPixels.Y - v.Y * pixelsPerUnit);
                }
            }
        }
        return top == float.MaxValue ? 0f : Math.Max(0f, top);
    }

    private static SKRect Bounds(SKPoint[] points)
    {
        float minX = float.MaxValue, minY = float.MaxValue, maxX = float.MinValue, maxY = float.MinValue;
        foreach (var p in points)
        {
            minX = Math.Min(minX, p.X); maxX = Math.Max(maxX, p.X);
            minY = Math.Min(minY, p.Y); maxY = Math.Max(maxY, p.Y);
        }
        return new SKRect(MathF.Floor(minX) - 1, MathF.Floor(minY) - 1, MathF.Ceiling(maxX) + 1, MathF.Ceiling(maxY) + 1);
    }

    private static bool IsDrawn(CubismModel.Drawable drawable) =>
        drawable.IsVisible && drawable.Opacity > 0f && drawable.VertexPositions.Length > 0;

    private static bool SharesMasks(CubismModel.Drawable a, CubismModel.Drawable b) =>
        a.IsInvertedMask == b.IsInvertedMask && BlendOf(a) == BlendOf(b) && a.MaskDrawableIndices.AsSpan().SequenceEqual(b.MaskDrawableIndices);

    private static SKBlendMode BlendOf(CubismModel.Drawable drawable) =>
        drawable.IsAdditiveBlend ? SKBlendMode.Plus : drawable.IsMultiplicativeBlend ? SKBlendMode.Multiply : SKBlendMode.SrcOver;

    private static SKPoint[] ToScreenPoints(
        CubismCoreNative.Vector2[] modelVertices,
        CubismCoreNative.Vector2 originInPixels,
        float pixelsPerUnit,
        float scale,
        float offsetX,
        float offsetY)
    {
        var points = new SKPoint[modelVertices.Length];
        for (var i = 0; i < modelVertices.Length; i++)
        {
            var v = modelVertices[i];
            // Model space (Y-up) -> pixel space (Y-down): flip Y around
            // the canvas origin, per Cubism's documented canvas-info
            // convention.
            var pixelX = originInPixels.X + v.X * pixelsPerUnit;
            var pixelY = originInPixels.Y - v.Y * pixelsPerUnit;
            points[i] = new SKPoint(offsetX + pixelX * scale, offsetY + pixelY * scale);
        }
        return points;
    }

    // Consecutive meshes with the same texture, mip level, tint and blend go to Skia as one DrawVertices call (#1518):
    // each call has a fixed cost, DeepSeek-chan draws 460 meshes a frame, and the triangles of one call still draw in
    // order. Each mesh's opacity rides on its vertex colours.
    private sealed class Batch(CubismRenderer renderer, SKCanvas canvas)
    {
        private readonly List<SKPoint> positions = [];
        private readonly List<SKPoint> uvs = [];
        private readonly List<SKColor> colors = [];
        private readonly List<ushort> indices = [];
        private (int Texture, int Level, (float, float, float) Multiply, (float, float, float) Screen, SKBlendMode Blend) key;

        // asMask: drawn as a clipping mask -- only its texture's alpha counts, so no opacity or tint.
        public void Add(CubismModel.Drawable drawable, SKPoint[] points, SKBlendMode blend, bool asMask = false)
        {
            if (drawable.TextureIndex < 0 || drawable.TextureIndex >= renderer.levelSizes.Length || points.Length == 0)
            {
                return;
            }
            var levels = renderer.levelSizes[drawable.TextureIndex];
            var level = MipLevel(points, drawable.VertexUvs, levels[0].Width, levels[0].Height, levels.Length);
            var next = (drawable.TextureIndex, level,
                asMask ? (1f, 1f, 1f) : drawable.MultiplyColor, asMask ? (0f, 0f, 0f) : drawable.ScreenColor, blend);
            if (positions.Count > 0 && (next != key || positions.Count + points.Length > ushort.MaxValue))
            {
                Flush();
            }
            key = next;

            var texture = levels[level];
            var first = positions.Count;
            var color = new SKColor(255, 255, 255, asMask ? (byte)255 : (byte)Math.Clamp(drawable.Opacity * 255f, 0f, 255f));
            positions.AddRange(points);
            foreach (var uv in drawable.VertexUvs)
            {
                // Same Y-flip as vertex positions -- Cubism/OpenGL-style UVs
                // put (0,0) at the texture's bottom-left; raster image data
                // (and Skia) puts it at the top-left.
                uvs.Add(new SKPoint(uv.X * texture.Width, (1f - uv.Y) * texture.Height));
                colors.Add(color);
            }
            foreach (var index in drawable.Indices)
            {
                indices.Add((ushort)(first + index));
            }
        }

        public void Flush()
        {
            if (positions.Count == 0)
            {
                return;
            }
            using var vertices = SKVertices.CreateCopy(SKVertexMode.Triangles, positions.ToArray(), uvs.ToArray(), colors.ToArray(), indices.ToArray());
            using var tint = TintMatrix(key.Multiply, key.Screen) is { } matrix ? SKColorFilter.CreateColorMatrix(matrix) : null;
            using var paint = new SKPaint
            {
                Shader = renderer.levelShaders[key.Texture][key.Level], // borrowed, not owned -- see the field's own comment
                BlendMode = key.Blend,
                ColorFilter = tint,
            };
            // Modulate: the texture times the vertex colour, i.e. each mesh's opacity.
            canvas.DrawVertices(vertices, SKBlendMode.Modulate, paint);
            positions.Clear();
            uvs.Clear();
            colors.Clear();
            indices.Clear();
        }
    }

    // A drawable's multiply-then-screen tint as a colour matrix (on unpremultiplied colour, translation in 0..1):
    // c' = c * m * (1 - s) + s, i.e. 1 - (1 - c*m)(1 - s). Null when the drawable isn't tinted.
    internal static float[]? TintMatrix((float R, float G, float B) multiply, (float R, float G, float B) screen)
    {
        if (multiply == (1f, 1f, 1f) && screen == (0f, 0f, 0f))
        {
            return null;
        }
        return
        [
            multiply.R * (1 - screen.R), 0, 0, 0, screen.R,
            0, multiply.G * (1 - screen.G), 0, 0, screen.G,
            0, 0, multiply.B * (1 - screen.B), 0, screen.B,
            0, 0, 0, 1, 0,
        ];
    }

    // How many halvings the drawable's texture region is shrunk by on
    // screen: log2 of texels per screen pixel along its more-shrunk axis
    // (what a GPU's mip selection uses), floored to keep detail.
    private static int MipLevel(SKPoint[] points, CubismCoreNative.Vector2[] uvs, int textureWidth, int textureHeight, int levelCount)
    {
        if (points.Length == 0 || uvs.Length == 0)
        {
            return 0;
        }
        float minX = float.MaxValue, minY = float.MaxValue, maxX = float.MinValue, maxY = float.MinValue;
        foreach (var p in points)
        {
            minX = Math.Min(minX, p.X); maxX = Math.Max(maxX, p.X);
            minY = Math.Min(minY, p.Y); maxY = Math.Max(maxY, p.Y);
        }
        float minU = float.MaxValue, minV = float.MaxValue, maxU = float.MinValue, maxV = float.MinValue;
        foreach (var uv in uvs)
        {
            minU = Math.Min(minU, uv.X); maxU = Math.Max(maxU, uv.X);
            minV = Math.Min(minV, uv.Y); maxV = Math.Max(maxV, uv.Y);
        }
        var ratio = Math.Max(
            (maxU - minU) * textureWidth / Math.Max(maxX - minX, 1e-3f),
            (maxV - minV) * textureHeight / Math.Max(maxY - minY, 1e-3f));
        return ratio <= 1 ? 0 : Math.Clamp((int)Math.Log2(ratio), 0, levelCount - 1);
    }

    public void Dispose()
    {
        foreach (var shader in levelShaders.SelectMany(s => s))
        {
            shader?.Dispose();
        }
        foreach (var image in levelImages.SelectMany(t => t))
        {
            image?.Dispose();
        }
    }
}
