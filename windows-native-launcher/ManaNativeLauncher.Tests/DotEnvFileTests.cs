using System.Linq;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class DotEnvFileTests
{
    [Fact]
    public void Parse_MatchesNodeParseEnvRules()
    {
        // Same cases as node-bot's util.parseEnv (node-bot/load-env.js), so
        // the launcher and the backend read node-bot/.env identically.
        var text = string.Join("\r\n",
            "# comment",
            @"LLAMA_MODEL=D:\models\new.gguf",
            "MANA_RELATED_FACTS_MAX_CHARS=800 # inline",
            "X=a#b",
            "Y=#c",
            "\"ignored\"",
            "Q=\"Quoted, with # inside\"",
            "S='single'",
            "export E=1",
            "  F = spaced  ",
            "H=a=b",
            "Z=1",
            "Z=2",
            "W=\"unterminated",
            "");

        var parsed = Mana.NativeLauncher.DotEnvFile.Parse(text).ToList();
        var last = parsed.GroupBy(p => p.Key).ToDictionary(g => g.Key, g => g.Last().Value);

        Assert.Equal(@"D:\models\new.gguf", last["LLAMA_MODEL"]);
        Assert.Equal("800", last["MANA_RELATED_FACTS_MAX_CHARS"]);
        Assert.Equal("a", last["X"]);
        Assert.Equal("", last["Y"]);
        Assert.Equal("Quoted, with # inside", last["Q"]);
        Assert.Equal("single", last["S"]);
        Assert.Equal("1", last["E"]);
        Assert.Equal("spaced", last["F"]);
        Assert.Equal("a=b", last["H"]);
        Assert.Equal("2", last["Z"]);
        Assert.Equal("\"unterminated", last["W"]);
        Assert.DoesNotContain(parsed, p => p.Key.StartsWith("\""));
    }

    [Fact]
    public void Load_MissingFileIsANoOp()
    {
        Assert.Empty(Mana.NativeLauncher.DotEnvFile.Load(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "mana-no-such-dir", ".env")));
    }
}
