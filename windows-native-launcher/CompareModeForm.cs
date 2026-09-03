using System;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #527: ports windows-launcher/renderer/compare-mode.js's UI -- sends
// one prompt to two model profiles concurrently and shows both replies
// side by side. Plain-text result panes (no markdown rendering) --
// matches this issue's own scope note.
//
// Non-modal (Show, not ShowDialog) and fresh each time it's opened from
// the tray menu -- a modal here would block the rest of the app for
// however long two LLM replies take, and there's no state worth
// preserving across opens (Show/Close disposes normally, no reuse
// pattern needed for a window this simple).
internal sealed class CompareModeForm : Form
{
    // Dark-theme-appropriate selection tint (matches the accent-tinted
    // highlight SessionListForm/SettingsPanel already use for "this one's
    // selected/active") -- the original light pastel green was sized for
    // a white TextBox background.
    private static readonly Color PreferredColor = Color.FromArgb(0x33, 0x2d, 0x52);

    private readonly ManaBackendClient backendClient;
    private readonly TextBox promptBox = new();
    private readonly Button runButton = new();
    private readonly Button cancelButton = new();
    private readonly ComboBox profileABox = new();
    private readonly ComboBox profileBBox = new();
    private readonly TextBox resultABox = new();
    private readonly TextBox resultBBox = new();
    private readonly Button preferAButton = new();
    private readonly Button preferBButton = new();

    private ManaModelStatus? modelStatus;
    private CancellationTokenSource? runCts;

