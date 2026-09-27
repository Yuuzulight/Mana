using System.Numerics;
using System.Text.Json;

namespace Mana.NativeLauncher.Live2D;

// A parsed .physics3.json plus its running simulation: each setting is a
// chain of particles (a pendulum strand -- a lock of hair, a skirt edge)
// whose root is pushed around by input parameters (head/body angle), and
// whose particle angles are written back to output parameters (ParamHairFront
// etc.). A direct port of the Cubism Framework's CubismPhysics as bundled in
// pixi-live2d-display, which the Electron launcher uses -- same constants,
// same order of operations (including its in-place rotation quirk, where the
// y term reads the already-rotated x), so hair moves the same in both apps.
//
// Only Angle outputs are applied: the Framework leaves X/Y outputs'
// translation scale at zero, so they'd only ever write 0 -- no shipped model
// relies on that.
internal sealed class CubismPhysics
{
    private const float AirResistance = 5f;
    private const float MaximumWeight = 100f;
    private const float MovementThreshold = 0.001f;
    // A stalled render timer (window hidden, machine asleep) would otherwise
    // hand the solver one huge step and fling every strand.
    private const float MaxStepSeconds = 0.1f;

    private enum SourceType { X, Y, Angle }

    private sealed record Input(string ParameterId, SourceType Type, float Weight, bool Reflect);
    private sealed record Output(string ParameterId, int VertexIndex, float AngleScale, float Weight, bool Reflect);

    private sealed class Particle
    {
        public float Mobility, Delay, Acceleration, Radius;
        public Vector2 Position, LastPosition, LastGravity, Velocity;
    }

    private sealed record Setting(
        Input[] Inputs,
        Output[] Outputs,
        Particle[] Particles,
        float PositionMin, float PositionMax, float PositionDefault,
        float AngleMin, float AngleMax, float AngleDefault);

    private readonly Setting[] settings;

    private CubismPhysics(Setting[] settings) => this.settings = settings;

    public int SettingCount => settings.Length;

    public static CubismPhysics Load(string physics3JsonPath)
    {
        using var stream = File.OpenRead(physics3JsonPath);
        return Parse(JsonDocument.Parse(stream).RootElement);
    }

    public static CubismPhysics Parse(JsonElement root)
    {
        var settings = new List<Setting>();
        foreach (var s in root.GetProperty("PhysicsSettings").EnumerateArray())
        {
            var inputs = s.GetProperty("Input").EnumerateArray().Select(i => new Input(
                i.GetProperty("Source").GetProperty("Id").GetString() ?? "",
                Enum.Parse<SourceType>(i.GetProperty("Type").GetString() ?? ""),
                i.GetProperty("Weight").GetSingle(),
                i.GetProperty("Reflect").GetBoolean())).ToArray();

            var outputs = s.GetProperty("Output").EnumerateArray()
                .Where(o => o.GetProperty("Type").GetString() == nameof(SourceType.Angle))
                .Select(o => new Output(
                    o.GetProperty("Destination").GetProperty("Id").GetString() ?? "",
                    o.GetProperty("VertexIndex").GetInt32(),
                    o.GetProperty("Scale").GetSingle(),
                    o.GetProperty("Weight").GetSingle(),
                    o.GetProperty("Reflect").GetBoolean())).ToArray();

            // Initial layout: root at the origin, each particle Radius below
            // (+y) its parent -- the Framework ignores the file's Position.
            var particles = new List<Particle>();
            var position = Vector2.Zero;
            foreach (var v in s.GetProperty("Vertices").EnumerateArray())
            {
                var radius = v.GetProperty("Radius").GetSingle();
                if (particles.Count > 0)
                {
                    position += new Vector2(0, radius);
                }
                particles.Add(new Particle
                {
                    Mobility = v.GetProperty("Mobility").GetSingle(),
                    Delay = v.GetProperty("Delay").GetSingle(),
                    Acceleration = v.GetProperty("Acceleration").GetSingle(),
                    Radius = radius,
                    Position = position,
                    LastPosition = position,
                    LastGravity = new Vector2(0, 1),
                });
            }

            var norm = s.GetProperty("Normalization");
            var pos = norm.GetProperty("Position");
            var ang = norm.GetProperty("Angle");
            settings.Add(new Setting(inputs, outputs, particles.ToArray(),
                pos.GetProperty("Minimum").GetSingle(), pos.GetProperty("Maximum").GetSingle(), pos.GetProperty("Default").GetSingle(),
                ang.GetProperty("Minimum").GetSingle(), ang.GetProperty("Maximum").GetSingle(), ang.GetProperty("Default").GetSingle()));
        }
        return new CubismPhysics(settings.ToArray());
    }

