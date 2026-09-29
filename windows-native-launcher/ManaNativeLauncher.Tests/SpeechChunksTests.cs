using System.Linq;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #861: the non-streamed reply is spoken in chunks of up to 180 characters.
public class SpeechChunksTests
{
    [Fact]
    public void AShortReplyIsOneChunk()
    {
        Assert.Equal(["Hi there. It's 3.5 km away!"], VoiceLoop.SplitForSpeech("Hi there.\n  It's 3.5 km away!"));
    }

    [Fact]
    public void SentencesArePackedUpTo180Characters()
    {
        var sentence = new string('a', 59) + ".";                         // 60 chars
        var chunks = VoiceLoop.SplitForSpeech(string.Join(" ", Enumerable.Repeat(sentence, 5)));
        Assert.Equal([string.Join(" ", Enumerable.Repeat(sentence, 2)), string.Join(" ", Enumerable.Repeat(sentence, 2)), sentence], chunks);
        Assert.All(chunks, c => Assert.True(c.Length <= VoiceLoop.MaxSpeechChunkChars));
    }

    [Fact]
    public void ALongerSentenceIsAChunkOfItsOwn()
    {
        var longSentence = new string('b', 250) + "?";
        Assert.Equal(["Short one.", longSentence, "Done"], VoiceLoop.SplitForSpeech($"Short one. {longSentence} Done"));
    }

    [Fact]
    public void NothingToSayGivesNoChunks()
    {
        Assert.Empty(VoiceLoop.SplitForSpeech("  \n "));
    }
}
