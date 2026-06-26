const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function writeJsonArray(filePath, items) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeSummary(input, createdAt) {
  const id = cleanText(input.id, 120);
  const summary = cleanText(input.summary, 4000);
  if (!id) {
    throw new Error("summary id is required");
  }
  if (!summary) {
    throw new Error("summary text is required");
  }

  const direction =
    input.direction === "pc-to-phone" ? "pc-to-phone" : "phone-to-pc";

  return {
    id,
    source: cleanText(input.source || "phone", 40),
    direction,
    chatId: cleanText(input.chatId, 120),
    title: cleanText(input.title, 160),
    summary,
    createdAt,
  };
}

function createMobileMemoryStore(options = {}) {
  const dataDir =
    options.dataDir || process.env.MOBILE_MEMORY_DIR || path.join(__dirname, "data");
  const now = options.now || (() => new Date().toISOString());
  const filePath = path.join(dataDir, "mobile-summaries.json");

  ensureDir(dataDir);

  function listSummaries(filter = {}) {
    const summaries = readJsonArray(filePath);
    if (!filter.direction) {
      return summaries;
    }
    return summaries.filter((item) => item.direction === filter.direction);
  }

  function saveSummary(input) {
    const summaries = readJsonArray(filePath);
    const existing = summaries.find((item) => item.id === input.id);
    if (existing) {
      return existing;
    }

    const summary = normalizeSummary(input, now());
    summaries.push(summary);
    writeJsonArray(filePath, summaries);
    return summary;
  }

  return {
    filePath,
    listSummaries,
    saveSummary,
  };
}

module.exports = {
  createMobileMemoryStore,
};
