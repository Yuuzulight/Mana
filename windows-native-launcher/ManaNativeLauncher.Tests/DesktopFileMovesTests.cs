using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using Mana.NativeLauncher;
using Xunit;

namespace ManaNativeLauncher.Tests;

// #911: file moves, only inside the allowed folders. Every test uses its
// own temp folders as the allowed ones -- never my real Desktop/Downloads.
public sealed class DesktopFileMovesTests : IDisposable
{
    private readonly string temp = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "mana-moves-" + Guid.NewGuid().ToString("N"))).FullName;
    private readonly string downloads;
    private readonly string pictures;
    private readonly string outside;

    public DesktopFileMovesTests()
    {
        downloads = Directory.CreateDirectory(Path.Combine(temp, "Downloads")).FullName;
        pictures = Directory.CreateDirectory(Path.Combine(temp, "Pictures", "Screenshots")).Parent!.FullName;
        outside = Directory.CreateDirectory(Path.Combine(temp, "Outside")).FullName;
    }

    private string[] Roots => new[] { downloads, pictures };

    private static string Json(object value) => JsonSerializer.Serialize(value);

    [Fact]
    public void MoveFiles_MovesIntoAFolderAndRecordsEachMove()
    {
        var a = Touch(downloads, "shot1.png");
        var b = Touch(downloads, "shot2.png");
        var screenshots = Path.Combine(pictures, "Screenshots");

        var result = Json(DesktopActions.MoveFiles(new[] { a, b }, screenshots, exact: false, Roots));

        Assert.True(File.Exists(Path.Combine(screenshots, "shot1.png")));
        Assert.False(File.Exists(a));
        Assert.Contains(JsonSerializer.Serialize(Path.Combine(screenshots, "shot2.png")), result);
        Assert.Contains("\"failed\":[]", result);
    }

    [Fact]
    public void MoveFiles_RenamesAndUndoesWithExact()
    {
        var a = Touch(downloads, "IMG_001.png");
        var renamed = Path.Combine(downloads, "cat.png");

        DesktopActions.MoveFiles(new[] { a }, renamed, exact: false, Roots);
        Assert.True(File.Exists(renamed));
        DesktopActions.MoveFiles(new[] { renamed }, a, exact: true, Roots);
        Assert.True(File.Exists(a));
        // a folder that doesn't exist yet is not a new file name
        Assert.Throws<InvalidOperationException>(() => DesktopActions.MoveFiles(new[] { a }, Path.Combine(pictures, "Cats"), exact: false, Roots));
        Assert.True(File.Exists(a));
    }

    [Fact]
    public void MoveFiles_RenamesByCaseOnly()
    {
        var a = Touch(downloads, "cat.png");
        var folder = Directory.CreateDirectory(Path.Combine(downloads, "cats")).FullName;

        DesktopActions.MoveFiles(new[] { a }, Path.Combine(downloads, "Cat.png"), exact: false, Roots);
        DesktopActions.MoveFiles(new[] { folder }, Path.Combine(downloads, "Cats"), exact: false, Roots);

        Assert.Equal(new[] { "Cat.png", "Cats" }, new DirectoryInfo(downloads).GetFileSystemInfos().Select(e => e.Name).OrderBy(n => n, StringComparer.Ordinal));
    }

    // new_folder makes "to" first (write tier, so it's approved with the move),
    // but only inside a folder that exists.
    [Fact]
    public void MoveFiles_CreatesTheDestinationFolderWhenAsked()
    {
        var a = Touch(downloads, "shot1.png");
        var b = Touch(downloads, "shot2.png");
        var cats = Path.Combine(pictures, "Cats");

        Assert.Throws<InvalidOperationException>(() => DesktopActions.MoveFiles(new[] { a, b }, cats, exact: false, Roots));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.MoveFiles(new[] { a, b }, Path.Combine(pictures, "Pets", "Cats"), exact: false, Roots, newFolder: true));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.MoveFiles(new[] { a, b }, Path.Combine(outside, "Cats"), exact: false, Roots, newFolder: true));
        Assert.False(Directory.Exists(cats));

        DesktopActions.MoveFiles(new[] { a, b }, cats, exact: false, Roots, newFolder: true);

        Assert.True(File.Exists(Path.Combine(cats, "shot1.png")));
        Assert.True(File.Exists(Path.Combine(cats, "shot2.png")));
        Assert.False(Directory.Exists(Path.Combine(outside, "Cats")));
    }

    // Undo of that move: the new folder is reported, and goes again once
    // it's empty -- never while something is in it, never an allowed folder.
    [Fact]
    public void RemoveEmptyFolder_TakesAwayOnlyTheEmptyFolderAMoveMade()
    {
        var a = Touch(downloads, "shot1.png");
        var cats = Path.Combine(pictures, "Cats");

        var result = Json(DesktopActions.MoveFiles(new[] { a }, cats, exact: false, Roots, newFolder: true));
        Assert.Contains($"\"created\":{JsonSerializer.Serialize(cats)}", result);
        Assert.Contains("\"created\":null", Json(DesktopActions.MoveFiles(new[] { Touch(downloads, "shot2.png") }, cats, exact: false, Roots)));

        Assert.Throws<IOException>(() => DesktopActions.RemoveEmptyFolder(cats, Roots));
        Assert.True(File.Exists(Path.Combine(cats, "shot1.png")));
        DesktopActions.MoveFiles(new[] { Path.Combine(cats, "shot1.png") }, a, exact: true, Roots);
        DesktopActions.MoveFiles(new[] { Path.Combine(cats, "shot2.png") }, Path.Combine(downloads, "shot2.png"), exact: true, Roots);

        Assert.Contains("\"removed\":true", Json(DesktopActions.RemoveEmptyFolder(cats, Roots)));
        Assert.False(Directory.Exists(cats));
        Assert.Contains("\"removed\":false", Json(DesktopActions.RemoveEmptyFolder(cats, Roots)));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.RemoveEmptyFolder(pictures, Roots));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.RemoveEmptyFolder(Path.Combine(outside, "x"), Roots));
    }

    [Fact]
    public void MoveFiles_NeverLeavesTheAllowedFoldersOrOverwrites()
    {
        var a = Touch(downloads, "a.txt");
        File.WriteAllText(a, "from downloads");
        var existing = Touch(pictures, "a.txt");
        var secret = Touch(outside, "secret.txt");

        Assert.Throws<InvalidOperationException>(() => DesktopActions.MoveFiles(new[] { a }, outside, exact: false, Roots));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.MoveFiles(new[] { secret }, pictures, exact: false, Roots));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.MoveFiles(new[] { Path.Combine(downloads, "..", "Outside", "secret.txt") }, pictures, exact: false, Roots));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.MoveFiles(new[] { downloads }, pictures, exact: false, Roots));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.MoveFiles(new[] { a }, pictures, exact: false, Roots));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.MoveFiles(new[] { "a.txt" }, pictures, exact: false, Roots));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.MoveFiles(new[] { a + ":stream" }, pictures, exact: false, Roots));
        Assert.True(File.Exists(a));
        Assert.True(File.Exists(secret));
        Assert.Equal("", File.ReadAllText(existing));
    }

    [Fact]
    public void Allowed_RefusesAPathThroughALink()
    {
        var link = Path.Combine(downloads, "link");
        try
        {
            Directory.CreateSymbolicLink(link, outside);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            return; // no symlink rights here (no Developer Mode / admin); CI runs it
        }
        Touch(outside, "secret.txt");
        Assert.Throws<InvalidOperationException>(() => DesktopActions.Allowed(Path.Combine(link, "secret.txt"), Roots));
    }

    [Fact]
    public void ListFolder_ListsTheRootsOrAFolderNewestFirst()
    {
        var older = Touch(downloads, "old.png");
        File.SetLastWriteTime(older, DateTime.Now.AddDays(-1));
        Touch(downloads, "new.png");

        Assert.Contains(JsonSerializer.Serialize(downloads), Json(DesktopActions.ListFolder(null, Roots)));
        var listing = Json(DesktopActions.ListFolder(downloads, Roots));
        Assert.True(listing.IndexOf("new.png", StringComparison.Ordinal) < listing.IndexOf("old.png", StringComparison.Ordinal));
        Assert.Throws<InvalidOperationException>(() => DesktopActions.ListFolder(outside, Roots));
    }

    private static string Touch(string dir, string name)
    {
        var path = Path.Combine(dir, name);
        File.WriteAllText(path, "");
        return path;
    }

    public void Dispose()
    {
        foreach (var link in Directory.EnumerateDirectories(downloads, "link"))
        {
            Directory.Delete(link); // the link only, never its target
        }
        Directory.Delete(temp, recursive: true);
    }
}
