const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const DIMENSIONS = ['ramMb', 'vramMb', 'cpu'];
function budget(value = {}) {
  return Object.fromEntries(DIMENSIONS.map(key => {
    const number = value[key] ?? 0;
    if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid resource estimate: ${key}`);
    return [key, number];
  }));
}

// Only the telemetry adapter supplies observed allocations. A workload cannot
// claim that its reservation is already reflected in the hardware free count.
function createResourceCoordinator({ telemetry, now = Date.now, pollMs = 1000,
  maxTelemetryAgeMs = 5000, agingMs = 30000, ramHeadroom = 0.15, backgroundCpuHeadroom = 2 } = {}) {
  if (typeof telemetry !== 'function') throw new Error('Resource telemetry is required');
  if (![pollMs, maxTelemetryAgeMs, agingMs].every(n => Number.isFinite(n) && n > 0)
    || !Number.isFinite(ramHeadroom) || ramHeadroom < 0 || ramHeadroom >= 1
    || !Number.isFinite(backgroundCpuHeadroom) || backgroundCpuHeadroom < 0) throw new Error('Invalid resource policy');
  const leases = new Map();
  const queue = [];
  const history = [];
  const listeners = new Set();
  const workload = new AsyncLocalStorage();
  let sample = null, pumping = null, timer = null, closed = false, dirty = false;

  function record(entry, state, reason) {
    entry.state = state;
    entry.reason = reason;
    history.push({ id: entry.id, owner: entry.owner, state, reason, at: now() });
    if (history.length > 100) history.shift();
    const event = { id: entry.id, owner: entry.owner, state, reason, cpuAlternative: entry.retryingGpu ? null : entry.cpuAlternative };
    try { entry.onWait?.(event); } catch {}
    for (const listener of listeners) { try { listener(event); } catch {} }
  }
  function interactiveDemand() {
    return queue.some(e => !e.background) || [...leases.values()].some(e => !e.background && e.kind !== 'residency');
  }
  function reasonFor(entry) {
    if (entry.exclusive && [...leases.values()].some(held => held.exclusive === entry.exclusive)) return `Waiting for ${entry.exclusive}: another model operation is in flight.`;
    if (entry.background && !entry.admitted && interactiveDemand()) return 'Interactive chat or voice has priority; waiting at a safe boundary.';
    if (!sample || !Number.isFinite(sample.at) || now() - sample.at > maxTelemetryAgeMs || sample.at > now()) return 'Waiting for fresh hardware telemetry.';
    for (const key of DIMENSIONS) {
      if (entry.estimate[key] === 0) continue;
      if (key === 'vramMb' && sample.vramAt !== undefined && (now() - sample.vramAt > maxTelemetryAgeMs || sample.vramAt > now())) return 'Waiting for fresh GPU-memory telemetry.';
      const freeKey = key === 'cpu' ? 'cpuTotal' : key === 'ramMb' ? 'ramFreeMb' : 'vramFreeMb';
      if (!Number.isFinite(sample[freeKey]) || sample[freeKey] < 0) return `Waiting for fresh ${key === 'vramMb' ? 'GPU-memory' : key} telemetry.${entry.cpuAlternative && key === 'vramMb' ? ' CPU execution is available with your approval.' : ''}`;
      let available = sample[freeKey];
      const creditedPids = new Map();
      if (key === 'ramMb' && entry.background) {
        if (!Number.isFinite(sample.ramTotalMb)) return 'Waiting for RAM capacity telemetry.';
        available -= sample.ramTotalMb * ramHeadroom;
      }
      if (key === 'cpu' && entry.background) available -= Math.min(backgroundCpuHeadroom, Math.max(0, sample.cpuTotal - 1));
      for (const held of leases.values()) {
        const observed = sample.observed?.[held.id]?.[key];
        // CPU is an execution allocation, not resident usage credited by RSS.
        const remaining = held.pid ? Math.max(0, (observed || 0) - (creditedPids.get(held.pid) || 0)) : observed;
        const credit = key !== 'cpu' && Number.isFinite(remaining) && remaining >= 0 ? Math.min(remaining, held.estimate[key]) : 0;
        if (held.pid) creditedPids.set(held.pid, (creditedPids.get(held.pid) || 0) + credit);
        available -= held.estimate[key] - credit;
      }
      if (entry.estimate[key] > available) return `Waiting for ${key}: needs ${entry.estimate[key]}, available ${Math.max(0, Math.floor(available))}; existing reservations and headroom are retained.`;
    }
    return null;
  }
  function removeQueued(entry) {
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    clearTimeout(entry.timeout);
    entry.signal?.removeEventListener('abort', entry.abort);
    return true;
  }
  function reject(entry, error) {
    if (!removeQueued(entry)) return;
    record(entry, 'refused', error.message);
    entry.reject(error);
  }
  function arm() {
    if (closed || timer || !queue.length) return;
    timer = setTimeout(() => { timer = null; void pump(); }, pollMs);
    timer.unref?.();
  }
  function grant(entry) {
    removeQueued(entry);
    leases.set(entry.id, entry);
    record(entry, 'running', 'Resources reserved atomically.');
    const lease = {
      id: entry.id,
      mode: entry.mode,
      retain(reason) { entry.quarantined = true; record(entry, 'stopping', reason); },
      attachProcess(child) {
        if (entry.child || !leases.has(entry.id)) throw new Error('Lease cannot attach another process');
        entry.child = child;
        Object.defineProperty(entry, 'pid', { get: () => child.pid || null });
        const exited = () => {
          if (child.resourceCleanupFailed) { record(entry, 'stopping', 'Cleanup failed; reservation retained for recovery.'); return; }
          entry.exited = true;
          entry.quarantined = false;
          if (entry.kind === 'residency' || entry.releaseRequested) lease.release();
        };
        child.once('exit', exited);
        child.once('close', exited);
        child.once('error', () => { if (!child.pid) exited(); });
        if (child.exitCode != null || child.signalCode != null) exited();
      },
      release() {
        if (!leases.has(entry.id)) return true;
        entry.releaseRequested = true;
        if (entry.quarantined) return false;
        if (entry.child && !entry.exited) {
          record(entry, 'stopping', 'Reservation retained until the owned process exits.');
          return false;
        }
        leases.delete(entry.id);
        record(entry, 'released', 'Work completed and owned process termination was confirmed.');
        void pump();
        return true;
      },
    };
    entry.resolve(lease);
  }
  async function drain() {
    try {
      sample = await telemetry([...leases.values()].map(e => ({ id: e.id, pid: e.pid, estimate: { ...e.estimate } })));
    } catch { sample = null; }
    if (closed) return;
    const ordered = [...queue].sort((a, b) => {
      const priority = e => Math.max(0, e.priority - Math.floor((now() - e.enqueuedAt) / agingMs));
      return priority(a) - priority(b) || a.sequence - b.sequence;
    });
    let fairHead = null;
    for (const entry of ordered) {
      if (!queue.includes(entry)) continue;
      try {
        if (entry.signal?.aborted || entry.cancelled?.()) { reject(entry, entry.signal?.reason || new Error('Resource request cancelled')); continue; }
      } catch (error) { reject(entry, error); continue; }
      if (fairHead && (entry.background || !fairHead.background) && DIMENSIONS.some(key => fairHead.estimate[key] > 0 && entry.estimate[key] > 0)) {
        if (entry.reason !== 'Waiting behind an aged resource request to prevent starvation.') record(entry, 'queued', 'Waiting behind an aged resource request to prevent starvation.');
        continue;
      }
      let reason = reasonFor(entry);
      if (!reason) { grant(entry); continue; }
      if (entry.estimate.vramMb > 0 && /^Waiting for fresh (GPU-memory|hardware)/.test(reason)) {
        entry.gpuRetries = (entry.gpuRetries || 0) + 1;
        entry.retryingGpu = entry.gpuRetries < 3;
        if (entry.retryingGpu) reason = `Retrying GPU-memory telemetry (${entry.gpuRetries}/3); no new GPU allocation has started.`;
      } else entry.retryingGpu = false;
      if (entry.reason !== reason) record(entry, 'queued', reason);
      if (/^Waiting for (ramMb|vramMb|cpu):/.test(reason) && now() - entry.enqueuedAt >= agingMs * Math.max(1, entry.priority)) fairHead ||= entry;
      // Residency owners must recheck active users themselves. No arbitrary
      // process killing or test preemption is available to the coordinator.
      if (!entry.background && /Waiting for (ramMb|vramMb)/.test(reason)) {
        for (const held of [...leases.values()]) {
          if (held.kind !== 'residency' || !held.evictIdle || held.evicting) continue;
          held.evicting = true;
          try { await held.evictIdle(); } catch {}
          finally { held.evicting = false; }
        }
      }
    }
  }
  function pump() {
    if (closed) return Promise.resolve();
    if (pumping) { dirty = true; return pumping; }
    pumping = (async () => {
      do { dirty = false; await drain(); } while (dirty && !closed);
    })().finally(() => { pumping = null; arm(); });
    return pumping;
  }
  let sequence = 0;
  function acquire({ owner, estimate, background = false, priority = background ? 3 : 1,
    kind = 'job', signal, cancelled, timeoutMs = 120000, cpuAlternative, evictIdle, onWait, exclusive } = {}) {
    if (closed) return Promise.reject(new Error('Resource coordinator is closed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (queue.length >= 128) return Promise.reject(new Error('Resource request queue is full'));
    if (!owner || !Number.isFinite(priority)) return Promise.reject(new Error('A resource owner and valid priority are required'));
    let normalized, alternative;
    try { normalized = budget(estimate); alternative = cpuAlternative ? budget(cpuAlternative) : null; }
    catch (error) { return Promise.reject(error); }
    if (alternative?.vramMb) return Promise.reject(new Error('CPU alternative must not reserve GPU memory'));
    return new Promise((resolve, rejectPromise) => {
      const entry = { id: randomUUID(), owner, estimate: normalized, background, priority, kind, signal, cancelled,
        exclusive, admitted: !!workload.getStore()?.admitted,
        cpuAlternative: alternative, evictIdle, onWait, resolve, reject: rejectPromise, enqueuedAt: now(), sequence: sequence++, mode: normalized.vramMb > 0 ? 'gpu' : 'cpu' };
      entry.abort = () => reject(entry, signal.reason || new Error('Resource request cancelled'));
      queue.push(entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      if (timeoutMs > 0) entry.timeout = setTimeout(() => {
        const error = new Error(entry.reason || 'Resource wait timed out');
        error.code = 'RESOURCE_WAIT_TIMEOUT';
        error.resourceRequest = entry.id;
        error.cpuAlternative = entry.cpuAlternative;
        reject(entry, error);
      }, timeoutMs);
      void pump();
    });
  }
  function chooseCpu(id) {
    const entry = queue.find(e => e.id === id);
    if (!entry?.cpuAlternative) throw new Error('No queued CPU alternative exists for this request');
    entry.estimate = entry.cpuAlternative;
    entry.mode = 'cpu';
    record(entry, 'queued', 'CPU execution explicitly selected; checking RAM and CPU reservations.');
    void pump();
  }
  function promote(id) {
    const entry = queue.find(e => e.id === id);
    if (!entry) return;
    entry.background = false;
    entry.priority = Math.min(entry.priority, 1);
    void pump();
  }
  function adopt({ owner, estimate, child }) {
    if (closed) throw new Error('Resource coordinator is closed');
    const entry = { id: randomUUID(), owner, estimate: budget(estimate), kind: 'residency', background: false,
      enqueuedAt: now(), sequence: sequence++, mode: (estimate?.vramMb || 0) > 0 ? 'gpu' : 'cpu' };
    let lease;
    entry.resolve = value => { lease = value; };
    grant(entry);
    lease.attachProcess(child);
    return lease;
  }
  function status() {
    const view = e => ({ id: e.id, owner: e.owner, state: e.state, reason: e.reason, estimate: { ...e.estimate },
      observed: sample?.observed?.[e.id] || null, pid: e.pid || null, mode: e.mode, background: e.background, kind: e.kind, cpuAlternative: e.cpuAlternative || null });
    return { policy: { ramHeadroom, backgroundCpuHeadroom }, telemetryAt: sample?.at || null,
      active: [...leases.values()].map(view), queued: queue.map(view), history: history.slice() };
  }
  function reallocate(id, donorId, estimate) {
    const entry = leases.get(id), donor = leases.get(donorId), next = budget(estimate);
    if (!entry || entry.kind !== 'residency' || !donor || donor.kind !== 'job' || donor.child || donor.quarantined
      || DIMENSIONS.some(key => next[key] > entry.estimate[key] + donor.estimate[key])) throw new Error('Device transition exceeds its admitted reservations');
    entry.estimate = next;
    entry.mode = next.vramMb > 0 ? 'gpu' : 'cpu';
    donor.estimate = budget();
    record(entry, 'running', 'Confirmed device transition; residency updated within admitted capacity.');
  }
  async function run(request, fn) {
    const lease = await acquire(request);
    try { return await fn(lease); } finally { lease.release(); }
  }
  function close() {
    closed = true;
    clearTimeout(timer);
    timer = null;
    for (const entry of [...queue]) reject(entry, new Error('Resource coordinator stopped'));
    // Live processes retain their leases until exit, even during shutdown.
  }
  return { acquire, run, chooseCpu, promote, adopt, reallocate, status, refresh: pump, close, interactiveDemand,
    scope: (request, fn) => workload.run(request, fn), currentContext: () => workload.getStore(),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
}

module.exports = { createResourceCoordinator };
