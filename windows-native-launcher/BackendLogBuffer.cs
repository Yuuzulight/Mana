using System.Collections.Generic;

namespace Mana.NativeLauncher;

// #582: a fixed-size ring buffer of the spawned node-bot process's
// stdout/stderr lines -- fed from ManaProcessManager's
// OutputDataReceived/ErrorDataReceived handlers (a threadpool thread),
// read from the Logs settings tab (the UI thread), so Add/Snapshot both
// lock. 500 lines matches windows-launcher's own backend-log ring buffer
// (main.js's appendBackendLog).
internal sealed class BackendLogBuffer
{
    private const int MaxLines = 500;
    private readonly object gate = new();
    private readonly Queue<string> lines = new();

    // Each line also goes to this file once set (node-bot/data/logs/backend.log),
    // so a crash is still there after the launcher closes. Opened per line and
    // closed again: no handle stays open. Best effort.
    // ponytail: no size cap within a run; a cap if a long run's log gets big.
    private string? filePath;

    // A fresh file for a new backend run; the last one becomes *.prev.log.
    // Under the lock, so no line is being written while the file moves.
    public void StartFile(string path)
    {
        lock (gate)
        {
            ManaProcessManager.StartLogFile(path);
            filePath = path;
        }
    }

    public void Add(string line)
    {
        lock (gate)
        {
            lines.Enqueue(line);
            while (lines.Count > MaxLines)
            {
                lines.Dequeue();
            }
            if (filePath is { } path)
            {
                try
                {
                    // Timestamped on disk only: node-bot's own lines carry no time.
                    File.AppendAllText(path, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {line}{Environment.NewLine}");
                }
                catch
                {
                    // Best effort.
                }
            }
        }
    }

    public IReadOnlyList<string> Snapshot()
    {
        lock (gate)
        {
            return lines.ToArray();
        }
    }
}
