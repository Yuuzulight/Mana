using System.Runtime.InteropServices;

namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: a loaded, animatable Cubism model -- owns the
// aligned native memory Cubism Core requires (csmReviveMocInPlace/
// csmInitializeModelInPlace write in place into caller-provided buffers,
// so this class allocates and frees them itself rather than letting Core
// manage its own memory), and exposes the subset of the model Core API
// this project actually needs: parameters (get/set by ID, for driving
// mouth-openness/mouth-form from LipSyncAnalyzer and expression parameters
// from ReplyEmotionDetector) and drawables (for CubismRenderer's textured
// mesh rendering).
//
// Deliberately out of scope: motion playback (.motion3.json, #515) and
// physics simulation (.physics3.json) -- Cubism Framework concerns (the
// open-source C++ layer built on top of Core), not part of Core itself,
// and a separate, much larger undertaking; this class only drives whatever
// parameters are set on it directly and renders the resulting mesh.
// Expression blending (.exp3.json, #514) IS implemented, just outside
// this class -- see CubismExpressionFile, which applies its own parameter
// deltas via this class's SetParameterValue/GetParameterDefaultValue.
internal sealed unsafe class CubismModel : IDisposable
{
    public readonly struct Drawable
    {
        public required string Id { get; init; }
        public required int TextureIndex { get; init; }
        public required float Opacity { get; init; }
        public required int DrawOrder { get; init; }
        // The actual, fully tie-broken render sequence -- what
        // CubismRenderer sorts by. See csmGetRenderOrders' own comment
        // for why this exists separately from DrawOrder.
        public required int RenderOrder { get; init; }
        public required bool IsVisible { get; init; }
        public required bool IsDoubleSided { get; init; }
        public required bool IsAdditiveBlend { get; init; }
        public required bool IsMultiplicativeBlend { get; init; }
        public required CubismCoreNative.Vector2[] VertexPositions { get; init; }
        public required CubismCoreNative.Vector2[] VertexUvs { get; init; }
        public required ushort[] Indices { get; init; }
        // Indices (into the same drawable list GetDrawables() returns) of
        // this drawable's clipping-mask sources -- empty if unmasked. This
        // drawable should only render within the union of those drawables'
        // own shapes (e.g. an iris clipped to its eye-white's outline).
        public required int[] MaskDrawableIndices { get; init; }
    }

    private nint mocBuffer;
    private nint modelBuffer;
    private nint model;
    private readonly Dictionary<string, int> parameterIndexById;
    private readonly string[] drawableIds;
    private readonly int[] drawableTextureIndices;

    private CubismModel(nint mocBuffer, nint modelBuffer, nint model)
    {
        this.mocBuffer = mocBuffer;
        this.modelBuffer = modelBuffer;
        this.model = model;

        var parameterIds = ReadStringArray(CubismCoreNative.csmGetParameterIds(model), CubismCoreNative.csmGetParameterCount(model));
        parameterIndexById = new Dictionary<string, int>(parameterIds.Length);
        for (var i = 0; i < parameterIds.Length; i++)
        {
            parameterIndexById[parameterIds[i]] = i;
        }

        var drawableCount = CubismCoreNative.csmGetDrawableCount(model);
        drawableIds = ReadStringArray(CubismCoreNative.csmGetDrawableIds(model), drawableCount);
        drawableTextureIndices = ReadInt32Array(CubismCoreNative.csmGetDrawableTextureIndices(model), drawableCount);
    }

