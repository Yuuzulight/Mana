// Pure logic for issue #423's proactive toast notifications, kept separate
// from main.js so it's testable without requiring "electron" (same
// pure-logic-vs-orchestration split backend-config.js/live2d-logic.js
// already use). main.js wires this to the real `new Notification(...)` call
// and the tray WebSocket payloads already broadcast by tray-notifier.js.

const OPEN_CHAT_ACTION_INDEX = 0;

// Tray payload types that should surface as a toast, not just update the
// tray tooltip. "doctor" is deliberately excluded -- main.js's existing
// tooltip/balloon handling already covers it, and re-toasting doctor status
// on every check would be noisy, not proactive.
const PROACTIVE_TOAST_TYPES = new Set(["dream", "cron", "research"]);

function isProactiveToast(payload) {
  return Boolean(payload && PROACTIVE_TOAST_TYPES.has(payload.type));
}

function buildToastOptions(payload) {
  return {
    title: (payload && payload.title) || "Mana",
    body: (payload && payload.text) || "",
    actions: [
      { type: "button", text: "Open Chat" },
      { type: "button", text: "Dismiss" },
    ],
  };
}

module.exports = {
  OPEN_CHAT_ACTION_INDEX,
  PROACTIVE_TOAST_TYPES,
  isProactiveToast,
  buildToastOptions,
};
