using System;
using System.IO;
using System.Linq;
using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class CubismExpressionFileTests
{
    // #514: parses real .exp3.json files from the one local model that
    // actually ships them (see HuohuoExpressionsAvailableFactAttribute's
    // own comment) -- verifies the parser against genuine Cubism-authored
    // content, not just a hand-written fixture.
    [HuohuoExpressionsAvailableFact]
    public void Load_ParsesARealExp3JsonFile()
    {
        var path = Path.Combine(HuohuoExpressionsAvailableFactAttribute.Directory, "angry.exp3.json");

        var expression = CubismExpressionFile.Load(path);

        var delta = Assert.Single(expression.Parameters);
        Assert.Equal("Param107", delta.Id);
        Assert.Equal(1.0f, delta.Value);
        Assert.Equal("Add", delta.Blend);
    }

    [HuohuoExpressionsAvailableFact]
    public void Load_ParsesEveryExp3JsonFileInTheDirectoryWithoutThrowing()
    {
        var files = Directory.GetFiles(HuohuoExpressionsAvailableFactAttribute.Directory, "*.exp3.json");
        Assert.NotEmpty(files);

        foreach (var file in files)
        {
            var expression = CubismExpressionFile.Load(file);
            Assert.NotEmpty(expression.Parameters);
        }
    }

    [Fact]
    public void Load_TreatsAMissingBlendFieldAsOverwrite()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-expr-test-" + Guid.NewGuid());
        Directory.CreateDirectory(dir);
        try
        {
            var path = Path.Combine(dir, "test.exp3.json");
            File.WriteAllText(path, """
                { "Type": "Live2D Expression", "Parameters": [ { "Id": "ParamBrowLY", "Value": 0.5 } ] }
                """);

            var expression = CubismExpressionFile.Load(path);

            var delta = Assert.Single(expression.Parameters);
            Assert.Equal("ParamBrowLY", delta.Id);
            Assert.Equal(0.5f, delta.Value);
            Assert.Equal("Overwrite", delta.Blend);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Load_SkipsAParameterEntryMissingId()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mana-cubism-expr-test-" + Guid.NewGuid());
        Directory.CreateDirectory(dir);
        try
        {
            var path = Path.Combine(dir, "test.exp3.json");
            File.WriteAllText(path, """
                {
                  "Type": "Live2D Expression",
                  "Parameters": [
                    { "Value": 0.5, "Blend": "Add" },
                    { "Id": "ParamBrowLY", "Value": 0.5, "Blend": "Add" }
                  ]
                }
                """);

            var expression = CubismExpressionFile.Load(path);

            Assert.Single(expression.Parameters);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // ApplyTo's actual parameter math, verified against a real loaded
    // model rather than a fake -- confirms it genuinely reads the model's
    // default value and writes the blended result, not just that it
    // doesn't throw.
    private static CubismModel LoadTestModel()
    {
        CubismCoreLibrary.IsAvailable(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var model3JsonPath = Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..",
            "windows-launcher", "avatar", "model", "hiyori_free", "runtime", "hiyori_free_t08.model3.json");
        var settings = CubismModelSettings.Load(model3JsonPath);
        return CubismModel.Load(settings);
    }

    [CubismAvailableFact]
    public void ApplyTo_OverwriteSetsTheParameterDirectly()
    {
        using var model = LoadTestModel();
        model.Update();
        var expression = new CubismExpressionFile
        {
            Parameters = [new CubismExpressionFile.ParameterDelta("ParamMouthOpenY", 0.75f, "Overwrite")],
        };

        expression.ApplyTo(model);

        Assert.Equal(0.75f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);
    }

    [CubismAvailableFact]
    public void ApplyTo_AddIsRelativeToTheParametersDefaultValue()
    {
        using var model = LoadTestModel();
        model.Update();
        var defaultValue = model.GetParameterDefaultValue("ParamMouthOpenY");
        var expression = new CubismExpressionFile
        {
            Parameters = [new CubismExpressionFile.ParameterDelta("ParamMouthOpenY", 0.2f, "Add")],
        };

        expression.ApplyTo(model);

        Assert.Equal(defaultValue + 0.2f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);
    }

    [CubismAvailableFact]
    public void ApplyTo_MultiplyIsRelativeToTheParametersDefaultValue()
    {
        using var model = LoadTestModel();
        model.Update();
        var defaultValue = model.GetParameterDefaultValue("ParamMouthOpenY");
        var expression = new CubismExpressionFile
        {
            Parameters = [new CubismExpressionFile.ParameterDelta("ParamMouthOpenY", 2f, "Multiply")],
        };

        expression.ApplyTo(model);

        Assert.Equal(defaultValue * 2f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);
    }

    // The critical anti-accumulation case: applying the same "Add"
    // expression every render tick (as AvatarOverlayForm's RenderFrame
    // does, ~30fps) must NOT drift the parameter further from default
    // each call -- it must always compute from the default, not from
    // whatever the previous ApplyTo call already left in the buffer.
    [CubismAvailableFact]
    public void ApplyTo_CalledRepeatedlyDoesNotAccumulate()
    {
        using var model = LoadTestModel();
        model.Update();
        var defaultValue = model.GetParameterDefaultValue("ParamMouthOpenY");
        var expression = new CubismExpressionFile
        {
            Parameters = [new CubismExpressionFile.ParameterDelta("ParamMouthOpenY", 0.1f, "Add")],
        };

        expression.ApplyTo(model);
        expression.ApplyTo(model);
        expression.ApplyTo(model);

        Assert.Equal(defaultValue + 0.1f, model.GetParameterCurrentValue("ParamMouthOpenY"), 3);
    }

    [CubismAvailableFact]
    public void ApplyTo_SkipsAParameterTheModelDoesNotHaveInsteadOfThrowing()
    {
        using var model = LoadTestModel();
        model.Update();
        var expression = new CubismExpressionFile
        {
            Parameters = [new CubismExpressionFile.ParameterDelta("ThisParameterDoesNotExist", 1f, "Overwrite")],
        };

        var exception = Record.Exception(() => expression.ApplyTo(model));

        Assert.Null(exception);
    }
}
