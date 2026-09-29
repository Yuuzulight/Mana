using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

// #679: images pasted (Ctrl+V) or dropped into the message box, shown as
// thumbnails above it, each with an x to remove it; they go out with the
// next message. Each is scaled down for the vision model as it's added
// (ScreenCapture.ToVisionDataUrl). Hidden while empty.
internal sealed class ImageAttachmentStrip : FlowLayoutPanel
{
    public const int MaxImages = 4;
    private const int ThumbSize = 56;

    // What a dropped file can be; GIFs send their first frame.
    internal static readonly string[] ImageExtensions = { ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif" };

    public ImageAttachmentStrip()
    {
        Dock = DockStyle.Bottom;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(12, 6, 12, 0);
        BackColor = DarkTheme.Panel;
        Visible = false;
    }

    public int Count => Controls.Count;

    public IReadOnlyList<string> Images => Controls.Cast<Control>().Select(c => (string)c.Tag!).ToList();

    internal static bool IsImageFile(string path) =>
        ImageExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    // False once MaxImages are attached.
    public bool Add(Image image)
    {
        if (Count >= MaxImages)
        {
            return false;
        }
        var dataUrl = ScreenCapture.ToVisionDataUrl(image);
        var chip = new Panel { Size = new Size(ThumbSize, ThumbSize), Margin = new Padding(0, 0, 6, 6), BackColor = DarkTheme.Panel2, BorderStyle = BorderStyle.FixedSingle, Tag = dataUrl };
        var thumb = new PictureBox
        {
            Dock = DockStyle.Fill,
            SizeMode = PictureBoxSizeMode.Zoom,
            Image = new Bitmap(image, ScreenCapture.FitWithin(image.Size, ThumbSize)),
            AccessibleName = "Attached image",
        };
        var remove = new Button { Text = "×", Size = new Size(18, 18), Location = new Point(ThumbSize - 20, 0), FlatStyle = FlatStyle.Flat, BackColor = DarkTheme.Panel2, ForeColor = DarkTheme.Muted, AccessibleName = "Remove attached image" };
        remove.FlatAppearance.BorderSize = 0;
        remove.Click += (_, _) => RemoveChip(chip);
        chip.Controls.Add(remove);
        chip.Controls.Add(thumb);
        Controls.Add(chip);
        Visible = true;
        return true;
    }

    // An image file from disk; false if it's full or the file isn't an
    // image GDI+ can read (webp needs the Windows codec, for one).
    public bool AddFile(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            using var image = Image.FromStream(stream);
            return Add(image);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or OutOfMemoryException)
        {
            Console.WriteLine($"ImageAttachmentStrip: couldn't read {Path.GetFileName(path)} as an image. {ex.Message}");
            return false;
        }
    }

    public void Clear()
    {
        while (Controls.Count > 0)
        {
            RemoveChip(Controls[0]);
        }
    }

    private void RemoveChip(Control chip)
    {
        Controls.Remove(chip);
        foreach (var box in chip.Controls.OfType<PictureBox>())
        {
            box.Image?.Dispose();
        }
        chip.Dispose();
        Visible = Controls.Count > 0;
    }
}
