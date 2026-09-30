using System.Linq;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1141: code artifacts as highlighted pages Folio draws.
[Collection("DarkTheme palette")] // the page carries the shared static palette
public class CodeArtifactTests
{
    [Theory]
    [InlineData("ts", "const s = \"hi\"; // note", "kw:const|str:\"hi\"|com:// note")]
    [InlineData("js", "let t = `a\n${b}`; /* x\ny */ 0x1F", "kw:let|str:`a\n${b}`|com:/* x\ny */|num:0x1F")]
    [InlineData("csharp", "var x = @\"a\"\"b\"; int n = 42; Console.Write($\"{n}\");", "kw:var|str:@\"a\"\"b\"|kw:int|num:42|type:Console|type:Write|str:$\"{n}\"")]
    [InlineData("python", "@cache\ndef f(): return f\"x{y}\" # c", "type:@cache|kw:def|kw:return|str:f\"x{y}\"|com:# c")]
    [InlineData("python", "s = '''a\nb'''", "str:'''a\nb'''")]
    [InlineData("json", "{\"a\": \"b\", \"n\": -1.5, \"t\": true}", "attr:\"a\"|str:\"b\"|attr:\"n\"|num:-1.5|attr:\"t\"|kw:true")]
    [InlineData("html", "<p class=\"x\">it's</p><!-- c -->", "kw:<p|attr:class|str:\"x\"|kw:>|kw:</p|kw:>|com:<!-- c -->")]
    [InlineData("css", "a.b { color: #fff; margin: 2px; }", "type:a|type:.b|attr:color|num:#fff|attr:margin|num:2px")]
    [InlineData("bash", "echo \"$HOME\" --all $x # hi", "kw:echo|str:\"$HOME\"|type:--all|attr:$x|com:# hi")]
    [InlineData("sql", "SELECT name FROM t WHERE x = 'y''s' -- c", "kw:SELECT|kw:FROM|kw:WHERE|str:'y''s'|com:-- c")]
    [InlineData("markdown", "# Title\n- **b** `c` [l](u)", "kw:# Title|num:-|kw:**b**|str:`c`|attr:[l](u)")]
    public void Tokenize_MarksEachLanguagesTokens(string language, string code, string expected)
    {
        var runs = CodeArtifact.Tokenize(language, code);

        Assert.Equal(code, string.Concat(runs.Select(r => r.Text))); // nothing lost or doubled
        Assert.Equal(expected, string.Join("|", runs.Where(r => r.Kind is not null).Select(r => $"{r.Kind}:{r.Text}")));
    }

    [Fact]
    public void Tokenize_LeavesAnUnknownLanguagePlain()
    {
        Assert.Equal(new (string?, string)[] { (null, "if x then y") }, CodeArtifact.Tokenize("text", "if x then y"));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Html_IsAStaticPage_OneNumberedRowPerLine_WithTheSourceEscaped(bool wrap)
    {
        DarkTheme.ApplyPreset("violet", null);
        var html = CodeArtifact.Html("js", "/* a\r\nb */\n\nlet s = '<script>alert(1)</script>';", wrap);

        Assert.Null(HtmlArtifact.BrowserReasons(html)); // Folio draws it, no browser, no script
        Assert.Contains("js &middot; 4 lines", html);
        Assert.Contains("<tr><td class=\"n\">1</td><td class=\"c\"><span class=\"com\">/* a</span></td></tr>", html);
        Assert.Contains("<tr><td class=\"n\">2</td><td class=\"c\"><span class=\"com\">b */</span></td></tr>", html);
        Assert.Contains("<tr><td class=\"n\">3</td><td class=\"c\"></td></tr>", html);
        Assert.Contains("&lt;script&gt;alert(1)&lt;/script&gt;", html);
        Assert.DoesNotContain("<script", html);
        Assert.Equal(wrap, html.Contains("pre-wrap"));
    }

    [Theory]
    [InlineData("violet")]
    [InlineData("light")]
    [InlineData("highContrast")]
    [InlineData("mana")]
    public void Html_UsesTheActivePresetsColours(string preset)
    {
        DarkTheme.ApplyPreset(preset, null);
        var html = CodeArtifact.Html("py", "x = 1", wrap: true);

        Assert.Contains($"html {{ background: {MarkdownHtml.Css(DarkTheme.Background)}; }}", html);
        Assert.Contains($".kw {{ color: {MarkdownHtml.Css(DarkTheme.Accent)}; }}", html);
        Assert.Contains($".str {{ color: {MarkdownHtml.Css(DarkTheme.Green)}; }}", html);
        DarkTheme.ApplyPreset("violet", null);
    }

    [Fact]
    public void ArtifactView_DrawsCodeWithFolio_AndRebuildsItOnAThemeSwitch()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            DarkTheme.ApplyPreset("violet", null);
            using var view = new ArtifactView { Size = new System.Drawing.Size(400, 300) };

            Assert.Null(view.Show(new VersionedArtifact("python", "def f():\n    return 1", "t", 1), source: false));
            var first = view.HtmlView.Document;
            Assert.Equal(2, first!.QuerySelectorAll("td.c").Count());

            view.WrapBox.Checked = false; // rebuilt without wrapping
            var unwrapped = view.HtmlView.Document;
            Assert.NotSame(first, unwrapped);

            DarkTheme.ApplyPresetLive("light", null);
            Assert.NotSame(unwrapped, view.HtmlView.Document);
            DarkTheme.ApplyPreset("violet", null);
        });
    }
}
