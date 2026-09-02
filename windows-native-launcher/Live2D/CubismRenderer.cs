using SkiaSharp;

namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: renders a CubismModel's current drawable state to an
// off-screen SKBitmap using SkiaSharp's software rasterizer -- no GPU/
// OpenGL dependency, a small avatar at a modest frame rate doesn't need
// one. AvatarOverlayForm blits the result into its existing PictureBox
// each frame, reusing that control's already-working transparency/
// click-through setup rather than adding a new hosting control.
//
// Clipping masks (e.g. an iris clipped to its eye-white's outline) render
// correctly despite Core only exposing the raw mask-source drawable
// indices, not the bounding-transform machinery the Cubism Framework's own
// renderers use: since this is a software 2D rasterizer working entirely
// in screen space already, a masked drawable is clipped directly against
// an SKPath built from its mask sources' own already-computed screen-space
// triangles (SKCanvas.ClipPath) -- no offscreen alpha texture or UV
// remapping needed, unlike a GPU pipeline. Confirmed against a real,
// previously-broken case: hiyori_free's eye iris was missing (only the
// eye-white rendered) until this was added.
//
// Coordinate conversion (model space -> pixels, Cubism's Y-up to Skia's
// Y-down) follows Cubism's documented canvas-info convention as best
// understood here -- verified against a real rendered frame, not taken on
// faith (see native/cubism-core/README.md's own note on this).
internal sealed class CubismRenderer : IDisposable
{
    private readonly SKBitmap[] textures;
    // Built once here, not per-drawable-per-frame -- textures never
    // change after construction, so re-wrapping one in a fresh SKShader
    // on every RenderDrawable call (this runs at ~30fps indefinitely)
    // would leak a native shader object every time; SKPaint.Shader below
    // only ever borrows these, it doesn't own/dispose them.
    private readonly SKShader[] textureShaders;

    public CubismRenderer(IReadOnlyList<string> texturePaths)
    {
        textures = new SKBitmap[texturePaths.Count];
        textureShaders = new SKShader[texturePaths.Count];
        for (var i = 0; i < texturePaths.Count; i++)
        {
            textures[i] = SKBitmap.Decode(texturePaths[i])
                ?? throw new InvalidDataException($"failed to decode texture: {texturePaths[i]}");
            textureShaders[i] = textures[i].ToShader(SKShaderTileMode.Clamp, SKShaderTileMode.Clamp);
        }
    }

    public SKBitmap Render(CubismModel model, int width, int height, SKColor background)
    {
        model.ReadCanvasInfo(out var sizeInPixels, out var originInPixels, out var pixelsPerUnit);

        // Fit the model's own canvas into the requested output size,
        // preserving aspect ratio, centered.
        var scale = sizeInPixels.X > 0 && sizeInPixels.Y > 0
            ? Math.Min(width / sizeInPixels.X, height / sizeInPixels.Y)
            : 1f;
        var offsetX = (width - sizeInPixels.X * scale) / 2f;
        var offsetY = (height - sizeInPixels.Y * scale) / 2f;

        var drawables = model.GetDrawables();

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

        var bitmap = new SKBitmap(width, height);
        using (var canvas = new SKCanvas(bitmap))
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

            foreach (var i in drawOrder)
            {
                var drawable = drawables[i];
                if (!drawable.IsVisible || drawable.VertexPositions.Length == 0)
                {
                    continue;
                }

                var didClip = false;
                if (drawable.MaskDrawableIndices.Length > 0)
                {
                    // Disposed explicitly right after use, not left to
                    // BuildMaskPath -- it's a fresh SKPath built once per
                    // masked drawable per frame; at ~30fps this runs
                    // indefinitely, so leaving it to the GC/finalizer
                    // (SKPath wraps a native object) would leak steadily.
                    using var maskPath = BuildMaskPath(drawable.MaskDrawableIndices, drawables, screenPoints);
                    if (maskPath is not null)
                    {
                        canvas.Save();
                        canvas.ClipPath(maskPath, antialias: true);
                        didClip = true;
                    }
                }

                RenderDrawable(canvas, drawable, screenPoints[i]);

                if (didClip)
                {
                    canvas.Restore();
                }
            }
        }

