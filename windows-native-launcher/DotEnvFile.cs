using System;
using System.Collections.Generic;
using System.IO;

namespace Mana.NativeLauncher;

// Loads node-bot/.env into this process's environment, same rules as the
// backend's own load (node-bot/load-env.js, Node's util.parseEnv): KEY=VALUE
// lines, # comments, optional `export ` prefix, surrounding quotes stripped,
// anything from `#` on stripped from an unquoted value, backslashes kept literally
// (Windows paths). .env values win over inherited ones -- it's the file the
// user edits, and stale user-level variables must not override it. Loading
// it here (not only in node-bot) makes the launcher's own env-driven
// settings (MANA_START_EMBEDDER, hotkeys, avatar, ...) honour it too, and
// every child process inherits the result.
internal static class DotEnvFile
{
    public static IReadOnlyList<string> Load(string path)
    {
        string text;
        try
        {
            text = File.ReadAllText(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Array.Empty<string>();
        }

        var keys = new List<string>();
        foreach (var (key, value) in Parse(text))
        {
            Environment.SetEnvironmentVariable(key, value);
            keys.Add(key);
        }
        return keys;
    }

    internal static IEnumerable<(string Key, string Value)> Parse(string text)
    {
        foreach (var rawLine in text.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }
            if (line.StartsWith("export ", StringComparison.Ordinal))
            {
                line = line["export ".Length..].TrimStart();
            }

            var eq = line.IndexOf('=');
            if (eq <= 0)
            {
                continue;
            }
            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim();

            if (value.Length >= 2 && (value[0] == '"' || value[0] == '\'') && value.IndexOf(value[0], 1) is var close and > 0)
            {
                var quote = value[0];
                value = value[1..close];
                if (quote == '"')
                {
                    value = value.Replace("\\n", "\n");
                }
            }
            else
            {
                var comment = value.IndexOf('#');
                if (comment >= 0)
                {
                    value = value[..comment].TrimEnd();
                }
            }

            yield return (key, value);
        }
    }
}
