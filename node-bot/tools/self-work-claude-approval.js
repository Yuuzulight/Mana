// #1406: before her self-work hands an issue to Claude Code (her Claude
// subscription), she asks through the approval gate, every time, like a
// sandboxed test run (self-work-test-approval.js). Resolves true when approved.
const { randomUUID } = require("node:crypto");

const ACTION = "self-work-claude";
const waiting = new WeakMap();

function askClaudeHandoff({ gate, summary, details, cancelled = () => false }) {
  if (!gate) return Promise.resolve(false);
  let entries = waiting.get(gate);
  if (!entries) {
    entries = new Map();
    waiting.set(gate, entries);
    gate.registerExecutor(ACTION, async ({ nonce }) => {
      entries.get(nonce)?.(true);
      entries.delete(nonce);
      return "approved";
    });
  }
  const nonce = randomUUID();
  return new Promise((resolve) => {
    entries.set(nonce, resolve);
    gate
      .requestApproval(ACTION, { forceReview: true, summary, details, payload: { nonce } })
      .then((decision) => {
        if (decision.status === "approved") return resolve(true);
        if (decision.status !== "pending") {
          entries.delete(nonce);
          return resolve(false);
        }
        const poll = setInterval(() => {
          if (!entries.has(nonce)) return clearInterval(poll);
          if (cancelled() || !gate.listPending().some((item) => item.id === decision.requestId)) {
            clearInterval(poll);
            entries.delete(nonce);
            resolve(false);
          }
        }, 250);
      })
      .catch(() => {
        entries.delete(nonce);
        resolve(false);
      });
  });
}

module.exports = { askClaudeHandoff, ACTION };
