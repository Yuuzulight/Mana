using System.Text.Json;

namespace Mana.NativeLauncher.Live2D;

// #514: parses and applies a .exp3.json file -- Cubism Framework's
// expression format ({"Type":"Live2D Expression","Parameters":
// [{"Id","Value","Blend"}]}), not a Core concept. Core itself has no
// notion of expressions; this is hand-rolled parsing + application, not a
// Framework port (motion/physics stay out of scope -- see CubismModel's
// own header comment and issue #515).
internal sealed class CubismExpressionFile
{
    public readonly record struct ParameterDelta(string Id, float Value, string Blend);

    public required IReadOnlyList<ParameterDelta> Parameters { get; init; }

    public static CubismExpressionFile Load(string exp3JsonPath)
    {
        using var stream = File.OpenRead(exp3JsonPath);
        using var document = JsonDocument.Parse(stream);

        var parameters = new List<ParameterDelta>();
        if (document.RootElement.TryGetProperty("Parameters", out var parametersElement))
        {
            foreach (var parameterElement in parametersElement.EnumerateArray())
            {
                var id = parameterElement.TryGetProperty("Id", out var idElement) ? idElement.GetString() : null;
                if (id is null)
                {
                    continue;
                }
                var value = parameterElement.TryGetProperty("Value", out var valueElement) ? valueElement.GetSingle() : 0f;
                var blend = parameterElement.TryGetProperty("Blend", out var blendElement)
                    ? blendElement.GetString() ?? "Overwrite"
                    : "Overwrite";
                parameters.Add(new ParameterDelta(id, value, blend));
            }
        }

        return new CubismExpressionFile { Parameters = parameters };
    }

    // Applies this expression's parameter deltas to model, resetting each
    // touched parameter to its DEFAULT value first -- so Add/Multiply
    // blends compute against a fixed baseline instead of accumulating
    // indefinitely when this runs every render frame (~30fps) rather than
    // once. No fade-in/out timing; deltas snap instantly. Both are
    // deliberate scope cuts (see #514) matching the real Cubism
    // "Overwrite"/"Add"/"Multiply" blend semantics minus the Framework's
    // time-based fade curve.
    public void ApplyTo(CubismModel model)
    {
        foreach (var delta in Parameters)
        {
            if (!model.HasParameter(delta.Id))
            {
                continue;
            }
            var baseValue = model.GetParameterDefaultValue(delta.Id);
            var newValue = delta.Blend switch
            {
                "Add" => baseValue + delta.Value,
                "Multiply" => baseValue * delta.Value,
                _ => delta.Value, // "Overwrite" and any unrecognized blend type
            };
            model.SetParameterValue(delta.Id, newValue);
        }
    }
}
