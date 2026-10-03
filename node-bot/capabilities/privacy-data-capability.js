// Issue #1336: Export everything (chats, memory, vault, settings without
// secrets, voice data, artifacts) as one zip with a readme, and delete
// everything (typed confirmation "delete-everything") to wipe chats,
// memory, vault sync state, voice samples, caches and logs, leaving the app
// in first-run state. Also supports per-category delete.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { exportSessionAsMarkdown } = require("../session-export");
const { voiceDataDir } = require("../voice-data");
const { redactSecrets } = require("../tool-call-log");

const KEY = "privacy-data";

/**
 * Builds a standard ZIP buffer conforming to the PKWARE specification.
 * Each entry: { name: string, data: string | Buffer, stored?: boolean }
 */
function createZipBuffer(entries = []) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data, stored = false } of entries) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data || "", "utf8");
    const body = stored ? raw : zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const nameBuf = Buffer.from(name.replace(/\\/g, "/"), "utf8");

    // Local file header (30 bytes + name + body)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed (2.0)
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(stored ? 0 : 8, 8); // compression method (0=stored, 8=deflate)
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14); // crc-32
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26); // file name length
    local.writeUInt16LE(0, 28); // extra field length

    // Central directory header (46 bytes + name)
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // signature
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(stored ? 0 : 8, 10); // compression method
    entry.writeUInt16LE(0, 12); // mod time
    entry.writeUInt16LE(0, 14); // mod date
    entry.writeUInt32LE(crc, 16); // crc-32
    entry.writeUInt32LE(body.length, 20); // compressed size
    entry.writeUInt32LE(raw.length, 24); // uncompressed size
    entry.writeUInt16LE(nameBuf.length, 28); // file name length
    entry.writeUInt16LE(0, 30); // extra field length
    entry.writeUInt16LE(0, 32); // comment length
    entry.writeUInt16LE(0, 34); // disk start
    entry.writeUInt16LE(0, 36); // internal file attributes
    entry.writeUInt32LE(0, 38); // external file attributes
    entry.writeUInt32LE(offset, 42); // relative offset of local header

    parts.push(local, nameBuf, body);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // EOCD signature
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk where central dir starts
  end.writeUInt16LE(entries.length, 8); // records on this disk
  end.writeUInt16LE(entries.length, 10); // total records
  end.writeUInt32LE(directory.length, 12); // size of central directory
  end.writeUInt32LE(offset, 16); // offset of central directory
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, directory, end]);
}

/**
 * Gathers all data from memory, sessions, vault, voice, and settings into zip entries.
 */
