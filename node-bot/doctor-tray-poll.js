// Issue #325: Doctor previously only ran on-demand (when the Doctor popup
// opened in windows-launcher), and the tray-notifier broadcast pipeline
// (tray-notifier.js -> tray-server.js -> /ws/tray, already used by
// background-memory audit events) had nothing driving it from Doctor at
// all. This polls Doctor periodically and notifies the tray only on a
// fresh warn/fail transition -- not every tick -- so a still-broken check
// doesn't spam a notification on every poll.

const PROBLEM_STATUSES = new Set(["warn", "fail"]);

// Pure: given the previous per-check status and this poll's checks, returns
// which checks freshly became a problem plus the updated status map. Kept
// separate from the setInterval/notifyTray wiring below so the diff logic
// is testable without a timer or a real doctor() call.
function computeDoctorTrayTransitions(previousStatusById, checks) {
  const nextStatusById = new Map(previousStatusById);
  const notifications = [];
  for (const check of checks || []) {
    const previousStatus = previousStatusById.get(check.id);
    nextStatusById.set(check.id, check.status);
    if (PROBLEM_STATUSES.has(check.status) && previousStatus !== check.status) {
      notifications.push(check);
    }
  }
  return { notifications, nextStatusById };
}

function createDoctorTrayPoller({
  doctor,
  notifyTray,
  doctorOptions = () => ({}),
  intervalMs = Number(process.env.MANA_DOCTOR_POLL_INTERVAL_MS || 10 * 60 * 1000),
  log = console,
} = {}) {
  let statusById = new Map();
  let timer = null;

  async function pollOnce() {
    const result = await doctor(doctorOptions());
    const { notifications, nextStatusById } = computeDoctorTrayTransitions(
      statusById,
      result.checks,
    );
    statusById = nextStatusById;
    for (const check of notifications) {
      await notifyTray({
        type: "doctor",
        title: check.status === "fail" ? "Doctor: problem detected" : "Doctor: warning",
        text: `${check.label}: ${check.message}`,
        at: new Date().toISOString(),
      });
    }
    return notifications;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      pollOnce().catch((e) =>
        log.warn("Doctor tray poll failed:", e && e.message ? e.message : e),
      );
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { pollOnce, start, stop };
}

module.exports = { computeDoctorTrayTransitions, createDoctorTrayPoller };
