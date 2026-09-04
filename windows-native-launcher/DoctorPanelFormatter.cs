namespace Mana.NativeLauncher;

// #526: ports windows-launcher/renderer/doctor-panel.js's formatting
// logic almost verbatim -- pure, no UI dependency, so it's testable
// without a Form. DoctorPanelForm owns the actual rendering.
internal readonly record struct DoctorCheckRow(string Id, string Label, string Status, string Message);

internal readonly record struct DoctorPanelView(string Heading, string Summary, IReadOnlyList<DoctorCheckRow> Rows);

internal static class DoctorPanelFormatter
{
    private static readonly HashSet<string> KnownStatuses = new(System.StringComparer.Ordinal) { "pass", "warn", "fail" };

    public static string NormalizeStatus(string status) => KnownStatuses.Contains(status) ? status : "warn";

    public static DoctorPanelView Format(ManaDoctorResult result)
    {
        var rows = new List<DoctorCheckRow>();
        foreach (var check in result.Checks)
        {
            rows.Add(new DoctorCheckRow(
                check.Id,
                string.IsNullOrEmpty(check.Label) ? (string.IsNullOrEmpty(check.Id) ? "Check" : check.Id) : check.Label,
                NormalizeStatus(check.Status),
                check.Message));
        }

        return new DoctorPanelView(
            Heading: result.Ok ? "Doctor: ready" : "Doctor: attention needed",
            Summary: $"{result.Pass} pass, {result.Warn} warn, {result.Fail} fail",
            Rows: rows);
    }
}