    // Reads the whole .moc3 file, allocates the aligned buffers Core
    // requires, and instantiates a model from it. Throws InvalidDataException
    // if the file fails Core's own consistency check or fails to revive --
    // both indicate a corrupt/incompatible .moc3, not a bug in this class.
    public static CubismModel Load(CubismModelSettings settings)
    {
        var mocBytes = File.ReadAllBytes(settings.MocPath);
        var mocSize = (uint)mocBytes.Length;

        // Both buffers are tracked as nullable locals and only freed in the
        // finally block if still non-null -- set to null right before the
        // successful return, transferring ownership to the constructed
        // CubismModel (which frees them itself in Dispose). This is the one
        // finally block covering every failure path after either
        // allocation, including ones that previously leaked mocBuffer
        // (e.g. csmInitializeModelInPlace failing) when each buffer had its
        // own separate try/finally instead.
        var mocBuffer = NativeMemory.AlignedAlloc((nuint)mocSize, CubismCoreNative.AlignofMoc);
        void* modelBuffer = null;
        try
        {
            var mocBufferPtr = (nint)mocBuffer;
            Marshal.Copy(mocBytes, 0, mocBufferPtr, mocBytes.Length);

            if (CubismCoreNative.csmHasMocConsistency(mocBufferPtr, mocSize) == 0)
            {
                throw new InvalidDataException($"{settings.MocPath}: failed Cubism Core's moc consistency check");
            }

            var moc = CubismCoreNative.csmReviveMocInPlace(mocBufferPtr, mocSize);
            if (moc == 0)
            {
                throw new InvalidDataException($"{settings.MocPath}: csmReviveMocInPlace failed");
            }

            var modelSize = CubismCoreNative.csmGetSizeofModel(moc);
            if (modelSize == 0)
            {
                throw new InvalidDataException($"{settings.MocPath}: csmGetSizeofModel returned 0");
            }

            modelBuffer = NativeMemory.AlignedAlloc(modelSize, CubismCoreNative.AlignofModel);
            var modelBufferPtr = (nint)modelBuffer;
            var model = CubismCoreNative.csmInitializeModelInPlace(moc, modelBufferPtr, modelSize);
            if (model == 0)
            {
                throw new InvalidDataException($"{settings.MocPath}: csmInitializeModelInPlace failed");
            }

            var result = new CubismModel(mocBufferPtr, modelBufferPtr, model);
            mocBuffer = null;
            modelBuffer = null;
            return result;
        }
        finally
        {
            if (modelBuffer is not null)
            {
                NativeMemory.AlignedFree(modelBuffer);
            }
            if (mocBuffer is not null)
            {
                NativeMemory.AlignedFree(mocBuffer);
            }
        }
    }

    public void SetParameterValue(string id, float value)
    {
        if (!parameterIndexById.TryGetValue(id, out var index))
        {
            return; // this model doesn't have that parameter -- no-op, not an error
        }
        var values = (float*)CubismCoreNative.csmGetParameterValues(model);
        values[index] = value;
    }

    public bool HasParameter(string id) => parameterIndexById.ContainsKey(id);

    public IReadOnlyCollection<string> ParameterIds => parameterIndexById.Keys;

    public float GetParameterCurrentValue(string id)
    {
        if (!parameterIndexById.TryGetValue(id, out var index))
        {
            return 0f;
        }
        var values = (float*)CubismCoreNative.csmGetParameterValues(model);
        return values[index];
    }

    public float GetParameterDefaultValue(string id) => ReadParameterFloat(id, CubismCoreNative.csmGetParameterDefaultValues(model));
    public float GetParameterMinValue(string id) => ReadParameterFloat(id, CubismCoreNative.csmGetParameterMinimumValues(model));
    public float GetParameterMaxValue(string id) => ReadParameterFloat(id, CubismCoreNative.csmGetParameterMaximumValues(model));

    private float ReadParameterFloat(string id, nint arrayBase)
    {
        if (!parameterIndexById.TryGetValue(id, out var index) || arrayBase == 0)
        {
            return 0f;
        }
        return ((float*)arrayBase)[index];
    }

    public void Update() => CubismCoreNative.csmUpdateModel(model);

    public void ReadCanvasInfo(
        out CubismCoreNative.Vector2 sizeInPixels,
        out CubismCoreNative.Vector2 originInPixels,
        out float pixelsPerUnit)
    {
        CubismCoreNative.csmReadCanvasInfo(model, out sizeInPixels, out originInPixels, out pixelsPerUnit);
    }

