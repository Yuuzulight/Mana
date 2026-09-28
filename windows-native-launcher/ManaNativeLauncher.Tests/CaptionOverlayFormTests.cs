using System.Linq;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

[Collection("DarkTheme palette")] // reads the shared static palette
public class CaptionOverlayFormTests
{
    [Fact]
    public void SetCaption_GrowsTheBarToFitEveryWrappedLine()
    {
        using var form = new CaptionOverlayForm();
        form.SetCaption("One line.");
        var oneLine = form.Height;

        form.SetCaption(string.Join(" ", Enumerable.Repeat("Since you mentioned your name, I'm guessing that might be your full one.", 4)));

        // ~290 chars at 608px wraps to 4 lines; 20px is the bar's padding.
        const int padding = 20;
        Assert.True(form.Height - padding >= 3 * (oneLine - padding), $"expected at least 3 lines, got a {form.Height}px bar vs {oneLine}px for one line");
    }
}
