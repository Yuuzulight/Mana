using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

public class ChatMarkdownParserTests
{
    [Fact]
    public void Parse_PlainTextIsOneParagraphWithOneRun()
    {
        var blocks = ChatMarkdownParser.Parse("Hello there.");

        var block = Assert.Single(blocks);
        Assert.Equal(MarkdownBlockType.Paragraph, block.Type);
        var run = Assert.Single(block.Runs);
        Assert.Equal("Hello there.", run.Text);
        Assert.False(run.Bold);
        Assert.False(run.Italic);
        Assert.False(run.Code);
    }

    [Fact]
    public void Parse_BoldTextProducesABoldRun()
    {
        var blocks = ChatMarkdownParser.Parse("This is **important**.");

        var runs = blocks[0].Runs;
        Assert.Equal(3, runs.Count);
        Assert.Equal("This is ", runs[0].Text);
        Assert.Equal("important", runs[1].Text);
        Assert.True(runs[1].Bold);
        Assert.Equal(".", runs[2].Text);
    }

    [Theory]
    [InlineData("This is *emphasis* here.")]
    [InlineData("This is _emphasis_ here.")]
    public void Parse_ItalicMarkersProduceAnItalicRun(string markdown)
    {
        var runs = ChatMarkdownParser.Parse(markdown)[0].Runs;

        Assert.Equal("emphasis", runs[1].Text);
        Assert.True(runs[1].Italic);
    }

    [Fact]
    public void Parse_InlineCodeProducesACodeRun()
    {
        var runs = ChatMarkdownParser.Parse("Run `npm install` first.")[0].Runs;

        Assert.Equal("npm install", runs[1].Text);
        Assert.True(runs[1].Code);
    }

    [Fact]
    public void Parse_BoldIsNotMisreadAsTwoItalicSpans()
    {
        var runs = ChatMarkdownParser.Parse("**bold**")[0].Runs;

        var run = Assert.Single(runs);
        Assert.Equal("bold", run.Text);
        Assert.True(run.Bold);
        Assert.False(run.Italic);
    }

    [Theory]
    [InlineData("# Heading")]
    [InlineData("## Heading")]
    [InlineData("###### Heading")]
    public void Parse_HeaderLinesBecomeHeaderBlocks(string markdown)
    {
        var block = ChatMarkdownParser.Parse(markdown)[0];

        Assert.Equal(MarkdownBlockType.Header, block.Type);
        Assert.Equal("Heading", block.Runs[0].Text);
    }

    [Theory]
    [InlineData("- item one")]
    [InlineData("* item one")]
    public void Parse_BulletLinesBecomeBulletItemBlocksWithTheMarkerStripped(string markdown)
    {
        var block = ChatMarkdownParser.Parse(markdown)[0];

        Assert.Equal(MarkdownBlockType.BulletItem, block.Type);
        Assert.Equal("item one", block.Runs[0].Text);
    }

    [Fact]
    public void Parse_NumberedLinesBecomeNumberedItemBlocksKeepingTheirPrefix()
    {
        var block = ChatMarkdownParser.Parse("1. first step")[0];

        Assert.Equal(MarkdownBlockType.NumberedItem, block.Type);
        Assert.Equal("1. first step", block.Runs[0].Text);
    }

    [Fact]
    public void Parse_FencedCodeBlockBecomesOneCodeBlockPreservingNewlines()
    {
        var blocks = ChatMarkdownParser.Parse("```\nline one\nline two\n```");

        var block = Assert.Single(blocks);
        Assert.Equal(MarkdownBlockType.CodeBlock, block.Type);
        var run = Assert.Single(block.Runs);
        Assert.Equal("line one\nline two", run.Text);
        Assert.True(run.Code);
    }

    [Fact]
    public void Parse_FencedCodeBlockContentIsNotInlineFormatted()
    {
        // Asterisks inside a code fence are literal characters, not
        // markdown emphasis -- a naive line-by-line parser could
        // otherwise misfire here.
        var blocks = ChatMarkdownParser.Parse("```\nlet x = a * b;\n```");

        var run = blocks[0].Runs[0];
        Assert.Equal("let x = a * b;", run.Text);
        Assert.False(run.Bold);
        Assert.False(run.Italic);
    }

    [Fact]
    public void Parse_UnterminatedCodeFenceStillProducesACodeBlockInsteadOfHanging()
    {
        var blocks = ChatMarkdownParser.Parse("```\nline one");

        var block = Assert.Single(blocks);
        Assert.Equal(MarkdownBlockType.CodeBlock, block.Type);
        Assert.Equal("line one", block.Runs[0].Text);
    }

    [Fact]
    public void Parse_BlankLinesSeparateBlocksWithoutProducingEmptyOnes()
    {
        var blocks = ChatMarkdownParser.Parse("First paragraph.\n\nSecond paragraph.");

        Assert.Equal(2, blocks.Count);
        Assert.Equal("First paragraph.", blocks[0].Runs[0].Text);
        Assert.Equal("Second paragraph.", blocks[1].Runs[0].Text);
    }

    [Fact]
    public void Parse_MultipleBlockTypesInOneReply()
    {
        var blocks = ChatMarkdownParser.Parse("# Steps\n- first\n- second\nDone.");

        Assert.Equal(4, blocks.Count);
        Assert.Equal(MarkdownBlockType.Header, blocks[0].Type);
        Assert.Equal(MarkdownBlockType.BulletItem, blocks[1].Type);
        Assert.Equal(MarkdownBlockType.BulletItem, blocks[2].Type);
        Assert.Equal(MarkdownBlockType.Paragraph, blocks[3].Type);
    }

    [Theory]
    [InlineData("Hello **world")]
    [InlineData("Run `npm install")]
    [InlineData("This is *emphasis")]
    public void Parse_UnmatchedInlineMarkersFallBackToLiteralTextInsteadOfCrashing(string markdown)
    {
        var runs = ChatMarkdownParser.Parse(markdown)[0].Runs;

        var run = Assert.Single(runs);
        Assert.Equal(markdown, run.Text);
        Assert.False(run.Bold);
        Assert.False(run.Italic);
        Assert.False(run.Code);
    }

    [Fact]
    public void Parse_HeaderLineComposesWithInlineBold()
    {
        var block = ChatMarkdownParser.Parse("# **Bold** Heading")[0];

        Assert.Equal(MarkdownBlockType.Header, block.Type);
        Assert.Equal(2, block.Runs.Count);
        Assert.Equal("Bold", block.Runs[0].Text);
        Assert.True(block.Runs[0].Bold);
        Assert.Equal(" Heading", block.Runs[1].Text);
    }

    [Fact]
    public void Parse_BulletItemComposesWithInlineCode()
    {
        var block = ChatMarkdownParser.Parse("- item with `code`")[0];

        Assert.Equal(MarkdownBlockType.BulletItem, block.Type);
        Assert.Equal("item with ", block.Runs[0].Text);
        Assert.Equal("code", block.Runs[1].Text);
        Assert.True(block.Runs[1].Code);
    }

    [Fact]
    public void Parse_EmptyStringProducesNoBlocks()
    {
        Assert.Empty(ChatMarkdownParser.Parse(""));
    }

    [Fact]
    public void Parse_NullProducesNoBlocksInsteadOfThrowing()
    {
        Assert.Empty(ChatMarkdownParser.Parse(null));
    }
}