    public CompareModeForm(ManaBackendClient backendClient)
    {
        this.backendClient = backendClient;

        Text = "Mana Compare Models";
        Width = 900;
        Height = 560;
        StartPosition = FormStartPosition.CenterScreen;
        DarkTheme.ApplyForm(this);

        var topRow = new TableLayoutPanel { Dock = DockStyle.Top, Height = 32, ColumnCount = 3, BackColor = DarkTheme.Background };
        promptBox.Dock = DockStyle.Fill;
        promptBox.BackColor = DarkTheme.Panel;
        promptBox.ForeColor = DarkTheme.Text;
        promptBox.BorderStyle = BorderStyle.FixedSingle;
        runButton.Text = "Run";
        runButton.Dock = DockStyle.Fill;
        runButton.Click += async (_, _) => await RunAsync();
        DarkTheme.ApplyButton(runButton);
        cancelButton.Text = "Cancel";
        cancelButton.Dock = DockStyle.Fill;
        cancelButton.Enabled = false;
        cancelButton.Click += (_, _) => runCts?.Cancel();
        DarkTheme.ApplyButton(cancelButton);
        topRow.Controls.Add(promptBox, 0, 0);
        topRow.Controls.Add(runButton, 1, 0);
        topRow.Controls.Add(cancelButton, 2, 0);
        topRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 70));
        topRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 15));
        topRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 15));

        var pickerRow = new TableLayoutPanel { Dock = DockStyle.Top, Height = 28, ColumnCount = 2, BackColor = DarkTheme.Background };
        profileABox.Dock = DockStyle.Fill;
        profileABox.DropDownStyle = ComboBoxStyle.DropDownList;
        profileABox.BackColor = DarkTheme.Panel;
        profileABox.ForeColor = DarkTheme.Text;
        profileBBox.Dock = DockStyle.Fill;
        profileBBox.DropDownStyle = ComboBoxStyle.DropDownList;
        profileBBox.BackColor = DarkTheme.Panel;
        profileBBox.ForeColor = DarkTheme.Text;
        pickerRow.Controls.Add(profileABox, 0, 0);
        pickerRow.Controls.Add(profileBBox, 1, 0);
        pickerRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        pickerRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));

        var resultsRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, BackColor = DarkTheme.Background };
        resultABox.Multiline = true;
        resultABox.ReadOnly = true;
        resultABox.ScrollBars = ScrollBars.Vertical;
        resultABox.Dock = DockStyle.Fill;
        resultABox.BackColor = DarkTheme.Panel;
        resultABox.ForeColor = DarkTheme.Text;
        resultABox.BorderStyle = BorderStyle.FixedSingle;
        resultBBox.Multiline = true;
        resultBBox.ReadOnly = true;
        resultBBox.ScrollBars = ScrollBars.Vertical;
        resultBBox.Dock = DockStyle.Fill;
        resultBBox.BackColor = DarkTheme.Panel;
        resultBBox.ForeColor = DarkTheme.Text;
        resultBBox.BorderStyle = BorderStyle.FixedSingle;
        preferAButton.Text = "Prefer A";
        preferAButton.Dock = DockStyle.Fill;
        preferAButton.Click += (_, _) => SetPreferred(preferredA: true);
        DarkTheme.ApplyButton(preferAButton);
        preferBButton.Text = "Prefer B";
        preferBButton.Dock = DockStyle.Fill;
        preferBButton.Click += (_, _) => SetPreferred(preferredA: false);
        DarkTheme.ApplyButton(preferBButton);
        resultsRow.Controls.Add(resultABox, 0, 0);
        resultsRow.Controls.Add(resultBBox, 1, 0);
        resultsRow.Controls.Add(preferAButton, 0, 1);
        resultsRow.Controls.Add(preferBButton, 1, 1);
        resultsRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        resultsRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        resultsRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        resultsRow.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));

        Controls.Add(resultsRow);
        Controls.Add(pickerRow);
        Controls.Add(topRow);

        Load += async (_, _) => await LoadModelStatusAsync();
    }

    private void SetPreferred(bool preferredA)
    {
        // Purely a visual highlight -- matches the reference's own
        // setComparePreferred, no backend call, nothing persisted.
        resultABox.BackColor = preferredA ? PreferredColor : DarkTheme.Panel;
        resultBBox.BackColor = preferredA ? DarkTheme.Panel : PreferredColor;
    }

    private async Task LoadModelStatusAsync()
    {
        try
        {
            modelStatus = await backendClient.GetModelStatusAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"CompareModeForm: failed to load model status. {ex.Message}");
            return;
        }

        if (IsDisposed)
        {
            return;
        }

        var (defaultA, defaultB) = CompareModeFormatter.PickDefaultProfiles(modelStatus.Profiles.Keys);
        PopulateProfileBox(profileABox, defaultA);
        PopulateProfileBox(profileBBox, defaultB);
    }

    private void PopulateProfileBox(ComboBox box, string? select)
    {
        if (modelStatus is null)
        {
            return;
        }

        box.Items.Clear();
        foreach (var key in modelStatus.Profiles.Keys)
        {
            box.Items.Add(key);
        }
        if (select is not null && box.Items.Contains(select))
        {
            box.SelectedItem = select;
        }
        else if (box.Items.Count > 0)
        {
            box.SelectedIndex = 0;
        }

        UpdateLabels();
    }

    private void UpdateLabels()
    {
        if (modelStatus is null)
        {
            return;
        }
        var profileA = profileABox.SelectedItem as string;
        var profileB = profileBBox.SelectedItem as string;
        Text = "Mana Compare Models"
            + (profileA is not null ? $" -- A: {CompareModeFormatter.FormatProfileLabel(profileA, modelStatus.Profiles)}" : "")
            + (profileB is not null ? $" | B: {CompareModeFormatter.FormatProfileLabel(profileB, modelStatus.Profiles)}" : "");
    }

    private async Task RunAsync()
    {
        var text = promptBox.Text.Trim();
        if (text.Length == 0 || runCts is not null)
        {
            return;
        }

        SetPreferred(preferredA: false);
        resultABox.BackColor = DarkTheme.Panel;
        resultBBox.BackColor = DarkTheme.Panel;
        UpdateLabels();
        resultABox.Text = "Thinking...";
        resultBBox.Text = "Thinking...";
        runButton.Enabled = false;
        cancelButton.Enabled = true;

        var profileA = profileABox.SelectedItem as string;
        var profileB = profileBBox.SelectedItem as string;

        runCts = new CancellationTokenSource();
        var token = runCts.Token;
        var taskA = FetchAsync(text, profileA, token);
        var taskB = FetchAsync(text, profileB, token);
        try
        {
            // Task.WhenAll itself throws (the first observed exception)
            // when awaited if either task faulted or was cancelled --
            // DescribeOutcome below is what actually inspects each
            // task's own IsFaulted/IsCanceled/Result independently, so
            // WhenAll's own exception is deliberately swallowed here
            // rather than left to propagate out of this handler unhandled.
            await Task.WhenAll(taskA, taskB);
        }
        catch
        {
        }

        if (!IsDisposed)
        {
            resultABox.Text = DescribeOutcome(taskA);
            resultBBox.Text = DescribeOutcome(taskB);
            runButton.Enabled = true;
            cancelButton.Enabled = false;
        }

        runCts.Dispose();
        runCts = null;
    }

    private async Task<string> FetchAsync(string text, string? profile, CancellationToken token)
    {
        return await backendClient.ReplyAsync(text, profile, token);
    }

    private static string DescribeOutcome(Task<string> task)
    {
        if (task.IsCanceled)
        {
            return "Cancelled.";
        }
        if (task.IsFaulted)
        {
            var error = task.Exception?.InnerException?.Message ?? task.Exception?.Message ?? "unknown error";
            return $"Failed: {error}";
        }
        return task.Result;
    }
}
