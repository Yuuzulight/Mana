using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace Mana.NativeLauncher;

// #1141: a code artifact as a small page Folio draws -- the language as a
// label, numbered lines, highlighted by a small tokenizer in the active
// theme preset's colours. The page has no script: wrapping long lines is
// decided when it's built (ArtifactView's "Wrap long lines").
internal static class CodeArtifact
{
    // Token kinds, which are also the page's CSS classes.
    private static readonly string[] Kinds = { "com", "str", "num", "kw", "type", "attr" };

    private const string DoubleQuoted = @"""(?:[^""\\\n]|\\.)*""?";
    private const string SingleQuoted = @"'(?:[^'\\\n]|\\.)*'?";
    private const string Number = @"\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)";
    private const string CComment = @"//[^\n]*|/\*[\s\S]*?(?:\*/|$)";
    private const string TypeName = @"\b[A-Z][A-Za-z0-9_]*\b";

    private static string Words(string words) => $@"\b(?:{words.Replace(' ', '|')})\b";

    // One regex per language, its rules in order: at each position the first
    // rule that matches wins. Unterminated strings and comments run to the end
    // of their line (or of the text, for block ones) rather than failing.
    private static Regex Rules(params (string Kind, string Pattern)[] rules) =>
        new(string.Join("|", rules.Select(r => $"(?<{r.Kind}>{r.Pattern})")), RegexOptions.None, TimeSpan.FromSeconds(1));

    private static readonly Regex Js = Rules(
        ("com", CComment),
        ("str", DoubleQuoted + "|" + SingleQuoted + @"|`(?:[^`\\]|\\[\s\S])*`?"),
        ("kw", Words("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof undefined var void while with yield async await of static get set as from interface type implements private protected public readonly declare namespace abstract keyof any number string boolean never unknown")),
        ("type", TypeName),
        ("num", Number));

    private static readonly Regex CSharp = Rules(
        ("com", CComment),
        ("str", @"""""""[\s\S]*?(?:""""""|$)|(?:\$@|@\$|@)""(?:[^""]|"""")*""?|\$?" + DoubleQuoted + "|" + SingleQuoted),
        ("kw", Words("abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await record init get set value yield when where nameof dynamic partial required global not and or with")),
        ("type", TypeName),
        ("num", Number));

    private static readonly Regex Python = Rules(
        ("com", "#[^\n]*"),
        ("str", @"(?:(?<!\w)[rRbBuUfF]{1,2})?(?:""""""[\s\S]*?(?:""""""|$)|'''[\s\S]*?(?:'''|$)|" + DoubleQuoted + "|" + SingleQuoted + ")"),
        ("kw", Words("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self")),
        ("type", @"@[\w.]+|" + TypeName),
        ("num", Number));

    private static readonly Regex Json = Rules(
        ("com", CComment), // JSONC
        ("attr", DoubleQuoted + @"(?=\s*:)"),
        ("str", DoubleQuoted),
        ("kw", Words("true false null")),
        ("num", @"-?" + Number));

    // Attribute values only after "=", so an apostrophe in text isn't a string.
    private static readonly Regex Markup = Rules(
        ("com", @"<!--[\s\S]*?(?:-->|$)"),
        ("kw", @"</?[!?]?[A-Za-z][\w:.-]*|/?\??>"),
        ("attr", @"\b[\w:.-]+(?=\s*=)"),
        ("str", @"(?<==\s*)(?:""[^""]*""?|'[^']*'?)"),
        ("num", @"&#?\w+;"));

    // A property follows "{" or ";"; a selector is followed by "{".
    private static readonly Regex Css = Rules(
        ("com", @"/\*[\s\S]*?(?:\*/|$)"),
        ("str", DoubleQuoted + "|" + SingleQuoted),
        ("attr", @"(?<=[{;]\s*)-{0,2}[A-Za-z][\w-]*(?=\s*:)"),
        ("kw", @"@[\w-]+|!important"),
        ("num", @"#[\da-fA-F]{3,8}\b|-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?"),
        ("type", @"[.#]?[A-Za-z_][\w-]*(?=[^{};]*\{)"));

    private static readonly Regex Shell = Rules(
        ("com", @"(?<![\w$])#[^\n]*"),
        ("str", DoubleQuoted + @"|'[^'\n]*'?"),
        ("attr", @"\$\{[^}\n]*\}?|\$[\w?@#*!$-]+"),
        ("kw", Words("if then else elif fi for while until do done case esac function in return export local source echo cd exit sudo param foreach switch")),
        ("type", @"(?<=\s)--?[A-Za-z][\w-]*"),
        ("num", Number));

    private static readonly Regex Sql = Rules(
        ("com", @"--[^\n]*|/\*[\s\S]*?(?:\*/|$)"),
        ("str", @"'(?:[^']|'')*'?"),
        ("attr", DoubleQuoted + @"|\[[^\]\n]*\]?|`[^`\n]*`?"),
        ("kw", "(?i:" + Words("select from where and or not insert into values update set delete create table index view drop alter add primary key foreign references join left right inner outer full cross on as group by order having limit offset distinct union all null is in like between case when then else end exists default unique check constraint begin commit rollback transaction with asc desc returning count sum avg min max integer int text varchar real boolean date if replace trigger") + ")"),
        ("num", Number));

    private static readonly Regex Markdown = Rules(
        ("str", @"```[\s\S]*?(?:```|$)|`[^`\n]+`"),
        ("kw", @"(?m:^)#{1,6}\s[^\n]*|\*\*[^*\n]+\*\*|__[^_\n]+__"),
        ("com", @"(?m:^)\s*>[^\n]*"),
        ("attr", @"!?\[[^\]\n]*\]\([^)\n]*\)"),
        ("num", @"(?m:^)\s*(?:[-*+]|\d+\.)(?=\s)"));

    private static readonly Dictionary<string, Regex> Languages = new(StringComparer.OrdinalIgnoreCase)
    {
        ["js"] = Js, ["javascript"] = Js, ["jsx"] = Js, ["mjs"] = Js, ["cjs"] = Js, ["ts"] = Js, ["typescript"] = Js, ["tsx"] = Js,
        ["cs"] = CSharp, ["csharp"] = CSharp, ["c#"] = CSharp,
        ["py"] = Python, ["python"] = Python,
        ["json"] = Json, ["jsonc"] = Json,
        ["html"] = Markup, ["htm"] = Markup, ["xml"] = Markup, ["svg"] = Markup,
        ["css"] = Css, ["scss"] = Css, ["less"] = Css,
        ["sh"] = Shell, ["bash"] = Shell, ["shell"] = Shell, ["zsh"] = Shell, ["console"] = Shell, ["powershell"] = Shell, ["ps1"] = Shell, ["pwsh"] = Shell,
        ["sql"] = Sql, ["sqlite"] = Sql,
        ["md"] = Markdown, ["markdown"] = Markdown,
    };

    // The code as runs of text, each with its token kind (null: plain). A
    // language without rules (or a pathological input) is one plain run.
    internal static List<(string? Kind, string Text)> Tokenize(string language, string code)
    {
        if (!Languages.TryGetValue(language, out var rules))
        {
            return new() { (null, code) };
        }
        var runs = new List<(string?, string)>();
        var at = 0;
        try
        {
            foreach (Match match in rules.Matches(code))
            {
                if (match.Length == 0)
                {
                    continue;
                }
                if (match.Index > at)
                {
                    runs.Add((null, code[at..match.Index]));
                }
                runs.Add((Kinds.First(kind => match.Groups[kind].Success), match.Value));
                at = match.Index + match.Length;
            }
        }
        catch (RegexMatchTimeoutException)
        {
            return new() { (null, code) };
        }
        if (at < code.Length)
        {
            runs.Add((null, code[at..]));
        }
        return runs;
    }

    // The whole page, in DarkTheme's current colours. wrap: long lines wrap
    // instead of running off the right (FolioView only scrolls down).
    public static string Html(string language, string code, bool wrap)
    {
        var lines = new List<StringBuilder> { new() };
        foreach (var (kind, text) in Tokenize(language, code.Replace("\r\n", "\n")))
        {
            var parts = text.Split('\n');
            for (var i = 0; i < parts.Length; i++)
            {
                if (i > 0)
                {
                    lines.Add(new());
                }
                if (parts[i].Length > 0)
                {
                    var escaped = WebUtility.HtmlEncode(parts[i]);
                    lines[^1].Append(kind is null ? escaped : $"<span class=\"{kind}\">{escaped}</span>");
                }
            }
        }

        var page = new StringBuilder("<!doctype html><html><head><meta charset=\"utf-8\"><style>").Append(Style(wrap)).Append("</style></head><body>")
            .Append($"<div class=\"lang\">{WebUtility.HtmlEncode(language)} &middot; {lines.Count} line{(lines.Count == 1 ? "" : "s")}</div><table>");
        for (var i = 0; i < lines.Count; i++)
        {
            page.Append($"<tr><td class=\"n\">{i + 1}</td><td class=\"c\">").Append(lines[i]).Append("</td></tr>");
        }
        return page.Append("</table></body></html>").ToString();
    }

    private static string Style(bool wrap)
    {
        static string C(System.Drawing.Color color) => MarkdownHtml.Css(color);
        return $$"""
            html { background: {{C(DarkTheme.Background)}}; }
            body { margin: 0; color: {{C(DarkTheme.Text)}}; font: 13px/1.5 Consolas, "Cascadia Mono", monospace; }
            .lang { padding: 4px 10px; color: {{C(DarkTheme.Muted)}}; background: {{C(DarkTheme.Panel2)}}; border-bottom: 1px solid {{C(DarkTheme.Border)}}; font: 12px "Segoe UI", sans-serif; }
            table { border-collapse: collapse; {{(wrap ? "width: 100%;" : "")}} }
            td { padding: 0 10px; vertical-align: top; tab-size: 4; }
            td.n { color: {{C(DarkTheme.Muted)}}; text-align: right; border-right: 1px solid {{C(DarkTheme.Border)}}; white-space: pre; }
            td.c { {{(wrap ? "width: 100%; white-space: pre-wrap; overflow-wrap: anywhere;" : "white-space: pre;")}} }
            .com { color: {{C(DarkTheme.Muted)}}; font-style: italic; }
            .str { color: {{C(DarkTheme.Green)}}; }
            .num { color: {{C(DarkTheme.Warn)}}; }
            .kw { color: {{C(DarkTheme.Accent)}}; }
            .type, .attr { color: {{C(DarkTheme.CodeText)}}; }
            """;
    }
}
