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

    public void Add(string line)
    {
        lock (gate)
        {
            lines.Enqueue(line);
            while (lines.Count > MaxLines)
            {
                lines.Dequeue();
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
