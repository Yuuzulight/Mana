const { EventEmitter } = require('node:events');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

async function inspectProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process ID');
  const bin = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(bin, ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress`],
  { windowsHide: true, timeout: 3000, maxBuffer: 16384 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function nativeEstimate(service, env = process.env) {
  // These are estimates, not replacements for sandbox-approved hard limits.
  switch (service) {
    case 'fish-speech': return { ramMb: 3072, vramMb: 5120 };
    case 'qwen3-tts': return { ramMb: 2765, vramMb: 2765 };
    case 'embedder': return { ramMb: 1024, vramMb: (env.RETRIEVER_EMBEDDER_DEVICE || 'cpu') === 'cpu' ? 0 : 2300 };
    case 'retriever': return { ramMb: 1024 };
    case 'gpt-sovits': {
      const ramMb = Number(env.MANA_GPT_SOVITS_RAM_MB), vramMb = Number(env.MANA_GPT_SOVITS_VRAM_MB);
      if (!Number.isFinite(ramMb) || ramMb <= 0 || !Number.isFinite(vramMb) || vramMb < 0) throw new Error('GPT-SoVITS needs measured RAM/VRAM estimates before coordinated startup (MANA_GPT_SOVITS_RAM_MB and MANA_GPT_SOVITS_VRAM_MB).');
      return { ramMb, vramMb };
    }
    default: throw new Error('Unknown native model service');
  }
}

function registerNativeResourceRoutes({ app, coordinator, checkAuth, launcherPid, inspect = inspectProcess, env = process.env, pollMs = 5000 }) {
  const owned = new Map();
  let timer = null, polling = false, closed = false;
  function arm() {
    if (closed || timer || !owned.size) return;
    timer = setTimeout(async () => {
      timer = null;
      if (polling) { arm(); return; }
      polling = true;
      try {
        for (const [id, entry] of owned) {
          if (!entry.child) continue;
          try {
            const process = await inspect(entry.child.pid);
            if (!process || process.CreationDate !== entry.created) { entry.child.emit('exit', 0); owned.delete(id); }
          } catch { /* A failed probe is not evidence of termination. */ }
        }
      } finally { polling = false; arm(); }
    }, pollMs);
    timer.unref?.();
  }
  const allowed = (req, res) => {
    if (!checkAuth(req, res)) return false;
    if (!coordinator || !Number.isInteger(launcherPid) || launcherPid <= 0) {
      res.status(503).json({ error: 'Native launcher resource ownership is unavailable.' }); return false;
    }
    return true;
  };
  app.post('/resources/native/reserve', async (req, res) => {
    if (!allowed(req, res)) return;
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(new Error('Native startup request disconnected')); };
    res.once('close', disconnected);
    let lease;
    try {
      if (owned.size >= 16) throw new Error('Too many native model reservations');
      lease = await coordinator.acquire({ owner: `Native ${req.body?.service}`, kind: 'residency',
        estimate: nativeEstimate(req.body?.service, env), signal: controller.signal,
        onWait: event => console.log(`[resources] ${event.owner || req.body?.service}: ${event.reason}`) });
      if (controller.signal.aborted) { lease.release(); return; }
      if (owned.size >= 16) { lease.release(); throw new Error('Too many native model reservations'); }
      owned.set(lease.id, { lease, child: null, service: req.body.service });
      res.json({ id: lease.id });
    } catch (error) { if (!res.destroyed) res.status(409).json({ error: error.message }); }
    finally { res.removeListener('close', disconnected); }
  });
  app.post('/resources/native/attach', async (req, res) => {
    if (!allowed(req, res)) return;
    try {
      const entry = owned.get(req.body?.id);
      if (!entry || entry.child) throw new Error('Unknown or already attached native reservation');
      const process = await inspect(req.body?.pid);
      if (!process || process.ParentProcessId !== launcherPid || !process.CreationDate) throw new Error('Process is not owned by this native Mana launcher');
      if (entry.child) throw new Error('Native reservation was attached while ownership was being checked');
      if ([...owned.values()].some(value => value.child?.pid === process.ProcessId && value.created === process.CreationDate)) throw new Error('Native process already has a reservation');
      const child = new EventEmitter();
      child.pid = process.ProcessId;
      entry.child = child;
      entry.created = process.CreationDate;
      entry.lease.attachProcess(child);
      arm();
      res.json({ ok: true });
    } catch (error) { res.status(409).json({ error: error.message }); }
  });
  app.post('/resources/native/release', async (req, res) => {
    if (!allowed(req, res)) return;
    try {
      const entry = owned.get(req.body?.id);
      if (!entry) throw new Error('Unknown native reservation');
      if (entry.child) {
        const process = await inspect(entry.child.pid);
        if (process && process.CreationDate === entry.created) throw new Error('Native process is still running; reservation retained');
        entry.child.emit('exit', 0);
      } else if (req.body?.notStarted !== true) throw new Error('Confirm that no process was started before releasing an unattached reservation');
      entry.lease.release();
      owned.delete(req.body.id);
      res.json({ ok: true });
    } catch (error) { res.status(409).json({ error: error.message }); }
  });
  app.post('/resources/native/recover', async (req, res) => {
    if (!allowed(req, res)) return;
    try {
      if (owned.size >= 16) throw new Error('Too many native model reservations');
      const process = await inspect(req.body?.pid);
      if (!process || process.ParentProcessId !== launcherPid || !process.CreationDate) throw new Error('Process is not owned by this native Mana launcher');
      const existing = [...owned.values()].find(entry => entry.child?.pid === process.ProcessId && entry.created === process.CreationDate);
      if (existing) { res.json({ id: existing.lease.id }); return; }
      const child = new EventEmitter(); child.pid = process.ProcessId;
      const lease = coordinator.adopt({ owner: `Native ${req.body?.service} (recovered)`, estimate: nativeEstimate(req.body?.service, env), child });
      owned.set(lease.id, { lease, child, created: process.CreationDate, service: req.body.service });
      arm(); res.json({ id: lease.id });
    } catch (error) { res.status(409).json({ error: error.message }); }
  });
  return {
    finishFishTransfer(transfer, target, success) {
      const entry = [...owned.values()].find(value => value.service === 'fish-speech' && value.child);
      if (!success) {
        if (entry) transfer.attachProcess(entry.child);
        else transfer.retain('Fish device transfer completion is unconfirmed; reservation retained for recovery.');
      } else if (entry) {
        coordinator.reallocate(entry.lease.id, transfer.id, target === 'cpu'
          ? { ramMb: 5120 } : nativeEstimate('fish-speech', env));
      }
    },
    close: () => { closed = true; clearTimeout(timer); },
  };
}

module.exports = { registerNativeResourceRoutes, nativeEstimate, inspectProcess };
