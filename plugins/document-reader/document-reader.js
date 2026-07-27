// Local PDF/URL ingestion into Mana's existing memory retriever (see
// node-bot/tools/retriever-index.js) -- lets Mana "read" a PDF or a
// specific web page and recall it later via the same TF/embedding search
// her chat replies already use for background memory and research
// reports. This intentionally reuses that retriever end-to-end instead of
// standing up a separate document store: once a file lands in
// data/documents/ and gets indexed, it's automatically part of what every
// chat reply already searches -- no extra wiring needed on the reply path.
const fs = require("fs");
const path = require("path");
const retrieverIndex = require("../../node-bot/tools/retriever-index");

const DOCS_DIR = path.join(__dirname, "..", "..", "node-bot", "data", "documents");
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25MB local-file ceiling
const MAX_INGEST_CHARS = 20000; // matches retriever-index.js's per-file cap

function ensureDocsDir() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

// Magic-byte check (same intent as model-management.js's isValidGgufFile)
// -- a stray or corrupted file with a .pdf extension shouldn't silently
// "ingest" as an empty/garbage document.
function isValidPdfFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    return buf.toString("ascii") === "%PDF-";
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function safeDocId(label) {
  const base =
    String(label || "document")
      .replace(/[^a-z0-9-_ ]/gi, "")
      .trim()
      .slice(0, 60) || "document";
  return `${base}-${Date.now()}`;
}

// Writes ingested text to data/documents/<id>.txt and folds it into the
// retriever index via a single-file incremental scan.
async function ingestText({ title, sourceType, sourceLabel, text }) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("No text content to ingest");
  }
  ensureDocsDir();
  const id = safeDocId(title || sourceLabel);
  const filePath = path.join(DOCS_DIR, `${id}.txt`);
  const header = `Title: ${title || sourceLabel}\nSource: ${sourceType}${
    sourceLabel ? ` (${sourceLabel})` : ""
  }\nIngested: ${new Date().toISOString()}\n\n`;
  const body = (header + trimmed).slice(0, MAX_INGEST_CHARS);
  await fs.promises.writeFile(filePath, body, "utf8");
  await retrieverIndex.incrementalScan({ roots: [filePath] });
  return {
    id,
    title: title || sourceLabel,
    sourceType,
    path: filePath,
    chars: body.length,
  };
}

async function ingestPdf(filePath, { pdfParse } = {}) {
  const resolved = String(filePath || "").trim();
  if (!resolved.toLowerCase().endsWith(".pdf")) {
    throw new Error("filePath must point to a .pdf file");
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!isValidPdfFile(resolved)) {
    throw new Error(`File does not look like a valid PDF: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_PDF_BYTES) {
    throw new Error(
      `PDF is too large to ingest (${Math.round(stat.size / 1024 / 1024)}MB, limit ${
        MAX_PDF_BYTES / 1024 / 1024
      }MB)`,
    );
  }
  const parse = pdfParse || require("pdf-parse");
  const buffer = await fs.promises.readFile(resolved);
  const parsed = await parse(buffer);
  return ingestText({
    title: path.basename(resolved, ".pdf"),
    sourceType: "pdf",
    sourceLabel: resolved,
    text: parsed.text,
  });
}

// URL ingestion delegates the fetch to node-bot's web-access.js fetchPage
// (passed in as a dependency) so it inherits the same SSRF guard
// (private/loopback rejection, redirect re-validation, http/https only)
// instead of duplicating that logic here.
async function ingestUrl(url, { fetchPage } = {}) {
  if (typeof fetchPage !== "function") {
    throw new Error("fetchPage dependency is required to ingest a URL");
  }
  const page = await fetchPage(url, { maxChars: MAX_INGEST_CHARS });
  return ingestText({
    title: page.title || page.url,
    sourceType: "url",
    sourceLabel: page.url,
    text: page.text,
  });
}

function listDocuments() {
  ensureDocsDir();
  return fs
    .readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith(".txt"))
    .map((name) => {
      const filePath = path.join(DOCS_DIR, name);
      const stat = fs.statSync(filePath);
      return {
        id: name.replace(/\.txt$/, ""),
        sizeBytes: stat.size,
        ingestedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
}

async function removeDocument(id) {
  const safeId = String(id || "").replace(/[^a-z0-9-_ ]/gi, "");
  if (!safeId) {
    throw new Error("id is required");
  }
  const filePath = path.join(DOCS_DIR, `${safeId}.txt`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Document not found: ${id}`);
  }
  await fs.promises.unlink(filePath);
  await retrieverIndex.incrementalScan({ roots: [DOCS_DIR] });
  return { removed: safeId };
}

module.exports = {
  DOCS_DIR,
  ingestPdf,
  ingestUrl,
  ingestText,
  isValidPdfFile,
  listDocuments,
  removeDocument,
};
