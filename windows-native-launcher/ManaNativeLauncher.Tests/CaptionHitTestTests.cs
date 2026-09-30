using System.Drawing;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// The Mana preset's title strip hands these areas back to Windows.
public class CaptionHitTestTests
{
    private static int Hit(int x, int y, bool maximized = false) =>
        SessionListForm.CaptionHitTest(new Point(x, y), width: 900, captionHeight: 32, buttonWidth: 46, resizeBorder: 5, maximized);

    [Theory]
    [InlineData(899, 16, SessionListForm.HtClose)]
    [InlineData(854, 16, SessionListForm.HtClose)]
    [InlineData(853, 16, SessionListForm.HtMaxButton)] // snap layouts on Windows 11
    [InlineData(808, 16, SessionListForm.HtMaxButton)]
    [InlineData(807, 16, SessionListForm.HtMinButton)]
    [InlineData(400, 16, SessionListForm.HtCaption)]
    [InlineData(12, 16, SessionListForm.HtCaption)]
    [InlineData(400, 32, SessionListForm.HtClient)]
    [InlineData(400, 2, SessionListForm.HtTop)]
    [InlineData(3, 2, SessionListForm.HtTopLeft)]
    [InlineData(897, 2, SessionListForm.HtTopRight)]
    public void MapsTheStripToWindowsAreas(int x, int y, int expected) => Assert.Equal(expected, Hit(x, y));

    [Fact]
    public void Maximized_HasNoTopResizeEdge()
    {
        Assert.Equal(SessionListForm.HtCaption, Hit(400, 2, maximized: true));
        Assert.Equal(SessionListForm.HtClose, Hit(897, 2, maximized: true));
    }
}
