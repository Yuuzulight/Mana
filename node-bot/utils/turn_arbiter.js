// Simple async turn arbiter with priority lanes
// API:
//   const arb = require('./utils/turn_arbiter');
//   const release = await arb.acquireTurn(priority, { timeoutMs });
//   try { await doWork(); } finally { release(); }
// Or: await arb.runWithTurn(async () => { ... }, priority, { timeoutMs });

const DEFAULT_TIMEOUT = 2 * 60 * 1000; // 2 minutes default TTL for queued turns

class TurnArbiter {
  constructor() {
    this._active = false;
    this._queue = []; // array of {priority, resolve, reject, enqueuedAt, timeoutId}
  }

  acquireTurn(priority = 1, opts = {}) {
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT;
    if (!Number.isInteger(priority)) priority = 1;

    // Immediate grant when idle
    if (!this._active && this._queue.length === 0) {
      this._active = true;
      return Promise.resolve(() => this._release());
    }

    // Otherwise enqueue
    return new Promise((resolve, reject) => {
      const entry = { priority, resolve, reject, enqueuedAt: Date.now(), timeoutId: null };
      // start timeout to reject if not granted within TTL
      if (timeoutMs > 0) {
        entry.timeoutId = setTimeout(() => {
          // remove from queue
          const i = this._queue.indexOf(entry);
          if (i >= 0) this._queue.splice(i, 1);
          try { entry.reject(new Error('turn_acquire_timeout')); } catch (e) {}
        }, timeoutMs);
      }
      this._queue.push(entry);
      // keep queue sorted by priority then FIFO
      this._queue.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority; // lower priority number first
        return a.enqueuedAt - b.enqueuedAt;
      });
    });
  }

  _release() {
    // mark inactive and grant next if any
    if (this._queue.length === 0) {
      this._active = false;
      return;
    }
    const entry = this._queue.shift();
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    this._active = true;
    try {
      entry.resolve(() => this._release());
    } catch (e) {
      // if resolving fails, release and move on
      this._release();
    }
  }

  async runWithTurn(fn, priority = 1, opts = {}) {
    const release = await this.acquireTurn(priority, opts);
    try {
      return await fn();
    } finally {
      try { release(); } catch (e) { /* swallow */ }
    }
  }
}

module.exports = new TurnArbiter();
