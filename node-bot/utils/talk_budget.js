const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'talk_budget.json');
let store = null;

function ensureLoaded() {
  if (store !== null) return;
  try {
    if (fs.existsSync(DATA_PATH)) {
      store = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8') || '{}');
    } else {
      store = {};
    }
  } catch (e) {
    store = {};
  }
}

function saveSync() {
  try {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {}
}

const DEFAULT_SESSION_BUDGET = 200000; // tokens per session default

function getBudget(sessionId = 'global') {
  ensureLoaded();
  const entry = store[sessionId];
  if (!entry) return { budget: DEFAULT_SESSION_BUDGET, remaining: DEFAULT_SESSION_BUDGET };
  return { budget: entry.budget || DEFAULT_SESSION_BUDGET, remaining: entry.remaining || 0 };
}

function setBudget(sessionId = 'global', budget = DEFAULT_SESSION_BUDGET) {
  ensureLoaded();
  store[sessionId] = { budget, remaining: budget };
  saveSync();
  return getBudget(sessionId);
}

function consumeTokens(sessionId = 'global', amount = 0) {
  ensureLoaded();
  if (!store[sessionId]) store[sessionId] = { budget: DEFAULT_SESSION_BUDGET, remaining: DEFAULT_SESSION_BUDGET };
  const entry = store[sessionId];
  if (entry.remaining >= amount) {
    entry.remaining -= amount;
    saveSync();
    return { ok: true, remaining: entry.remaining };
  }
  // insufficient
  const prev = entry.remaining;
  entry.remaining = Math.max(0, entry.remaining - amount);
  saveSync();
  return { ok: false, remaining: prev };
}

module.exports = { getBudget, setBudget, consumeTokens, DEFAULT_SESSION_BUDGET };
