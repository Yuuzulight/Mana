using System.Drawing;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #668: messages typed while Mana is still replying, shown above the
// message box as chips -- each one a text box, so clicking it edits the
// message in place, with an x to drop it. SessionListForm sends them oldest
// first, each as its own turn, once she's idle again. Hidden while empty.
internal sealed class MessageQueueStrip : FlowLayoutPanel
{
    public MessageQueueStrip()
    {
        Dock = DockStyle.Bottom;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(12, 6, 12, 0);
        BackColor = DarkTheme.Panel;
        Visible = false;
    }

    public int Count => Controls.Count;

    public void Add(string text)
    {
        var chip = new Panel { Size = new Size(220, 26), Margin = new Padding(0, 0, 6, 6), Padding = new Padding(6, 4, 0, 0), BackColor = DarkTheme.Panel2, BorderStyle = BorderStyle.FixedSingle };
        var edit = new TextBox { Text = text, Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Text, AccessibleName = "Queued message" };
        var remove = new Button { Text = "×", Dock = DockStyle.Right, Width = 22, FlatStyle = FlatStyle.Flat, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Muted, AccessibleName = "Remove queued message" };
        remove.FlatAppearance.BorderSize = 0;
        remove.Click += (_, _) => RemoveChip(chip);
        chip.Controls.Add(edit);
        chip.Controls.Add(remove);
        Controls.Add(chip);
        Visible = true;
    }

    // The oldest message ready to send, dropping chips edited down to
    // nothing. Null while the queue is empty or that chip is being edited,
    // so a half-typed edit never goes out.
    public string? PeekReady()
    {
        while (Controls.Count > 0)
        {
            var chip = Controls[0];
            if (chip.ContainsFocus)
            {
                return null;
            }
            var text = chip.Controls[0].Text;
            if (text.Trim().Length > 0)
            {
                return text;
            }
            RemoveChip(chip);
        }
        return null;
    }

    public void RemoveFirst() => RemoveChip(Controls[0]);

    // False if there was nothing to clear.
    public bool ClearAll()
    {
        if (Controls.Count == 0)
        {
            return false;
        }
        while (Controls.Count > 0)
        {
            RemoveChip(Controls[0]);
        }
        return true;
    }

    private void RemoveChip(Control chip)
    {
        Controls.Remove(chip);
        chip.Dispose();
        Visible = Controls.Count > 0;
    }
}