        return bitmap;
    }

    // Unions every mask source's own shape into one clip path -- a
    // drawable with multiple mask sources is visible within any of them,
    // not just their intersection, matching Cubism's own semantics.
    //
    // Each mask source's shape is its CONVEX HULL, not its raw triangle
    // mesh -- deliberately, not a simplification taken lightly. Building
    // the clip path from the mesh's own triangles (via a Winding or
    // EvenOdd fill rule) is only correct if every triangle in that mesh
    // has consistent winding order; confirmed against hiyori_free's real
    // eye masks that this doesn't hold in practice (one eye's mask mesh
    // rendered as a filled clip region, the mirrored other eye's -- same
    // code path, same fill rule -- rendered as an EMPTY region and
    // silently hid its iris entirely, a classic symptom of a mirrored
    // mesh's triangle winding being flipped relative to the original).
    // A mask source in this model set is meant to bound a simple region
    // (an eye-white, a hairline) that's convex or close to it, so the
    // hull is a safe, winding-order-independent stand-in for "the area
    // this mask covers" -- verified visually against the real model
    // (native/cubism-core/README.md's own note on this class of check).
    private static SKPath? BuildMaskPath(
        int[] maskDrawableIndices,
        IReadOnlyList<CubismModel.Drawable> drawables,
        SKPoint[][] screenPoints)
    {
        SKPath? union = null;
        foreach (var maskIndex in maskDrawableIndices)
        {
            if (maskIndex < 0 || maskIndex >= drawables.Count)
            {
                continue;
            }
            var points = screenPoints[maskIndex];
            var hull = ConvexHull(points);
            if (hull.Length < 3)
            {
                continue;
            }

            var builder = new SKPathBuilder();
            builder.MoveTo(hull[0]);
            for (var i = 1; i < hull.Length; i++)
            {
                builder.LineTo(hull[i]);
            }
            builder.Close();
            var path = builder.Detach();

            if (union is null)
            {
                union = path;
            }
            else
            {
                using var previous = union;
                union = previous.Op(path, SKPathOp.Union) ?? previous;
                path.Dispose();
            }
        }
        return union;
    }

    // Standard monotone-chain convex hull (Andrew's algorithm). Returns
    // points in counter-clockwise order, deduplicated; fewer than 3 points
    // in means a degenerate (empty/collinear) input, returned as-is for
    // the caller to reject.
    private static SKPoint[] ConvexHull(SKPoint[] points)
    {
        if (points.Length < 3)
        {
            return points;
        }

        var sorted = points
            .Distinct()
            .OrderBy(p => p.X)
            .ThenBy(p => p.Y)
            .ToArray();
        if (sorted.Length < 3)
        {
            return sorted;
        }

        static double Cross(SKPoint o, SKPoint a, SKPoint b) =>
            ((double)a.X - o.X) * (b.Y - o.Y) - ((double)a.Y - o.Y) * (b.X - o.X);

        var lower = new List<SKPoint>();
        foreach (var p in sorted)
        {
            while (lower.Count >= 2 && Cross(lower[^2], lower[^1], p) <= 0)
            {
                lower.RemoveAt(lower.Count - 1);
            }
            lower.Add(p);
        }

        var upper = new List<SKPoint>();
        for (var i = sorted.Length - 1; i >= 0; i--)
        {
            var p = sorted[i];
            while (upper.Count >= 2 && Cross(upper[^2], upper[^1], p) <= 0)
            {
                upper.RemoveAt(upper.Count - 1);
            }
            upper.Add(p);
        }

        lower.RemoveAt(lower.Count - 1);
        upper.RemoveAt(upper.Count - 1);
        lower.AddRange(upper);
        return lower.ToArray();
    }

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

    private void RenderDrawable(SKCanvas canvas, CubismModel.Drawable drawable, SKPoint[] points)
    {
        if (drawable.TextureIndex < 0 || drawable.TextureIndex >= textures.Length)
        {
            return;
        }

        var texture = textures[drawable.TextureIndex];
        var uvs = new SKPoint[drawable.VertexUvs.Length];
        for (var i = 0; i < drawable.VertexUvs.Length; i++)
        {
            // Same Y-flip as vertex positions -- Cubism/OpenGL-style UVs
            // put (0,0) at the texture's bottom-left; raster image data
            // (and Skia) puts it at the top-left.
            var uv = drawable.VertexUvs[i];
            uvs[i] = new SKPoint(uv.X * texture.Width, (1f - uv.Y) * texture.Height);
        }

        using var vertices = SKVertices.CreateCopy(SKVertexMode.Triangles, points, uvs, colors: null, drawable.Indices);
        using var paint = new SKPaint
        {
            Shader = textureShaders[drawable.TextureIndex], // borrowed, not owned -- see the field's own comment
            Color = new SKColor(255, 255, 255, (byte)Math.Clamp(drawable.Opacity * 255f, 0f, 255f)),
            BlendMode = drawable.IsAdditiveBlend
                ? SKBlendMode.Plus
                : drawable.IsMultiplicativeBlend
                    ? SKBlendMode.Multiply
                    : SKBlendMode.SrcOver,
        };

        // Dst: no per-vertex colors are supplied (colors: null above), so
        // this tells DrawVertices to use the paint's shader/color as-is
        // rather than trying to blend against nonexistent vertex colors.
        canvas.DrawVertices(vertices, SKBlendMode.Dst, paint);
    }

    public void Dispose()
    {
        foreach (var shader in textureShaders)
        {
            shader?.Dispose();
        }
        foreach (var texture in textures)
        {
            texture?.Dispose();
        }
    }
}
