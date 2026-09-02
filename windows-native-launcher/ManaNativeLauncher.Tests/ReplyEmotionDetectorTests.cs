using Mana.NativeLauncher.Live2D;
using Xunit;

namespace ManaNativeLauncher.Tests;

// Ported test-for-test from windows-launcher/test/reply-emotion.test.js so
// this C# port's behavior is directly checked against the same real-world
// cases the JS original was tuned against.
public class ReplyEmotionDetectorTests
{
    [Fact]
    public void DetectTextMood_ReadsManasOwnSmilingKaomojis()
    {
        Assert.Equal("smile", ReplyEmotionDetector.DetectTextMood("Hey there! (´▽｀)"));
        Assert.Equal("smile", ReplyEmotionDetector.DetectTextMood("Sure thing (￣▽￣)"));
        Assert.Equal("smile", ReplyEmotionDetector.DetectTextMood("(＾▽＾) let's do it"));
    }

    [Fact]
    public void DetectTextMood_ReadsSadAngryKaomojis()
    {
        Assert.Equal("sniff", ReplyEmotionDetector.DetectTextMood("I miss you (T_T)"));
        Assert.Equal("grr", ReplyEmotionDetector.DetectTextMood("Hmph! (＃｀´)"));
        Assert.Equal("ow", ReplyEmotionDetector.DetectTextMood("(>_<) that hurt"));
    }

    [Fact]
    public void DetectTextMood_ReadsFlatUnimpressedEyesAsDisgustNotASmile()
    {
        Assert.Equal("disgust", ReplyEmotionDetector.DetectTextMood("(-_-) really?"));
        Assert.Equal("disgust", ReplyEmotionDetector.DetectTextMood("that's gross (-.-)"));
        Assert.Equal("disgust", ReplyEmotionDetector.DetectTextMood("(=_=) no thanks"));
    }

    [Fact]
    public void DetectTextMood_IgnoresOrdinaryParentheticals()
    {
        Assert.Null(ReplyEmotionDetector.DetectTextMood("Sure (see the docs) sounds good"));
        Assert.Null(ReplyEmotionDetector.DetectTextMood("no kaomoji or emoji here at all"));
    }

    [Fact]
    public void DetectTextMood_ReadsEmojiAsAFallbackSignal()
    {
        Assert.Equal("smile", ReplyEmotionDetector.DetectTextMood("That's wonderful \U0001F60A"));
        Assert.Equal("grr", ReplyEmotionDetector.DetectTextMood("I'm so mad right now \U0001F620"));
        Assert.Equal("sniff", ReplyEmotionDetector.DetectTextMood("aww \U0001F97A"));
    }

    [Fact]
    public void DetectTextMood_PrefersKaomojiOverEmojiWhenBothArePresent()
    {
        Assert.Equal("sniff", ReplyEmotionDetector.DetectTextMood("(T_T) even though \U0001F60A"));
    }

    [Fact]
    public void MoodToState_MapsMoodsToAvatarStatesAmbiguousMoodsStayNeutral()
    {
        Assert.Equal("excited", ReplyEmotionDetector.MoodToState("smile"));
        Assert.Equal("sad", ReplyEmotionDetector.MoodToState("sniff"));
        Assert.Equal("angry", ReplyEmotionDetector.MoodToState("grr"));
        Assert.Equal("disgusted", ReplyEmotionDetector.MoodToState("disgust"));
        Assert.Equal("talking", ReplyEmotionDetector.MoodToState("hmm"));
        Assert.Null(ReplyEmotionDetector.MoodToState("nonexistent-mood"));
    }

    // A lone/unpaired surrogate (e.g. a truncated multi-byte emoji from a
    // malformed upstream response) must not crash emoji detection --
    // char.ConvertToUtf32 throws on this, unlike a JS regex test, which
    // simply doesn't match malformed UTF-16 rather than throwing.
    [Fact]
    public void DetectTextMood_DoesNotThrowOnALoneUnpairedSurrogate()
    {
        var loneHighSurrogate = "Hello \uD83D there";
        var loneLowSurrogate = "Hello \uDE0A there";
        var highSurrogateAtStringEnd = "Hello \uD83D";

        Assert.Null(ReplyEmotionDetector.DetectTextMood(loneHighSurrogate));
        Assert.Null(ReplyEmotionDetector.DetectTextMood(loneLowSurrogate));
        Assert.Null(ReplyEmotionDetector.DetectTextMood(highSurrogateAtStringEnd));
    }

    [Fact]
    public void DetectReplyEmotion_UsesKaomojiEmojiMoodBeforeWordPatterns()
    {
        Assert.Equal("excited", ReplyEmotionDetector.DetectReplyEmotion("The sun is shining today! (´▽｀)"));
        Assert.Equal("sad", ReplyEmotionDetector.DetectReplyEmotion("(T_T) I'm sorry that happened"));
        Assert.Equal("angry", ReplyEmotionDetector.DetectReplyEmotion("Hmph! (＃｀´)"));
        Assert.Equal("disgusted", ReplyEmotionDetector.DetectReplyEmotion("(-_-) that's gross"));
    }

    [Fact]
    public void DetectReplyEmotion_FallsBackToEnglishMoodWordsWithNoKaomojiEmoji()
    {
        Assert.Equal("excited", ReplyEmotionDetector.DetectReplyEmotion("Yay!! Let's go!"));
        Assert.Equal("angry", ReplyEmotionDetector.DetectReplyEmotion("Ugh, stop that, seriously"));
        Assert.Equal("disgusted", ReplyEmotionDetector.DetectReplyEmotion("Ew, that's so gross and disgusting."));
        Assert.Equal("talking", ReplyEmotionDetector.DetectReplyEmotion("The weather looks calm today."));
    }
}
