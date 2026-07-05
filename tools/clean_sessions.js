// One-shot session cleaner: back up and sanitize ACP session files
// Usage: node tools/clean_sessions.js

const fs = require('fs');
const path = require('path');
const runtime = require('../node-bot/ai/local-llama-runtime');

const sessionsDir = path.join(__dirname, '..', 'node-bot', 'data', 'acp-memory', 'sessions');
const backupDir = path.join(__dirname, '..', 'node-bot', 'data', 'acp-memory', 'sessions-backup-' + Date.now());

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

async function cleanAll() {
  if (!fs.existsSync(sessionsDir)) {
    console.log('No sessions directory found at', sessionsDir);
    return;
  }
  ensureDir(backupDir);
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
  console.log('Found', files.length, 'session files');
  for (const f of files) {
    const full = path.join(sessionsDir, f);
    const bak = path.join(backupDir, f);
    try {
      fs.copyFileSync(full, bak);
      const raw = fs.readFileSync(full, 'utf8');
      const obj = JSON.parse(raw);
      // sanitize summary and turns
      if (obj.summary && typeof obj.summary === 'string') {
        obj.summary = runtime.cleanLlamaOutput(obj.summary);
      }
      if (Array.isArray(obj.turns)) {
        obj.turns = obj.turns.map(t => {
          return {
            ...t,
            user: typeof t.user === 'string' ? t.user : t.user,
            assistant: typeof t.assistant === 'string' ? runtime.cleanLlamaOutput(t.assistant) : t.assistant,
          };
        });
      }
      fs.writeFileSync(full, JSON.stringify(obj, null, 2) + '\n', 'utf8');
      console.log('Cleaned', f);
    } catch (e) {
      console.warn('Failed to clean', f, e.message || e);
    }
  }
  console.log('Backup of originals in', backupDir);
}

cleanAll().catch(e => { console.error(e); process.exit(1); });
