// Simple internal tray notification helper used by server modules
let _broadcaster = null;

function setBroadcaster(fn) {
  if (typeof fn === "function") _broadcaster = fn;
}

async function notifyTray(payload) {
  try {
    if (typeof _broadcaster === "function") {
      // allow sync or async broadcasters
      const res = _broadcaster(payload);
      if (res && typeof res.then === "function") await res;
      return true;
    }
  } catch (e) {
    // swallow errors
  }
  return false;
}

function isAvailable() {
  return typeof _broadcaster === "function";
}

// Convenience: send audit notification (formats payload)
// Also has a small debounce/aggregation to avoid notification storms
let _auditQueue = [];
let _auditTimer = null;
const AUDIT_DEBOUNCE_MS = Number(process.env.AUDIT_TRAY_DEBOUNCE_MS || 2000);
const AUDIT_AGGREGATE_LIMIT = Number(
  process.env.AUDIT_TRAY_AGGREGATE_LIMIT || 50,
);

function _flushAuditQueue() {
  if (_auditTimer) {
    clearTimeout(_auditTimer);
    _auditTimer = null;
  }
  if (!_auditQueue.length) return;
  try {
    const items = _auditQueue.splice(0, _auditQueue.length);
    // aggregate summary
    const count = items.length;
    const byAction = {};
    let approvers = new Set();
    for (const it of items) {
      byAction[it.action] = (byAction[it.action] || 0) + 1;
      if (it.approver) approvers.add(it.approver);
    }
    const actionsSummary = Object.keys(byAction)
      .map((k) => `${k}:${byAction[k]}`)
      .join(", ");
    const approverList = [...approvers].slice(0, 5).join(", ") || "unknown";
    const payload = {
      type: "audit",
      title: "Background Audit",
      text: `${count} audit entries — ${actionsSummary} (by: ${approverList})`,
      meta: { count, actions: byAction },
      at: new Date().toISOString(),
    };
    // fire-and-forget
    notifyTray(payload).catch(() => {});
  } catch (e) {
    // ignore
  }
}

async function sendAuditTray(entry) {
  try {
    // normalize
    const action = entry && entry.action ? String(entry.action) : "audit";
    const approver = entry && entry.approver ? String(entry.approver) : null;
    const summary =
      entry && entry.removed ? `${(entry.removed || []).length} removed` : "";

    // enqueue and debounce
    _auditQueue.push({ action, approver, summary });
    if (_auditQueue.length >= AUDIT_AGGREGATE_LIMIT) {
      _flushAuditQueue();
      return true;
    }
    if (_auditTimer) {
      clearTimeout(_auditTimer);
    }
    _auditTimer = setTimeout(_flushAuditQueue, AUDIT_DEBOUNCE_MS);
    return true;
  } catch (e) {
    return false;
  }
}

async function sendImmediateAuditTray(entry) {
  try {
    const payload = {
      type: "audit",
      title: entry && entry.action ? String(entry.action) : "Background Audit",
      text:
        entry && entry.approver
          ? `${entry.action || "audit"} by ${entry.approver}`
          : (entry && entry.summary) ||
            (entry && entry.text) ||
            `${entry.action || "audit"}`,
      meta: entry || null,
      at: entry && entry.at ? entry.at : new Date().toISOString(),
    };
    return await notifyTray(payload);
  } catch (e) {
    return false;
  }
}

module.exports = {
  setBroadcaster,
  notifyTray,
  isAvailable,
  sendAuditTray,
  sendImmediateAuditTray,
};
