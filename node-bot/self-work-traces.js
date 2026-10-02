"use strict";

// #1287: Mana's own successful self-work runs, kept as training records for
// a later fine-tune of her local coding model (docs/self-work-traces.md).
// One JSON file per PR under node-bot/data/self-work-traces/ (git-ignored):
// the issue, her conversations as the model saw them, the diff, the tests
// and outcome labels. Only her local model's runs; everything goes through
// the sanitizer her GitHub text does. MANA_SELF_WORK_TRACES=0 turns it off.

const fs = require("node:fs");
const path = require("node:path");
const { sanitizeBridgeOutput } = require("./bridge-output-sanitizer");

const DEFAULT_MAX_MB = 200;

function scrub(value, env) {
  if (typeof value === "string") return sanitizeBridgeOutput(value, { env });
  if (Array.isArray(value)) return value.map((v) => scrub(v, env));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, env)]));
  return value;
}

function createTraceStore({ dir, env = process.env } = {}) {
  const enabled = () => !/^(0|off|false|no)$/i.test(String(env.MANA_SELF_WORK_TRACES ?? "").trim());
  const maxBytes = (Number(env.MANA_SELF_WORK_TRACES_MAX_MB) || DEFAULT_MAX_MB) * 1024 * 1024;
  const fileFor = (pr) => path.join(dir, `pr-${pr}.json`);

  function files() {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /^pr-\d+\.json$/.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { full, size: st.size, mtime: st.mtimeMs };
      });
  }

  // Oldest first until the folder fits the cap.
  function rotate() {
    const all = files().sort((a, b) => a.mtime - b.mtime);
    let total = all.reduce((n, f) => n + f.size, 0);
    while (total > maxBytes && all.length > 1) {
      const f = all.shift();
      fs.rmSync(f.full, { force: true });
      total -= f.size;
    }
  }

  // { saved: file } or { skipped: why }. Only a local model's run is kept.
  function save(record) {
    if (!enabled()) return { skipped: "off" };
    if (record.source !== "local") return { skipped: `source ${record.source}` };
    if (!Number.isInteger(record.pr)) return { skipped: "no PR" };
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(record.pr);
    fs.writeFileSync(file, JSON.stringify(scrub({ version: 1, savedAt: new Date().toISOString(), ...record }, env)));
    rotate();
    return { saved: file };
  }

  // Outcome labels set later (merged, reverted); a PR with no record is skipped.
  function mark(pr, labels) {
    const file = fileFor(pr);
    if (!fs.existsSync(file)) return false;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Object.entries(labels).every(([k, v]) => record.outcome?.[k] === v)) return false;
    record.outcome = { ...record.outcome, ...labels };
    fs.writeFileSync(file, JSON.stringify(record));
    return true;
  }

  function list() {
    return files().map((f) => JSON.parse(fs.readFileSync(f.full, "utf8")));
  }

  return { save, mark, list, enabled, dir };
}

// The records worth training on: hers, tests and review passed, merged
// and not reverted (unmerged ones too with { unmerged: true }).
function good(record, { unmerged = false } = {}) {
  const o = record.outcome || {};
  return record.source === "local" && o.testsPassed === true && o.reviewPassed === true && !o.reverted && (unmerged || o.merged === true);
}

// One chat-format line per conversation: { messages } as the model saw them
// (system, user, assistant with tool_calls, tool), the shape LoRA trainers take.
function toChatLines(records, opts) {
  const lines = [];
  for (const record of records.filter((r) => good(r, opts))) {
    for (const c of record.conversations || []) {
      if (Array.isArray(c.messages) && c.messages.some((m) => m.role === "assistant")) lines.push(JSON.stringify({ messages: c.messages }));
    }
  }
  return lines;
}

module.exports = { createTraceStore, good, toChatLines, scrub };
