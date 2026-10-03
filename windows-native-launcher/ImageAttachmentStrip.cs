using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace Mana.NativeLauncher;

internal sealed record DocumentAttachment(string FilePath, string FileName, string FormattedSize);

// #679: images pasted (Ctrl+V) or dropped into the message box.
// #1325: documents (PDF, Word, Excel, PowerPoint, CSV, Text, Markdown) attached via
// drag-and-drop, paste, or the paperclip button, shown as chips with name and size.
internal sealed class ImageAttachmentStrip : FlowLayoutPanel
{
    public const int MaxImages = 4;
    public const int MaxDocuments = 4;
    public const int MaxItems = 8;
    private const int ThumbSize = 56;

    // What a dropped file can be; GIFs send their first frame.
    internal static readonly string[] ImageExtensions = { ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif" };
    internal static readonly string[] DocumentExtensions = { ".pdf", ".docx", ".xlsx", ".pptx", ".csv", ".txt", ".md" };

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

    public IReadOnlyList<string> Images => Controls.Cast<Control>()
        .Where(c => c.Tag is string s && s.StartsWith("data:image/"))
        .Select(c => (string)c.Tag!)
        .ToList();

    public IReadOnlyList<string> Documents => Controls.Cast<Control>()
        .Where(c => c.Tag is DocumentAttachment)
        .Select(c => ((DocumentAttachment)c.Tag!).FilePath)
        .ToList();

    internal static bool IsImageFile(string path) =>
        ImageExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    internal static bool IsDocumentFile(string path) =>
        DocumentExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    internal static bool IsSupportedFile(string path) =>
        IsImageFile(path) || IsDocumentFile(path);

    internal static string FormatFileSize(long bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024.0:F1} KB";
        return $"{bytes / (1024.0 * 1024.0):F1} MB";
    }

    // False once MaxImages or MaxItems are attached.
    public bool Add(Image image)
    {
        if (Images.Count >= MaxImages || Count >= MaxItems)
        {
            return false;
        }
        ScreenCapture.ApplyExifOrientation(image);
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

    // #1325: Attach a document chip showing icon badge, file name, and size.
    public bool AddDocumentFile(string path)
    {
        if (!File.Exists(path))
        {
            return false;
        }
        if (Documents.Count >= MaxDocuments || Count >= MaxItems)
        {
            return false;
        }
        var ext = Path.GetExtension(path);
        if (!IsDocumentFile(path))
        {
            return false;
        }

        try
        {
            var info = new FileInfo(path);
            var sizeStr = FormatFileSize(info.Length);
            var docAttachment = new DocumentAttachment(path, info.Name, sizeStr);

            var chip = new Panel
            {
                Height = 36,
                Width = 200,
                Margin = new Padding(0, 0, 6, 6),
                BackColor = DarkTheme.Panel2,
                BorderStyle = BorderStyle.FixedSingle,
                Tag = docAttachment,
                AccessibleName = $"Attached document {info.Name}",
            };

            // Badge with extension name
            var badgeText = ext.TrimStart('.').ToUpperInvariant();
            var badgeColor = badgeText switch
            {
                "PDF" => Color.FromArgb(235, 87, 87),
                "DOCX" => Color.FromArgb(74, 144, 226),
                "XLSX" => Color.FromArgb(39, 174, 96),
                "PPTX" => Color.FromArgb(242, 153, 74),
                "CSV" => Color.FromArgb(0, 180, 180),
                _ => Color.FromArgb(160, 150, 200),
            };

            var badge = new Label
            {
                Text = badgeText,
                Font = new Font("Segoe UI", 7.5f, FontStyle.Bold),
                ForeColor = badgeColor,
                BackColor = Color.FromArgb(30, badgeColor),
                TextAlign = ContentAlignment.MiddleCenter,
                Size = new Size(42, 24),
                Location = new Point(6, 5),
            };

            var nameLabel = new Label
            {
                Text = info.Name,
                Font = new Font("Segoe UI", 8.5f, FontStyle.Regular),
                ForeColor = DarkTheme.Text,
                AutoEllipsis = true,
                Location = new Point(52, 3),
                Size = new Size(124, 16),
            };

            var sizeLabel = new Label
            {
                Text = sizeStr,
                Font = new Font("Segoe UI", 7.2f, FontStyle.Regular),
                ForeColor = DarkTheme.Muted,
                Location = new Point(52, 19),
                Size = new Size(124, 14),
            };

            var remove = new Button
            {
                Text = "×",
                Size = new Size(18, 18),
                Location = new Point(178, 8),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.Transparent,
                ForeColor = DarkTheme.Muted,
                AccessibleName = $"Remove {info.Name}",
            };
            remove.FlatAppearance.BorderSize = 0;
            remove.Click += (_, _) => RemoveChip(chip);

            chip.Controls.Add(remove);
            chip.Controls.Add(nameLabel);
            chip.Controls.Add(sizeLabel);
            chip.Controls.Add(badge);

            Controls.Add(chip);
            Visible = true;
            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"ImageAttachmentStrip: couldn't attach document {Path.GetFileName(path)}. {ex.Message}");
            return false;
        }
    }

    // A file from disk; delegates to Add(image) or AddDocumentFile(path).
    public bool AddFile(string path)
    {
        if (IsImageFile(path))
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
        if (IsDocumentFile(path))
        {
            return AddDocumentFile(path);
        }
        return false;
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