function gatherExportEntries(context = {}) {
  const entries = [];
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  // 1. README.md
  entries.push({
    name: "README.md",
    data: `# Mana Full Data Export
Generated on: ${now.toISOString()}

This archive contains all your personal data exported from Mana:

- chats/: Full chat histories (JSON structured data and readable Markdown transcripts).
- memory/: Long-term remembered facts, entity relationships, and emotional affect state.
- vault/: Obsidian vault sync state and notes.
- settings/: Configuration preferences with all sensitive credentials/secrets redacted.
- voice/: Captured voice audio clips (.wav) and alignment transcripts (.json).
- artifacts/: Code artifacts and outputs produced during chat sessions.

All exports were processed locally on your machine.
`,
  });

  // 2. Chats (Sessions)
  const acpMemoryStore = context.acpMemoryStore;
  if (acpMemoryStore) {
    const sessions = typeof acpMemoryStore.listSessions === "function" ? acpMemoryStore.listSessions() : [];
    for (const sessionSummary of sessions) {
      const id = sessionSummary.sessionId;
      const session = typeof acpMemoryStore.getSession === "function" ? acpMemoryStore.getSession(id) : null;
      if (!session) continue;

      // JSON dump
      entries.push({
        name: `chats/${id}.json`,
        data: JSON.stringify(session, null, 2),
      });

      // Readable Markdown dump
      try {
        const md = exportSessionAsMarkdown(session, { includeTools: true, includeThoughts: true, now });
        entries.push({
          name: `chats/${id}.md`,
          data: md,
        });
      } catch {}

      // Collect artifacts inside session turns
      for (let t = 0; t < (session.turns || []).length; t++) {
        const turn = session.turns[t];
        if (turn?.artifact?.content) {
          const ext = turn.artifact.language === "javascript" ? "js" : turn.artifact.language || "txt";
          entries.push({
            name: `artifacts/${id}_turn_${t + 1}.${ext}`,
            data: turn.artifact.content,
          });
        }
      }
    }

    // 3. Memory facts & entities
    const dataDir = acpMemoryStore.dataDir;
    if (dataDir && fs.existsSync(dataDir)) {
      const readIfExists = (rel) => {
        const full = path.join(dataDir, rel);
        if (fs.existsSync(full)) {
          try {
            return fs.readFileSync(full, "utf8");
          } catch {}
        }
        return null;
      };

      const facts = readIfExists("facts.json");
      if (facts) entries.push({ name: "memory/facts.json", data: facts });

      const entities = readIfExists("entity-index.json");
      if (entities) entries.push({ name: "memory/entity-index.json", data: entities });

      const entityTypes = readIfExists("entity-types.json");
      if (entityTypes) entries.push({ name: "memory/entity-types.json", data: entityTypes });

      const emotional = readIfExists("emotional-state.json");
      if (emotional) entries.push({ name: "memory/emotional-state.json", data: emotional });

      const vaultSync = readIfExists("vault-sync.json");
      if (vaultSync) entries.push({ name: "vault/vault-sync.json", data: vaultSync });
    }
  }

  // 4. Voice data
  const vDir = context.voiceDataDir || voiceDataDir(process.env);
  const turnsDir = path.join(vDir, "turns");
  if (fs.existsSync(turnsDir)) {
    try {
      const files = fs.readdirSync(turnsDir);
      for (const file of files) {
        if (file.endsWith(".json") || file.endsWith(".wav")) {
          const filePath = path.join(turnsDir, file);
          try {
            entries.push({
              name: `voice/${file}`,
              data: fs.readFileSync(filePath),
              stored: file.endsWith(".wav"), // uncompressed for audio
            });
          } catch {}
        }
      }
    } catch {}
  }

  // 5. Settings (without secrets)
  const settingsEntries = {};
  if (context.pluginSettingsStore && typeof context.pluginSettingsStore.getSettings === "function") {
    settingsEntries["plugin-settings.json"] = context.pluginSettingsStore.getSettings();
  }
  if (context.modelSettingsStore && typeof context.modelSettingsStore.getSettings === "function") {
    settingsEntries["model-settings.json"] = context.modelSettingsStore.getSettings();
  }

  // Native launcher settings from AppData if available
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const launcherSettingsPath = path.join(localAppData, "Mana", "native-launcher-settings.json");
    if (fs.existsSync(launcherSettingsPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(launcherSettingsPath, "utf8"));
        settingsEntries["native-launcher-settings.json"] = raw;
      } catch {}
    }
  }

  for (const [name, obj] of Object.entries(settingsEntries)) {
    const sanitized = redactSecrets(obj);
    entries.push({
      name: `settings/${name}`,
      data: JSON.stringify(sanitized, null, 2),
    });
  }

  return entries;
}

/**
 * Wipes a specific data category or everything.
 */