    // Reads the current (motion/expression-driven) input parameters, steps
    // the simulation, and writes the outputs. Call after everything else has
    // set parameters for the frame and before CubismModel.Update().
    public void Evaluate(CubismModel model, float deltaSeconds)
    {
        deltaSeconds = Math.Clamp(deltaSeconds, 0f, MaxStepSeconds);
        foreach (var setting in settings)
        {
            var translation = Vector2.Zero;
            var totalAngle = 0f;
            foreach (var input in setting.Inputs)
            {
                if (!model.HasParameter(input.ParameterId))
                {
                    continue;
                }
                var angleInput = input.Type == SourceType.Angle;
                var normalized = NormalizeParameterValue(
                    model.GetParameterCurrentValue(input.ParameterId),
                    model.GetParameterMinValue(input.ParameterId),
                    model.GetParameterMaxValue(input.ParameterId),
                    angleInput ? setting.AngleMin : setting.PositionMin,
                    angleInput ? setting.AngleMax : setting.PositionMax,
                    angleInput ? setting.AngleDefault : setting.PositionDefault,
                    input.Reflect) * (input.Weight / MaximumWeight);
                switch (input.Type)
                {
                    case SourceType.X: translation.X += normalized; break;
                    case SourceType.Y: translation.Y += normalized; break;
                    default: totalAngle += normalized; break;
                }
            }

            var radAngle = DegreesToRadians(-totalAngle);
            translation.X = translation.X * MathF.Cos(radAngle) - translation.Y * MathF.Sin(radAngle);
            translation.Y = translation.X * MathF.Sin(radAngle) + translation.Y * MathF.Cos(radAngle);

            UpdateParticles(setting.Particles, translation, totalAngle, MovementThreshold * setting.PositionMax, deltaSeconds);

            foreach (var output in setting.Outputs)
            {
                var index = output.VertexIndex;
                if (index < 1 || index >= setting.Particles.Length)
                {
                    break; // the Framework stops at the first bad index, too
                }
                if (!model.HasParameter(output.ParameterId))
                {
                    continue;
                }
                var particles = setting.Particles;
                var parentGravity = index >= 2
                    ? particles[index - 1].Position - particles[index - 2].Position
                    : new Vector2(0, 1); // -(Framework gravity (0, -1))
                var angle = DirectionToRadians(parentGravity, particles[index].Position - particles[index - 1].Position);
                if (output.Reflect)
                {
                    angle = -angle;
                }

                var value = Math.Clamp(angle * output.AngleScale,
                    model.GetParameterMinValue(output.ParameterId),
                    model.GetParameterMaxValue(output.ParameterId));
                var weight = output.Weight / MaximumWeight;
                if (weight < 1)
                {
                    value = model.GetParameterCurrentValue(output.ParameterId) * (1 - weight) + value * weight;
                }
                model.SetParameterValue(output.ParameterId, value);
            }
        }
    }

    private static void UpdateParticles(Particle[] strand, Vector2 totalTranslation, float totalAngle, float threshold, float deltaSeconds)
    {
        strand[0].Position = totalTranslation;
        var currentGravity = Vector2.Normalize(RadiansToDirection(DegreesToRadians(totalAngle)));

        for (var i = 1; i < strand.Length; i++)
        {
            var p = strand[i];
            var force = currentGravity * p.Acceleration; // + wind, which is always zero here
            p.LastPosition = p.Position;
            var delay = p.Delay * deltaSeconds * 30f;

            var direction = p.Position - strand[i - 1].Position;
            var radian = DirectionToRadians(p.LastGravity, currentGravity) / AirResistance;
            direction.X = MathF.Cos(radian) * direction.X - direction.Y * MathF.Sin(radian);
            direction.Y = MathF.Sin(radian) * direction.X + direction.Y * MathF.Cos(radian);

            p.Position = strand[i - 1].Position + direction + p.Velocity * delay + force * delay * delay;

            // Normalize and re-extend to the fixed rope length. A zero
            // vector stays zero, matching the Framework's normalize().
            var newDirection = p.Position - strand[i - 1].Position;
            var length = newDirection.Length();
            if (length > 0)
            {
                newDirection /= length;
            }
            p.Position = strand[i - 1].Position + newDirection * p.Radius;

            if (MathF.Abs(p.Position.X) < threshold)
            {
                p.Position = new Vector2(0, p.Position.Y);
            }
            if (delay != 0)
            {
                p.Velocity = (p.Position - p.LastPosition) / delay * p.Mobility;
            }
            p.LastGravity = currentGravity;
        }
    }

    // Maps a parameter value into the setting's normalization range, split
    // around each range's midpoint/default. Inverted unless Reflect is set
    // -- that sign convention is the Framework's, not a typo.
    internal static float NormalizeParameterValue(
        float value, float parameterMinimum, float parameterMaximum,
        float normalizedMinimum, float normalizedMaximum, float normalizedDefault, bool reflect)
    {
        var maxValue = MathF.Max(parameterMaximum, parameterMinimum);
        var minValue = MathF.Min(parameterMaximum, parameterMinimum);
        value = Math.Clamp(value, minValue, maxValue);

        var minNorm = MathF.Min(normalizedMinimum, normalizedMaximum);
        var maxNorm = MathF.Max(normalizedMinimum, normalizedMaximum);
        var middleValue = minValue + (maxValue - minValue) / 2f;
        var paramValue = value - middleValue;

        float result;
        if (paramValue > 0)
        {
            var pLength = maxValue - middleValue;
            result = pLength != 0 ? paramValue * ((maxNorm - normalizedDefault) / pLength) + normalizedDefault : 0f;
        }
        else if (paramValue < 0)
        {
            var pLength = minValue - middleValue;
            result = pLength != 0 ? paramValue * ((minNorm - normalizedDefault) / pLength) + normalizedDefault : 0f;
        }
        else
        {
            result = normalizedDefault;
        }
        return reflect ? result : -result;
    }

    private static float DegreesToRadians(float degrees) => degrees / 180f * MathF.PI;

    private static Vector2 RadiansToDirection(float radians) => new(MathF.Sin(radians), MathF.Cos(radians));

    private static float DirectionToRadians(Vector2 from, Vector2 to)
    {
        var ret = MathF.Atan2(to.Y, to.X) - MathF.Atan2(from.Y, from.X);
        while (ret < -MathF.PI)
        {
            ret += MathF.PI * 2;
        }
        while (ret > MathF.PI)
        {
            ret -= MathF.PI * 2;
        }
        return ret;
    }
}
