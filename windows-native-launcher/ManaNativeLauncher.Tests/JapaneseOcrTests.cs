using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #910
public class JapaneseOcrTests
{
    [Fact]
    public void JapaneseLines_KeepsOnlyJapaneseLinesAndJoinsTheirCharacters()
    {
        var lines = new[] { "HP 51234", "Tataru Taru: よ ろ し く お 願 い し ま す 。", "Party Finder", "(Y'shtola) 了 解 ！ ok" };

        Assert.Equal("Tataru Taru: よろしくお願いします。\n(Y'shtola) 了解！ ok", JapaneseOcr.JapaneseLines(lines));
    }
}