function wipeData(category, context = {}) {
  const acpMemoryStore = context.acpMemoryStore;
  const dataDir = acpMemoryStore?.dataDir;
  const vDir = context.voiceDataDir || voiceDataDir(process.env);
  const results = [];

  const wipeVoice = () => {
    const turnsDir = path.join(vDir, "turns");
    if (fs.existsSync(turnsDir)) {
      try {
        const files = fs.readdirSync(turnsDir);
        for (const file of files) {
          try {
            fs.rmSync(path.join(turnsDir, file), { force: true });
          } catch {}
        }
      } catch {}
    }
    results.push("voice");
  };

  const wipeChats = () => {
    if (acpMemoryStore) {
      const sessions = typeof acpMemoryStore.listSessions === "function" ? acpMemoryStore.listSessions() : [];
      for (const s of sessions) {
        if (typeof acpMemoryStore.deleteSession === "function") {
          try {
            acpMemoryStore.deleteSession(s.sessionId);
          } catch {}
        }
      }
    }
    if (acpMemoryStore?.sessionsDir && fs.existsSync(acpMemoryStore.sessionsDir)) {
      try {
        const files = fs.readdirSync(acpMemoryStore.sessionsDir);
        for (const f of files) {
          try {
            fs.rmSync(path.join(acpMemoryStore.sessionsDir, f), { force: true });
          } catch {}
        }
      } catch {}
    }
    results.push("chats");
  };

  const wipeMemory = () => {
    if (dataDir && fs.existsSync(dataDir)) {
      const targets = [
        "facts.json",
        "facts-log.jsonl",
        "entity-index.json",
        "entity-types.json",
        "emotional-state.json",
        "fact-embeddings.json",
      ];
      for (const t of targets) {
        const p = path.join(dataDir, t);
        if (fs.existsSync(p)) {
          try {
            if (t === "facts.json") {
              fs.writeFileSync(p, JSON.stringify({ facts: [] }), "utf8");
            } else {
              fs.rmSync(p, { force: true });
            }
          } catch {}
        }
      }
    }
    results.push("memory");
  };

  const wipeVault = () => {
    if (dataDir) {
      const syncPath = path.join(dataDir, "vault-sync.json");
      if (fs.existsSync(syncPath)) {
        try {
          fs.rmSync(syncPath, { force: true });
        } catch {}
      }
    }
    results.push("vault");
  };

  const wipeCachesAndLogs = () => {
    if (dataDir) {
      const logDir = path.join(dataDir, "tool-call-log");
      if (fs.existsSync(logDir)) {
        try {
          fs.rmSync(logDir, { recursive: true, force: true });
        } catch {}
      }
    }
    // Remove temporary uploads
    const tmpDir = process.env.MANA_UPLOAD_TMP_DIR || (dataDir ? path.join(dataDir, "tmp") : null);
    if (tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
    results.push("cache-logs");
  };

  if (category === "all" || category === "everything") {
    wipeChats();
    wipeMemory();
    wipeVault();
    wipeVoice();
    wipeCachesAndLogs();
  } else if (category === "voice") {
    wipeVoice();
  } else if (category === "chats" || category === "chat") {
    wipeChats();
  } else if (category === "memory") {
    wipeMemory();
  } else if (category === "vault") {
    wipeVault();
  } else if (category === "cache-logs" || category === "caches" || category === "logs") {
    wipeCachesAndLogs();
  } else {
    throw new Error(`Unknown category: ${category}`);
  }

  return results;
}

function registerPrivacyDataRoutes(app, context = {}) {
  const checkAdminAuth = context.checkAdminAuth || (() => true);

  // GET /privacy/export-all: Export everything as one zip file with a readme
  app.get("/privacy/export-all", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const entries = gatherExportEntries(context);
      const zipBuffer = createZipBuffer(entries);
      const filename = `mana-export-${new Date().toISOString().slice(0, 10)}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", zipBuffer.length);
      return res.end(zipBuffer);
    } catch (e) {
      console.error("[Privacy] Export failed:", e);
      return res.status(500).json({ error: e.message || String(e) });
    }
  });

  // POST /privacy/delete-all: Delete everything (typed confirmation "delete-everything")
  app.post("/privacy/delete-all", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const confirmation = String(req.body?.confirmation || "").trim();
    if (confirmation !== "delete-everything") {
      return res.status(400).json({
        error: "Typed confirmation 'delete-everything' is required to wipe all data.",
      });
    }

    try {
      const deleted = wipeData("all", context);
      return res.json({ ok: true, deleted });
    } catch (e) {
      console.error("[Privacy] Delete-all failed:", e);
      return res.status(500).json({ error: e.message || String(e) });
    }
  });

  // POST /privacy/delete/:category: Per-category delete
  app.post("/privacy/delete/:category", async (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const category = String(req.params?.category || "").trim().toLowerCase();
    const confirmation = String(req.body?.confirmation || "").trim();
    const expected = `delete-${category}`;

    if (confirmation !== expected && confirmation !== "delete-everything") {
      return res.status(400).json({
        error: `Typed confirmation '${expected}' or 'delete-everything' is required.`,
      });
    }

    try {
      const deleted = wipeData(category, context);
      return res.json({ ok: true, deleted });
    } catch (e) {
      console.error(`[Privacy] Delete ${category} failed:`, e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });
}

const privacyDataCapability = {
  key: KEY,
  registerRoutes: registerPrivacyDataRoutes,
  createZipBuffer,
  gatherExportEntries,
  wipeData,
  getHealth: () => ({
    status: "configured",
    configured: true,
    message: "Privacy data export and wiping capability is active.",
  }),
};

module.exports = {
  createZipBuffer,
  gatherExportEntries,
  wipeData,
  registerPrivacyDataRoutes,
  privacyDataCapability,
};
