// Named prompt/behavior presets: a small, user-editable list of
// {name, instructions} pairs, separate from the full persona/avatar config.
// Presets are few and small, so unlike acp-memory-store's per-session files
// this is a single JSON array file -- no need for per-item files or an
// index.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_NAME_CHARS = 80;
const MAX_INSTRUCTIONS_CHARS = 4000;

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function createPresetsStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.MANA_PRESETS_DIR ||
    path.join(__dirname, "data");
  const filePath = path.join(dataDir, "presets.json");
  const now = options.now || (() => new Date().toISOString());
  const makeId = options.makeId || (() => crypto.randomUUID());

  function ensureDir() {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  function readAll() {
    ensureDir();
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeAll(presets) {
    ensureDir();
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(presets, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  }

  function listPresets() {
    return readAll().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function getPreset(id) {
    if (!id) {
      return null;
    }
    return readAll().find((preset) => preset.id === id) || null;
  }

  function createPreset({ name, instructions }) {
    const cleanName = cleanText(name, MAX_NAME_CHARS);
    const cleanInstructions = cleanText(instructions, MAX_INSTRUCTIONS_CHARS);
    if (!cleanName) {
      throw new Error("name is required");
    }
    if (!cleanInstructions) {
      throw new Error("instructions is required");
    }

    const presets = readAll();
    const timestamp = now();
    const preset = {
      id: makeId(),
      name: cleanName,
      instructions: cleanInstructions,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    presets.push(preset);
    writeAll(presets);
    return preset;
  }

  function updatePreset(id, updates = {}) {
    const presets = readAll();
    const index = presets.findIndex((preset) => preset.id === id);
    if (index === -1) {
      return null;
    }

    const updated = { ...presets[index] };
    if (updates.name !== undefined) {
      const cleanName = cleanText(updates.name, MAX_NAME_CHARS);
      if (!cleanName) {
        throw new Error("name cannot be empty");
      }
      updated.name = cleanName;
    }
    if (updates.instructions !== undefined) {
      const cleanInstructions = cleanText(updates.instructions, MAX_INSTRUCTIONS_CHARS);
      if (!cleanInstructions) {
        throw new Error("instructions cannot be empty");
      }
      updated.instructions = cleanInstructions;
    }
    updated.updatedAt = now();

    presets[index] = updated;
    writeAll(presets);
    return updated;
  }

  function deletePreset(id) {
    const presets = readAll();
    const next = presets.filter((preset) => preset.id !== id);
    if (next.length === presets.length) {
      return false;
    }
    writeAll(next);
    return true;
  }

  return {
    dataDir,
    listPresets,
    getPreset,
    createPreset,
    updatePreset,
    deletePreset,
  };
}

module.exports = {
  MAX_NAME_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  createPresetsStore,
};
