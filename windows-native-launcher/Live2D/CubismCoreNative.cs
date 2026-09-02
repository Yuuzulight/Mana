using System.Runtime.InteropServices;

namespace Mana.NativeLauncher.Live2D;

// #479 sub-project 4: raw P/Invoke bindings for Live2D's Cubism Core native
// SDK (Live2DCubismCore.dll), transcribed directly from the real header at
// native/cubism-core/Live2DCubismCore.h -- not from memory/documentation,
// to avoid a subtly wrong signature silently corrupting memory. Only the
// subset this project actually uses is bound (parameters, drawables,
// canvas info, moc/model lifecycle) -- offscreens/masks/physics and the
// higher-level Framework layer (motion playback, expression blending,
// physics simulation) are Live2D's own C++ source, not part of Core, and
// are out of scope here (see CubismModel's own comment).
//
// Calling convention: the header's csmCallingConvention macro expands to
// __stdcall only when CSM_CORE_WIN32_DLL is defined, and the prebuilt
// Windows x64 DLL exports plain, undecorated names (confirmed directly
// against the real DLL's export table, not assumed) -- x64 Windows has a
// single unified calling convention regardless, so this distinction only
// matters on x86, which this project doesn't target.
internal static class CubismCoreNative
{
    private const string DllName = "Live2DCubismCore";

    // Mirrors csmAlignofMoc / csmAlignofModel from the header -- required
    // alignment (in bytes) for the buffers csmReviveMocInPlace /
    // csmInitializeModelInPlace write into.
    public const int AlignofMoc = 64;
    public const int AlignofModel = 16;

    [StructLayout(LayoutKind.Sequential)]
    public struct Vector2
    {
        public float X;
        public float Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Vector4
    {
        public float X;
        public float Y;
        public float Z;
        public float W;
    }

    [DllImport(DllName)]
    public static extern uint csmGetVersion();

    [DllImport(DllName)]
    public static extern int csmHasMocConsistency(nint address, uint size);

    [DllImport(DllName)]
    public static extern nint csmReviveMocInPlace(nint address, uint size);

    [DllImport(DllName)]
    public static extern uint csmGetSizeofModel(nint moc);

    [DllImport(DllName)]
    public static extern nint csmInitializeModelInPlace(nint moc, nint address, uint size);

    [DllImport(DllName)]
    public static extern void csmUpdateModel(nint model);

    // Model-level, fully tie-broken render order -- distinct from
    // csmGetDrawableDrawOrders below, which is the coarser per-drawable
    // "layer" value an artist sets in the editor and commonly ties across
    // many drawables (confirmed against a real model: masking a drawable
    // to a same-DrawOrder sibling and sorting only by DrawOrder let an
    // unstable/incorrect tiebreak draw the mask source after the drawable
    // it was meant to clip, painting over it). This is what CubismRenderer
    // actually sorts by.
    [DllImport(DllName)]
    public static extern nint csmGetRenderOrders(nint model); // const int*

    [DllImport(DllName)]
    public static extern void csmReadCanvasInfo(
        nint model,
        out Vector2 outSizeInPixels,
        out Vector2 outOriginInPixels,
        out float outPixelsPerUnit);

    [DllImport(DllName)]
    public static extern int csmGetParameterCount(nint model);

    [DllImport(DllName)]
    public static extern nint csmGetParameterIds(nint model); // const char**

    [DllImport(DllName)]
    public static extern nint csmGetParameterMinimumValues(nint model); // const float*

    [DllImport(DllName)]
    public static extern nint csmGetParameterMaximumValues(nint model); // const float*

    [DllImport(DllName)]
    public static extern nint csmGetParameterDefaultValues(nint model); // const float*

    [DllImport(DllName)]
    public static extern nint csmGetParameterValues(nint model); // float* (read/write)

    [DllImport(DllName)]
    public static extern int csmGetPartCount(nint model);

    [DllImport(DllName)]
    public static extern nint csmGetPartIds(nint model); // const char**

    [DllImport(DllName)]
    public static extern nint csmGetPartOpacities(nint model); // float* (read/write)

    [DllImport(DllName)]
    public static extern int csmGetDrawableCount(nint model);

    [DllImport(DllName)]
    public static extern nint csmGetDrawableIds(nint model); // const char**

    [DllImport(DllName)]
    public static extern nint csmGetDrawableConstantFlags(nint model); // const csmFlags* (byte*)

    [DllImport(DllName)]
    public static extern nint csmGetDrawableDynamicFlags(nint model); // const csmFlags* (byte*)

    [DllImport(DllName)]
    public static extern nint csmGetDrawableTextureIndices(nint model); // const int*

    [DllImport(DllName)]
    public static extern nint csmGetDrawableDrawOrders(nint model); // const int*

    [DllImport(DllName)]
    public static extern nint csmGetDrawableOpacities(nint model); // const float*

    [DllImport(DllName)]
    public static extern nint csmGetDrawableVertexCounts(nint model); // const int*

    [DllImport(DllName)]
    public static extern nint csmGetDrawableVertexPositions(nint model); // const csmVector2** (per drawable)

    [DllImport(DllName)]
    public static extern nint csmGetDrawableVertexUvs(nint model); // const csmVector2** (per drawable)

    [DllImport(DllName)]
    public static extern nint csmGetDrawableIndexCounts(nint model); // const int*

    [DllImport(DllName)]
    public static extern nint csmGetDrawableIndices(nint model); // const unsigned short** (per drawable)

    [DllImport(DllName)]
    public static extern nint csmGetDrawableMaskCounts(nint model); // const int*

    [DllImport(DllName)]
    public static extern nint csmGetDrawableMasks(nint model); // const int** (per drawable)

    [DllImport(DllName)]
    public static extern void csmResetDrawableDynamicFlags(nint model);
}
