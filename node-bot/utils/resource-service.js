const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createResourceCoordinator } = require('./resource-coordinator');

let service = null;
const execute = promisify(execFile);
// Windows' per-process GPU memory counters: nvidia-smi reports N/A per process under WDDM (the usual Windows
// driver mode), so without these a running model's estimate counted on top of the GPU memory it already uses.
const GPU_COUNTER_SCRIPT = "$g = @{}; try { (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction Stop).CounterSamples | "
  + "ForEach-Object { if ($_.InstanceName -match '^pid_(\\d+)_') { $g[$matches[1]] += $_.CookedValue } } } catch {}; $g | ConvertTo-Json -Compress";
// A read takes a second or two, so it is reused for this long.
const GPU_COUNTER_TTL_MS = 10000;
function createHardwareTelemetry({ run = execute, platform = process.platform, env = process.env,
  memory = os, now = Date.now } = {}) {
  let gpuCounters = { at: -Infinity, byPid: new Map() };
  return async leases => {
    const observed = {};
    const result = { at: now(), ramTotalMb: memory.totalmem() / 1048576,
      ramFreeMb: memory.freemem() / 1048576, cpuTotal: memory.availableParallelism?.() || memory.cpus().length, observed };
    const options = { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 };
    let uuid;
    try {
      const { stdout } = await run('nvidia-smi', ['--query-gpu=uuid,memory.free', '--format=csv,noheader,nounits'], options);
      const first = stdout.trim().split(/\r?\n/)[0]?.split(',').map(s => s.trim());
      const free = Number(first?.[1]);
      if (first?.[0] && first[1] !== '' && Number.isFinite(free) && free >= 0) { uuid = first[0]; result.vramFreeMb = free; result.vramAt = now(); }
    } catch {}
    if (uuid && leases.some(e => e.pid)) {
      try {
        const { stdout } = await run('nvidia-smi', ['--query-compute-apps=gpu_uuid,pid,used_gpu_memory', '--format=csv,noheader,nounits'], options);
        const byPid = new Map();
        for (const line of stdout.trim().split(/\r?\n/)) {
          const [device, pid, used] = line.split(',').map(s => s.trim());
          const mb = Number(used);
          if (device === uuid && used !== '' && Number.isFinite(mb) && mb >= 0) byPid.set(Number(pid), (byPid.get(Number(pid)) || 0) + mb);
        }
        for (const lease of leases) if (byPid.has(lease.pid)) observed[lease.id] = { vramMb: byPid.get(lease.pid) };
      } catch {}
    }
    const pids = [...new Set(leases.map(e => e.pid).filter(pid => Number.isInteger(pid) && pid > 0))];
    if (platform === 'win32' && pids.length) {
      try {
        const powershell = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
          `@(Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64) | ConvertTo-Json -Compress`], options);
        const parsed = JSON.parse(stdout);
        for (const process of Array.isArray(parsed) ? parsed : [parsed]) {
          if (!Number.isFinite(process?.WorkingSet64) || process.WorkingSet64 < 0) continue;
          for (const lease of leases) if (lease.pid === process.Id) observed[lease.id] = { ...observed[lease.id], ramMb: process.WorkingSet64 / 1048576 };
        }
      } catch {}
    }
    // Leases whose GPU use nvidia-smi couldn't give: the Windows counters, per process id. A process the counters
    // don't list, or a failed read, gets no credit, like an unknown value always did.
    const unseen = leases.filter(e => Number.isInteger(e.pid) && e.pid > 0 && observed[e.id]?.vramMb === undefined);
    if (uuid && platform === 'win32' && unseen.length) {
      if (now() - gpuCounters.at >= GPU_COUNTER_TTL_MS) {
        const byPid = new Map();
        try {
          const powershell = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
          const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', GPU_COUNTER_SCRIPT], { ...options, timeout: 8000 });
          const parsed = JSON.parse(stdout);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [pid, bytes] of Object.entries(parsed)) if (Number.isFinite(bytes) && bytes >= 0) byPid.set(Number(pid), bytes / 1048576);
          }
        } catch {}
        gpuCounters = { at: now(), byPid };
      }
      for (const lease of unseen) if (gpuCounters.byPid.has(lease.pid)) observed[lease.id] = { ...observed[lease.id], vramMb: gpuCounters.byPid.get(lease.pid) };
    }
    if (uuid) {
      try {
        const { stdout } = await run('nvidia-smi', ['--query-gpu=uuid,memory.free', '--format=csv,noheader,nounits'], options);
        const row = stdout.trim().split(/\r?\n/).map(line => line.split(',').map(s => s.trim())).find(row => row[0] === uuid);
        const free = Number(row?.[1]);
        if (row?.[1] && Number.isFinite(free) && free >= 0) { result.vramFreeMb = free; result.vramAt = now(); }
        else delete result.vramFreeMb;
      } catch { delete result.vramFreeMb; }
    }
    // The sample's age includes command latency; a slow probe never masquerades
    // as a fresh snapshot. Unknown per-process GPU usage receives no credit.
    result.ramFreeMb = memory.freemem() / 1048576;
    result.at = now();
    return result;
  };
}
function initializeResourceService(options = {}) {
  if (!service) service = createResourceCoordinator({ telemetry: createHardwareTelemetry(), ...options });
  return service;
}
function getResourceService() { return service; }

module.exports = { createHardwareTelemetry, initializeResourceService, getResourceService };
