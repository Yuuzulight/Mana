namespace Mana.AnalysisSandbox;

// #1409: scratch storage, measured one directory at a time. Windows denies
// access to an entry pending deletion until its last handle closes, and a
// single recursive enumeration let that end the whole scan, so a script
// churning temporary folders failed its run. A denied subdirectory is tried
// again briefly: gone means it was deleted and is skipped; still there and
// still denied fails closed, so nothing can hide storage from the limit.
internal static class ScratchScan
{
    private const int DeniedTries = 3;

    // Bytes in files under root (stops adding once past maxBytes); throws past maxEntries.
    internal static long Measure(string root, long maxBytes, int maxEntries)
    {
        var options = new EnumerationOptions { AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false };
        var pending = new Stack<string>();
        pending.Push(root);
        long bytes = 0;
        var count = 0;
        while (pending.Count > 0 && bytes <= maxBytes)
        {
            var directory = pending.Pop();
            var (countBefore, bytesBefore) = (count, bytes);
            for (var attempt = 1; ; attempt++)
            {
                var found = new List<string>();
                try
                {
                    // Sizes come from the listing itself; no file is opened.
                    foreach (var entry in new DirectoryInfo(directory).EnumerateFileSystemInfos("*", options))
                    {
                        if (++count > maxEntries) throw new IOException("scratch entry limit exceeded");
                        if (entry is FileInfo file) bytes += file.Length;
                        else found.Add(entry.FullName);
                    }
                    found.ForEach(pending.Push);
                    break;
                }
                // Removed during the scan.
                catch (DirectoryNotFoundException) { break; }
                catch (UnauthorizedAccessException) when (directory != root && attempt < DeniedTries)
                {
                    (count, bytes) = (countBefore, bytesBefore);
                    Thread.Sleep(20);
                    if (!Directory.Exists(directory)) break;
                }
            }
        }
        return bytes;
    }
}
