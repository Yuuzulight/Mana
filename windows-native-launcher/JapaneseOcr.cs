using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

namespace Mana.NativeLauncher;

// #910: translate requests OCR the foreground window with Windows' own OCR
// in Japanese -- node-bot's /screen/read is English-only Tesseract. Needs the
// Japanese OCR language pack (Settings > Time & language > Language &
// region > Japanese). Only the lines with Japanese in them are kept: a game
// window is mostly English UI, and node-bot clamps screen text to 1200 chars.
internal static class JapaneseOcr
{
    private const string JapaneseChars = @"\p{IsHiragana}\p{IsKatakana}\p{IsCJKUnifiedIdeographs}\p{IsCJKSymbolsandPunctuation}\p{IsHalfwidthandFullwidthForms}";
    private static readonly Regex HasJapanese = new($"[{JapaneseChars}]");
    // Windows OCR returns Japanese one character per word, space-separated.
    private static readonly Regex SpaceBetweenJapanese = new($@"(?<=[{JapaneseChars}])\s+(?=[{JapaneseChars}])");

    // The Japanese lines on screen, or (Japanese pack missing, none found, OCR
    // failed) a note pointing the model at vision__look instead.
    public static async Task<string> ReadAsync(Bitmap bitmap)
    {
        string reason;
        try
        {
            var engine = OcrEngine.TryCreateFromLanguage(new Language("ja"));
            if (engine is null)
            {
                reason = "can't read Japanese: the Windows Japanese OCR language pack isn't installed";
            }
            else
            {
                var text = JapaneseLines(await RecognizeAsync(engine, bitmap));
                if (text.Length > 0)
                {
                    return text;
                }
                reason = "found no Japanese text";
            }
        }
        catch (Exception ex)
        {
            reason = $"failed ({ex.Message})";
        }
        Console.WriteLine($"JapaneseOcr: screen OCR {reason}.");
        return $"[Screen OCR {reason}. If you have vision__look, use it to read the Japanese text on screen, then translate it; otherwise tell the user why you can't read it.]";
    }

    internal static string JapaneseLines(IEnumerable<string> lines) =>
        string.Join("\n", lines.Where(line => HasJapanese.IsMatch(line)).Select(line => SpaceBetweenJapanese.Replace(line, "")));

    private static async Task<IEnumerable<string>> RecognizeAsync(OcrEngine engine, Bitmap bitmap)
    {
        // RecognizeAsync rejects images over MaxImageDimension (a 4K window).
        var scale = Math.Min(1.0, OcrEngine.MaxImageDimension / (double)Math.Max(bitmap.Width, bitmap.Height));
        using var fitted = new Bitmap(bitmap, (int)(bitmap.Width * scale), (int)(bitmap.Height * scale));
        using var stream = new MemoryStream();
        fitted.Save(stream, ImageFormat.Bmp);
        stream.Position = 0;
        var decoder = await BitmapDecoder.CreateAsync(stream.AsRandomAccessStream());
        using var image = await decoder.GetSoftwareBitmapAsync();
        var result = await engine.RecognizeAsync(image);
        return result.Lines.Select(line => line.Text);
    }
}
