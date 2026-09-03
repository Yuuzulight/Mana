using System.Text.Json;

namespace Mana.NativeLauncher.Live2D;

// #515: parses and evaluates a .motion3.json file's parameter curves --
// Cubism Framework's motion format (linear/bezier/stepped/inverse-stepped
// keyframe segments), not a Core concept, same as CubismExpressionFile for
// .exp3.json. Physics (.physics3.json) stays out of scope (see the
// tracking issue) -- this only drives whatever parameter curves a motion
// file itself declares; PartOpacity/Model-target curves aren't evaluated.
internal sealed class CubismMotionFile
{
    private sealed class Curve
    {
        public required string Id { get; init; }
        // Raw Cubism Motion3 curve encoding -- see EvaluateCurve's own
        // comment for the format.
        public required float[] Segments { get; init; }
    }

    public required float Duration { get; init; }
    public required bool Loop { get; init; }
    // Not `required` -- a required member's setter must be at least as
    // accessible as the containing type for external object-initializer
    // syntax to work, but this is only ever set internally by Load()
    // below, never from outside the class.
    private IReadOnlyList<Curve> Curves { get; init; } = [];

    public static CubismMotionFile Load(string motion3JsonPath)
    {
        using var stream = File.OpenRead(motion3JsonPath);
        using var document = JsonDocument.Parse(stream);
        var root = document.RootElement;

        var meta = root.GetProperty("Meta");
        var duration = meta.TryGetProperty("Duration", out var durationElement) ? durationElement.GetSingle() : 0f;
        var loop = meta.TryGetProperty("Loop", out var loopElement) && loopElement.GetBoolean();

        var curves = new List<Curve>();
        if (root.TryGetProperty("Curves", out var curvesElement))
        {
            foreach (var curveElement in curvesElement.EnumerateArray())
            {
                // Only Parameter-target curves are driven here -- PartOpacity
                // and Model-target curves are a separate Cubism concept this
                // project doesn't need for "the avatar isn't frozen between
                // sentences" (the issue's own scope).
                var target = curveElement.TryGetProperty("Target", out var targetElement) ? targetElement.GetString() : null;
                if (target != "Parameter")
                {
                    continue;
                }
                var id = curveElement.TryGetProperty("Id", out var idElement) ? idElement.GetString() : null;
                if (id is null || !curveElement.TryGetProperty("Segments", out var segmentsElement))
                {
                    continue;
                }
                var segments = new List<float>();
                foreach (var segmentValue in segmentsElement.EnumerateArray())
                {
                    segments.Add(segmentValue.GetSingle());
                }
                curves.Add(new Curve { Id = id, Segments = [.. segments] });
            }
        }

        return new CubismMotionFile { Duration = duration, Loop = loop, Curves = curves };
    }

    // Applies each curve's value AT timeSeconds to model. Loops
    // timeSeconds into [0, Duration) first when Loop is set (true for
    // every real Idle motion) -- otherwise clamps to the last frame.
    // Unconditionally overwrites each curve's own parameter (no blending
    // with whatever was there before): this is meant to run as the base
    // layer a caller applies BEFORE any expression/lip-sync override, not
    // to be additive itself -- see AvatarOverlayForm.RenderFrame's own
    // layering comment.
    public void ApplyTo(CubismModel model, float timeSeconds)
    {
        if (Duration <= 0)
        {
            return;
        }
        var t = Loop ? timeSeconds % Duration : Math.Min(timeSeconds, Duration);

        foreach (var curve in Curves)
        {
            if (!model.HasParameter(curve.Id))
            {
                continue;
            }
            model.SetParameterValue(curve.Id, EvaluateCurve(curve.Segments, t));
        }
    }

    // Cubism Motion3's own curve encoding: a flat float array. The first
    // two values are the curve's starting (time, value) point. From there,
    // repeated (segmentType, points...) groups:
    //   0 = Linear: 1 following (time, value) point.
    //   1 = Bezier: 3 following (time, value) points -- 2 control points
    //       then the segment's end point.
    //   2 = Stepped: 1 following (time, value) point -- holds the
    //       PREVIOUS point's value flat until `time`, then jumps.
    //   3 = InverseStepped: 1 following (time, value) point -- jumps to
    //       `value` immediately, holds it flat until `time`.
    // Evaluating means walking segments until the one spanning t, then
    // interpolating within it.
    private static float EvaluateCurve(float[] segments, float t)
    {
        if (segments.Length < 2)
        {
            return 0f;
        }

        var prevTime = segments[0];
        var prevValue = segments[1];
        var i = 2;

        while (i < segments.Length)
        {
            var segmentType = (int)segments[i];
            i++;

            switch (segmentType)
            {
                case 0: // Linear
                {
                    var time = segments[i];
                    var value = segments[i + 1];
                    i += 2;
                    if (t <= time)
                    {
                        var span = time - prevTime;
                        var ratio = span > 0 ? (t - prevTime) / span : 0f;
                        return prevValue + (value - prevValue) * ratio;
                    }
                    prevTime = time;
                    prevValue = value;
                    break;
                }

                case 1: // Bezier: 2 control points + 1 end point
                {
                    var c1Value = segments[i + 1];
                    var c2Value = segments[i + 3];
                    var endTime = segments[i + 4];
                    var endValue = segments[i + 5];
                    i += 6;
                    if (t <= endTime)
                    {
                        var span = endTime - prevTime;
                        var ratio = span > 0 ? Math.Clamp((t - prevTime) / span, 0f, 1f) : 0f;
                        return EvaluateBezier(prevValue, c1Value, c2Value, endValue, ratio);
                    }
                    prevTime = endTime;
                    prevValue = endValue;
                    break;
                }

                case 2: // Stepped
                {
                    var time = segments[i];
                    var value = segments[i + 1];
                    i += 2;
                    if (t < time)
                    {
                        return prevValue;
                    }
                    prevTime = time;
                    prevValue = value;
                    break;
                }

                case 3: // InverseStepped
                {
                    var time = segments[i];
                    var value = segments[i + 1];
                    i += 2;
                    if (t < time)
                    {
                        return value;
                    }
                    prevTime = time;
                    prevValue = value;
                    break;
                }

                default:
                    // Unknown segment type -- stop rather than misinterpret
                    // the remaining floats as something else.
                    return prevValue;
            }
        }

        return prevValue;
    }

    // Cubic Bezier through 4 control points (p0=segment start value,
    // p1/p2=control values, p3=segment end value), evaluated at a time-
    // normalized ratio (NOT a properly time-inverted Bezier parameter --
    // an accepted simplification: computing the exact parameter whose
    // Bezier-interpolated TIME equals t would need numerically solving a
    // cubic, and the visual difference for a slow idle-sway curve is not
    // meaningfully perceptible). Standard cubic Bezier formula.
    private static float EvaluateBezier(float p0, float p1, float p2, float p3, float ratio)
    {
        var oneMinusRatio = 1f - ratio;
        return (oneMinusRatio * oneMinusRatio * oneMinusRatio * p0)
            + (3f * oneMinusRatio * oneMinusRatio * ratio * p1)
            + (3f * oneMinusRatio * ratio * ratio * p2)
            + (ratio * ratio * ratio * p3);
    }
}
