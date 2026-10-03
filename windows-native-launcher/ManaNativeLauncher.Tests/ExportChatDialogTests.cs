using System.Linq;
using System.Windows.Forms;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #1323: export options dialog unit tests.
[Collection("DarkTheme palette")]
public class ExportChatDialogTests
{
    [Fact]
    public void Defaults_AreMarkdownWithToolsAndThoughtsUnchecked()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var dialog = new ExportChatDialog();
            Assert.Equal("markdown", dialog.SelectedFormat);
            Assert.False(dialog.IncludeTools);
            Assert.False(dialog.IncludeThoughts);
        });
    }

    [Fact]
    public void FormatPicker_ReflectsHtmlAndJsonlSelections()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var dialog = new ExportChatDialog();
            var picker = dialog.Controls.OfType<TableLayoutPanel>().Single().Controls.OfType<ComboBox>().Single();

            picker.SelectedIndex = 1;
            Assert.Equal("html", dialog.SelectedFormat);

            picker.SelectedIndex = 2;
            Assert.Equal("jsonl", dialog.SelectedFormat);
        });
    }

    [Fact]
    public void CheckBoxes_ControlInclusionFlags()
    {
        ToolPanelHostTests.RunSta(() =>
        {
            using var dialog = new ExportChatDialog();
            var options = dialog.Controls.OfType<TableLayoutPanel>().Single().Controls.OfType<FlowLayoutPanel>().Single();
            var checks = options.Controls.OfType<CheckBox>().ToList();

            var tools = checks.Single(c => c.Text.Contains("tool calls"));
            var thoughts = checks.Single(c => c.Text.Contains("reasoning"));

            tools.Checked = true;
            thoughts.Checked = true;

            Assert.True(dialog.IncludeTools);
            Assert.True(dialog.IncludeThoughts);
        });
    }
}
