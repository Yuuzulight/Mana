using System.Buffers.Binary;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Mana.NativeLauncher;

internal sealed record AnalysisChart(string Name, string DataUrl);
internal sealed record AnalysisFile(string Name, string Data);
internal sealed record AnalysisTable(IReadOnlyList<string> Columns, IReadOnlyList<IReadOnlyList<string>> Rows);
internal sealed record AnalysisOutputs(IReadOnlyList<AnalysisChart> Charts, IReadOnlyList<AnalysisFile> Files)
{
    public IReadOnlyList<AnalysisTable> Tables { get; init; } = [];
    public static AnalysisOutputs Empty { get; } = new([], []);

    public static AnalysisOutputs Parse(JsonElement parent)
    {
        if (!parent.TryGetProperty("analysisOutputs", out var value) || value.ValueKind != JsonValueKind.Object) return Empty;
        var charts = new List<AnalysisChart>();
        var files = new List<AnalysisFile>();
        var used = 0;
        byte[]? Decode(string? data)
        {
            if (data is null || data.Length > 342000) return null;
            try
            {
                var bytes = Convert.FromBase64String(data);
                if (Convert.ToBase64String(bytes) != data || bytes.Length > 256000 || used + bytes.Length > 1024000) return null;
                return bytes;
            }
            catch (FormatException) { return null; }
        }
        static string? Text(JsonElement item, string key) => item.ValueKind == JsonValueKind.Object && item.TryGetProperty(key, out var text) && text.ValueKind == JsonValueKind.String ? text.GetString() : null;
        if (value.TryGetProperty("charts", out var chartList) && chartList.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in chartList.EnumerateArray().Take(4))
            {
                const string prefix = "data:image/png;base64,";
                var url = Text(item, "dataUrl");
                if (url is null || !url.StartsWith(prefix, StringComparison.Ordinal)) continue;
                var bytes = Decode(url[prefix.Length..]);
                if (bytes is null || bytes.Length < 24 || !bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) || !bytes.AsSpan(12, 4).SequenceEqual("IHDR"u8)) continue;
                var width = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(16, 4));
                var height = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(20, 4));
                if (width == 0 || height == 0 || width > 4096 || height > 4096 || (ulong)width * height > 4000000) continue;
                used += bytes.Length;
                charts.Add(new("Analysis chart", url));
            }
        }
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (value.TryGetProperty("files", out var fileList) && fileList.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in fileList.EnumerateArray().Take(8))
            {
                var name = Text(item, "name");
                var data = Text(item, "data");
                if (name is null || !Regex.IsMatch(name, @"\A[A-Za-z0-9][A-Za-z0-9_. -]{0,119}\z") || name.EndsWith('.') || name.EndsWith(' ') || Regex.IsMatch(name, @"\A(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", RegexOptions.IgnoreCase) || names.Contains(name)) continue;
                var bytes = Decode(data);
                if (bytes is null) continue;
                used += bytes.Length;
                names.Add(name);
                files.Add(new(name, data!));
            }
        }
        var tables = new List<AnalysisTable>();
        var tableChars = 0;
        static string Cell(JsonElement cell) => cell.ValueKind == JsonValueKind.String ? Regex.Replace(cell.GetString() ?? "", @"[\x00-\x1f\x7f]", " ")[..Math.Min(256, (cell.GetString() ?? "").Length)] : "";
        if (value.TryGetProperty("tables", out var tableList) && tableList.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in tableList.EnumerateArray().Take(4))
            {
                if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("columns", out var columnsValue) || columnsValue.ValueKind != JsonValueKind.Array || columnsValue.GetArrayLength() is < 1 or > 8 || !item.TryGetProperty("rows", out var rowsValue) || rowsValue.ValueKind != JsonValueKind.Array) continue;
                var columns = columnsValue.EnumerateArray().Select(Cell).ToArray();
                var rows = rowsValue.EnumerateArray().Take(20).Where(row => row.ValueKind == JsonValueKind.Array && row.GetArrayLength() == columns.Length).Select(row => (IReadOnlyList<string>)row.EnumerateArray().Select(Cell).ToArray()).ToArray();
                var chars = columns.Sum(text => text.Length) + rows.Sum(row => row.Sum(text => text.Length));
                if (tableChars + chars > 10000) continue;
                tableChars += chars;
                tables.Add(new(columns, rows));
            }
        }
        return new(charts, files) { Tables = tables };
    }
}
