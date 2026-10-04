const fs = require("fs");
const path = require("path");
const retrieverIndex = require("../../node-bot/tools/retriever-index");
const { extractPdfText, extractPdfTextWithOcr } = require("./pdf-text");
const {
  extractDocument,
  chunkDocument,
  DEFAULT_MAX_PROMPT_CHARS,
} = require("./document-extract");

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

// Writes ingested text to data/documents/<id>.txt (or chunked files if chunk: true)
// and folds it into the retriever index via incremental scan.
async function ingestText({ title, sourceType, sourceLabel, text, chunk = false }) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("No text content to ingest");
  }
  ensureDocsDir();
  const id = safeDocId(title || sourceLabel);

  // If chunk: true and text exceeds the per-file cap, chunk it across multiple files (#1325)
  if (chunk && trimmed.length > MAX_INGEST_CHARS) {
    const chunks = chunkDocument(trimmed, {
      maxChars: MAX_INGEST_CHARS,
      chunkSize: 18000,
      overlap: 500,
    });
    const writtenPaths = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = path.join(DOCS_DIR, `${id}-chunk-${i + 1}.txt`);
      const header = `Title: ${title || sourceLabel} (Part ${i + 1} of ${chunks.length})\nSource: ${sourceType}${
        sourceLabel ? ` (${sourceLabel})` : ""
      }\nIngested: ${new Date().toISOString()}\n\n`;
      const body = (header + chunks[i]).slice(0, MAX_INGEST_CHARS);
      await fs.promises.writeFile(chunkPath, body, "utf8");
      writtenPaths.push(chunkPath);
    }

    await retrieverIndex.incrementalScan({ roots: writtenPaths });
    return {
      id,
      title: title || sourceLabel,
      sourceType,
      path: writtenPaths[0],
      paths: writtenPaths,
      chars: trimmed.length,
      chunks: chunks.length,
    };
  }

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

async function ingestPdf(filePath, options = {}) {
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
  const buffer = await fs.promises.readFile(resolved);
  const pdfResult = await extractPdfTextWithOcr(buffer, options);
  return ingestText({
    title: path.basename(resolved, ".pdf"),
    sourceType: "pdf",
    sourceLabel: resolved,
    text: pdfResult.text,
  });
}

// Unified document ingestion for PDF, Word, Excel, PowerPoint, CSV, Text, Markdown
async function ingestDocument(filePath, options = {}) {
  const fromBuffer = Buffer.isBuffer(filePath);
  const resolved = fromBuffer ? options.filename : String(filePath || "").trim();
  if (!fromBuffer && !fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const ext = (path.extname(resolved) || "").toLowerCase();
  const baseTitle = path.basename(resolved, ext);

  const doc = await extractDocument(fromBuffer ? filePath : resolved, options);
  return ingestText({
    title: baseTitle,
    sourceType: doc.type,
    sourceLabel: options.sourceLabel || resolved,
    text: doc.text,
    chunk: options.chunk ?? true,
  });
}

// Ingest URL via fetchPage
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

// Prepares an attached document for a chat turn (#1325)
// Small docs are inlined directly into the prompt context.
// Large docs are chunked into the retriever index instead of stuffed into the prompt.
// Unreadable docs report a clear reason so Mana can tell the user why.
async function extractAndPrepareForChat(filePath, options = {}) {
  const fileName = path.basename(Buffer.isBuffer(filePath) ? options.filename : filePath);
  const maxPromptChars = options.maxPromptChars || DEFAULT_MAX_PROMPT_CHARS;

  try {
    const doc = await extractDocument(filePath, options);
    const chars = doc.text.length;

    if (chars <= maxPromptChars) {
      return {
        ok: true,
        chunked: false,
        text: doc.text,
        chars,
        fileName,
        filePath: options.sourceLabel || (Buffer.isBuffer(filePath) ? null : filePath),
        type: doc.type,
        tables: doc.tables,
        sheets: doc.sheets,
        slides: doc.slides,
        fileSize: doc.fileSize,
      };
    }

    // Large file: chunk into the retriever index
    const ingestRes = await ingestText({
      title: fileName,
      sourceType: doc.type,
      sourceLabel: options.sourceLabel || (Buffer.isBuffer(filePath) ? fileName : filePath),
      text: doc.text,
      chunk: true,
    });

    const excerpt = doc.text.slice(0, 1500).trim();
    return {
      ok: true,
      chunked: true,
      chunksCount: ingestRes.chunks || 1,
      excerpt,
      chars,
      fileName,
      filePath: options.sourceLabel || (Buffer.isBuffer(filePath) ? null : filePath),
      type: doc.type,
      fileSize: doc.fileSize,
      documentId: ingestRes.id,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
      fileName,
      filePath: options.sourceLabel || (Buffer.isBuffer(filePath) ? null : filePath),
    };
  }
}

function listDocuments() {
  ensureDocsDir();
  return fs
    .readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith(".txt"))
    .map((name) => {
      const filePath = path.join(DOCS_DIR, name);
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (!stat) return null;
      return {
        id: name.replace(/\.txt$/, ""),
        sizeBytes: stat.size,
        ingestedAt: stat.mtime.toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
}

async function removeDocument(id) {
  const safeId = String(id || "").replace(/[^a-z0-9-_ ]/gi, "");
  if (!safeId) {
    throw new Error("id is required");
  }

  // Find exact match or chunked matches (${safeId}-chunk-*.txt)
  ensureDocsDir();
  const allFiles = fs.readdirSync(DOCS_DIR);
  const matching = allFiles.filter(
    (name) => name === `${safeId}.txt` || name.startsWith(`${safeId}-chunk-`),
  );

  if (matching.length === 0) {
    throw new Error(`Document not found: ${id}`);
  }

  for (const name of matching) {
    const filePath = path.join(DOCS_DIR, name);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }

  await retrieverIndex.incrementalScan({ roots: [DOCS_DIR] });
  return { removed: safeId, filesRemoved: matching.length };
}

module.exports = {
  DOCS_DIR,
  ingestPdf,
  ingestDocument,
  ingestFile: ingestDocument,
  ingestUrl,
  ingestText,
  extractAndPrepareForChat,
  isValidPdfFile,
  listDocuments,
  removeDocument,
};

