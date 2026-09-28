using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Mana.NativeLauncher;

// #642: the chat window's context meter and its hover breakdown -- pure, so
// it's testable without a Form. "" means nothing to show: no reply yet in
// this session, or a reply path that never measured its prompt against the
// context window (the OpenAI proxy, Best-of-N).
internal static class ContextMeterFormatter
{
    private static readonly Dictionary<string, string> BlockLabels = new()
    {
        ["system-prompt"] = "System prompt",
        ["skills-index"] = "Skills",
        ["prompt-memory"] = "Conversation & memory",
        ["related-facts"] = "Related facts",
        ["tool-schemas"] = "Tool definitions",
        ["mcp-tool-schemas"] = "MCP tools",
        ["user-turn"] = "Your message",
    };

    public static string FormatMeter(ManaPromptComposition? composition)
    {
        if (composition?.PercentUsed is not double percent || composition.ContextSize is not long contextSize)
        {
            return "";
        }
        // Same "used" the backend's percentUsed is computed from.
        var used = composition.PromptTokens ?? composition.TotalTokens ?? 0;
        return $"Context {Tokens(used)} / {Tokens(contextSize)} ({percent.ToString("0.#", CultureInfo.InvariantCulture)}%)";
    }

    public static string FormatBreakdown(ManaPromptComposition? composition)
    {
        if (FormatMeter(composition).Length == 0)
        {
            return "";
        }
        var text = new StringBuilder("Last reply's prompt, in tokens:");
        foreach (var block in composition!.Blocks)
        {
            var label = BlockLabels.TryGetValue(block.Name, out var known) ? known : block.Name;
            text.AppendLine().Append($"{label}: {Tokens(block.Tokens)}");
        }
        // What the blocks don't cover (see prompt-composition-report.js);
        // can be negative when the template renders tool schemas compactly.
        if (composition.UnattributedTokens is long other)
        {
            text.AppendLine().Append($"Chat template & tool results: {Tokens(other)}");
        }
        if (composition.CountedWith != "tokenizer")
        {
            text.AppendLine().Append("Estimated -- the model's tokenizer wasn't available.");
        }
        return text.ToString();
    }

    private static string Tokens(long count) => count.ToString("N0", CultureInfo.InvariantCulture);
}