    // Re-reads current drawable state fresh -- vertex positions and
    // dynamic flags change every Update() call (parameter-driven
    // deformation), so nothing here is cached across calls.
    public IReadOnlyList<Drawable> GetDrawables()
    {
        var count = drawableIds.Length;
        var opacities = ReadFloatArray(CubismCoreNative.csmGetDrawableOpacities(model), count);
        var drawOrders = ReadInt32Array(CubismCoreNative.csmGetDrawableDrawOrders(model), count);
        var renderOrders = ReadInt32Array(CubismCoreNative.csmGetRenderOrders(model), count);
        var constantFlags = ReadByteArray(CubismCoreNative.csmGetDrawableConstantFlags(model), count);
        var dynamicFlags = ReadByteArray(CubismCoreNative.csmGetDrawableDynamicFlags(model), count);
        var vertexCounts = ReadInt32Array(CubismCoreNative.csmGetDrawableVertexCounts(model), count);
        var indexCounts = ReadInt32Array(CubismCoreNative.csmGetDrawableIndexCounts(model), count);
        var vertexPositionArrays = CubismCoreNative.csmGetDrawableVertexPositions(model);
        var vertexUvArrays = CubismCoreNative.csmGetDrawableVertexUvs(model);
        var indexArrays = CubismCoreNative.csmGetDrawableIndices(model);
        var maskCounts = ReadInt32Array(CubismCoreNative.csmGetDrawableMaskCounts(model), count);
        var maskArrays = CubismCoreNative.csmGetDrawableMasks(model);

        var drawables = new Drawable[count];
        for (var i = 0; i < count; i++)
        {
            const byte isVisible = 1 << 0;
            const byte blendAdditive = 1 << 0;
            const byte blendMultiplicative = 1 << 1;
            const byte isDoubleSided = 1 << 2;

            drawables[i] = new Drawable
            {
                Id = drawableIds[i],
                TextureIndex = drawableTextureIndices[i],
                Opacity = opacities[i],
                DrawOrder = drawOrders[i],
                RenderOrder = renderOrders[i],
                IsVisible = (dynamicFlags[i] & isVisible) != 0,
                IsDoubleSided = (constantFlags[i] & isDoubleSided) != 0,
                IsAdditiveBlend = (constantFlags[i] & blendAdditive) != 0,
                IsMultiplicativeBlend = (constantFlags[i] & blendMultiplicative) != 0,
                VertexPositions = ReadVector2Array(ReadPointerAt(vertexPositionArrays, i), vertexCounts[i]),
                VertexUvs = ReadVector2Array(ReadPointerAt(vertexUvArrays, i), vertexCounts[i]),
                Indices = ReadUInt16Array(ReadPointerAt(indexArrays, i), indexCounts[i]),
                MaskDrawableIndices = ReadInt32Array(ReadPointerAt(maskArrays, i), maskCounts[i]),
            };
        }

        return drawables;
    }

    public void Dispose()
    {
        if (modelBuffer != 0)
        {
            NativeMemory.AlignedFree((void*)modelBuffer);
            modelBuffer = 0;
        }
        if (mocBuffer != 0)
        {
            NativeMemory.AlignedFree((void*)mocBuffer);
            mocBuffer = 0;
        }
        model = 0;
    }

    private static nint ReadPointerAt(nint arrayBase, int index) =>
        arrayBase == 0 ? 0 : Marshal.ReadIntPtr(arrayBase, index * nint.Size);

    private static string[] ReadStringArray(nint arrayBase, int count)
    {
        if (count <= 0 || arrayBase == 0)
        {
            return [];
        }
        var result = new string[count];
        for (var i = 0; i < count; i++)
        {
            result[i] = Marshal.PtrToStringAnsi(ReadPointerAt(arrayBase, i)) ?? "";
        }
        return result;
    }

    private static int[] ReadInt32Array(nint arrayBase, int count)
    {
        if (count <= 0 || arrayBase == 0)
        {
            return [];
        }
        var result = new int[count];
        Marshal.Copy(arrayBase, result, 0, count);
        return result;
    }

    private static float[] ReadFloatArray(nint arrayBase, int count)
    {
        if (count <= 0 || arrayBase == 0)
        {
            return [];
        }
        var result = new float[count];
        Marshal.Copy(arrayBase, result, 0, count);
        return result;
    }

    private static byte[] ReadByteArray(nint arrayBase, int count)
    {
        if (count <= 0 || arrayBase == 0)
        {
            return [];
        }
        var result = new byte[count];
        Marshal.Copy(arrayBase, result, 0, count);
        return result;
    }

    private static CubismCoreNative.Vector2[] ReadVector2Array(nint arrayBase, int count)
    {
        if (count <= 0 || arrayBase == 0)
        {
            return [];
        }
        var result = new CubismCoreNative.Vector2[count];
        var span = new ReadOnlySpan<CubismCoreNative.Vector2>((void*)arrayBase, count);
        span.CopyTo(result);
        return result;
    }

    private static ushort[] ReadUInt16Array(nint arrayBase, int count)
    {
        if (count <= 0 || arrayBase == 0)
        {
            return [];
        }
        var result = new ushort[count];
        var span = new ReadOnlySpan<ushort>((void*)arrayBase, count);
        span.CopyTo(result);
        return result;
    }
}
