// Local document text & table extraction for Mana (#1325).
// Supports Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV (.csv),
// Plain text (.txt), Markdown (.md), and PDF (.pdf) with OCR fallback.
// All extraction is completely local; no data is uploaded anywhere.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { extractPdfTextWithOcr, extractPdfImages } = require("./pdf-text");

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024; // 64MB ceiling
const DEFAULT_MAX_PROMPT_CHARS = 12000;
const DEFAULT_CHUNK_SIZE = 8000;
const DEFAULT_CHUNK_OVERLAP = 500;

// Read entries from a ZIP buffer in memory without external dependencies.
// .docx, .xlsx, and .pptx are all OpenXML ZIP archives.
function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("readZipEntries expects a Buffer");
  }
  if (buffer.length < 22) {
    throw new Error("File is too small to be a valid ZIP archive");
  }

  // Find End of Central Directory (EOCD) signature: 0x06054b50 ("PK\x05\x06")
  let eocdOffset = -1;
  const maxSearch = Math.min(buffer.length, 65557);
  for (let i = buffer.length - 22; i >= buffer.length - maxSearch; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error("Not a valid ZIP archive (no EOCD record found)");
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();

  let p = cdOffset;
  for (let i = 0; i < totalEntries && p + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) {
      break; // Corrupted central directory
    }
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localHeaderOffset = buffer.readUInt32LE(p + 42);

    const name = buffer.toString("utf8", p + 46, p + 46 + nameLen);

    entries.set(name, () => {
      if (localHeaderOffset + 30 > buffer.length) {
        throw new Error(`Corrupted entry header in ZIP for ${name}`);
      }
      const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + compressedSize;

      if (dataEnd > buffer.length) {
        throw new Error(`Corrupted entry data in ZIP for ${name}`);
      }
      const compressedData = buffer.subarray(dataStart, dataEnd);

      if (method === 0) {
        return compressedData;
      }
      if (method === 8) {
        return zlib.inflateRawSync(compressedData);
      }
      throw new Error(`Unsupported compression method (${method}) in ZIP`);
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

// Extract text and formatted tables from Word (.docx)
function extractDocx(buffer) {
  const zip = readZipEntries(buffer);
  const docEntry = zip.get("word/document.xml");
  if (!docEntry) {
    throw new Error("Invalid Word document: missing word/document.xml");
  }
  const xml = docEntry().toString("utf8");

  const lines = [];
  let tableCount = 0;
  // Match paragraphs and tables in document order
  const blockRegex = /<w:(p|tbl)\b[\s\S]*?<\/w:\1>/g;
  let match;

  while ((match = blockRegex.exec(xml)) !== null) {
    const blockType = match[1];
    const blockXml = match[0];

    if (blockType === "p") {
      const texts = [];
      const textRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
      let tm;
      while ((tm = textRegex.exec(blockXml)) !== null) {
        texts.push(tm[1]);
      }
      const pText = texts.join("").trim();
      if (pText) {
        lines.push(pText);
      }
    } else if (blockType === "tbl") {
      tableCount++;
      const rows = [];
      const rowRegex = /<w:tr\b[\s\S]*?<\/w:tr>/g;
      let rm;
      while ((rm = rowRegex.exec(blockXml)) !== null) {
        const rowXml = rm[0];
        const cells = [];
        const cellRegex = /<w:tc\b[\s\S]*?<\/w:tc>/g;
        let cm;
        while ((cm = cellRegex.exec(rowXml)) !== null) {
          const cellXml = cm[0];
          const cellTexts = [];
          const textRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
          let tm;
          while ((tm = textRegex.exec(cellXml)) !== null) {
            cellTexts.push(tm[1]);
          }
          cells.push(
            cellTexts
              .join(" ")
              .replace(/\|/g, "\\|")
              .replace(/\r?\n/g, " ")
              .trim(),
          );
        }
        if (cells.length > 0) {
          rows.push(cells);
        }
      }
      if (rows.length > 0) {
        const maxCols = Math.max(...rows.map((r) => r.length));
        rows.forEach((r, idx) => {
          while (r.length < maxCols) r.push("");
          lines.push("| " + r.join(" | ") + " |");
          if (idx === 0) {
            lines.push("| " + Array(maxCols).fill("---").join(" | ") + " |");
          }
        });
        lines.push(""); // spacing after table
      }
    }
  }

  const resultText = lines.join("\n\n").trim();
  if (!resultText) {
    throw new Error("This Word document contains no readable text");
  }
  return {
    text: resultText,
    type: "docx",
    tables: tableCount,
  };
}

// Helper to convert Excel column letter to 0-based index: A->0, B->1, Z->25, AA->26
function colLetterToIndex(col) {
  let idx = 0;
  for (let i = 0; i < col.length; i++) {
    idx = idx * 26 + (col.charCodeAt(i) - 64);
  }
  return idx - 1;
}

// Extract text and formatted tables from Excel (.xlsx)
function extractXlsx(buffer) {
  const zip = readZipEntries(buffer);

  // 1. Parse shared strings if present
  const sharedStrings = [];
  const sstEntry = zip.get("xl/sharedStrings.xml");
  if (sstEntry) {
    const sstXml = sstEntry().toString("utf8");
    const siRegex = /<si\b[\s\S]*?<\/si>/g;
    let siMatch;
    while ((siMatch = siRegex.exec(sstXml)) !== null) {
      const siXml = siMatch[0];
      const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      const texts = [];
      let tm;
      while ((tm = tRegex.exec(siXml)) !== null) {
        texts.push(tm[1]);
      }
      sharedStrings.push(texts.join(""));
    }
  }

  // 2. Discover sheets
  const sheetNames = new Map(); // rId/sheetId -> name
  const wbEntry = zip.get("xl/workbook.xml");
  if (wbEntry) {
    const wbXml = wbEntry().toString("utf8");
    const sheetRegex = /<sheet\b[^>]*name="([^"]+)"[^>]*sheetId="([^"]+)"/g;
    let sm;
    while ((sm = sheetRegex.exec(wbXml)) !== null) {
      sheetNames.set(sm[2], sm[1]);
    }
  }

  // 3. Find all sheet files
  const sheetKeys = Array.from(zip.keys())
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)[0], 10);
      const numB = parseInt(b.match(/\d+/)[0], 10);
      return numA - numB;
    });

  if (sheetKeys.length === 0) {
    throw new Error("Invalid Excel workbook: no worksheets found");
  }

  const sections = [];
  let sheetCount = 0;

  for (const sheetKey of sheetKeys) {
    sheetCount++;
    const sheetNum = sheetKey.match(/\d+/)[0];
    const sheetTitle = sheetNames.get(sheetNum) || `Sheet ${sheetNum}`;
    const sheetXml = zip.get(sheetKey)().toString("utf8");

    const rowRegex = /<row\b[^>]*r="(\d+)"[\s\S]*?<\/row>/g;
    let rm;
    const rows = [];

    while ((rm = rowRegex.exec(sheetXml)) !== null) {
      const rowXml = rm[0];
      const cellMap = new Map();
      const cellRegex = /<c\b[^>]*r="([A-Z]+)\d+"(?:[^>]*t="([^"]*)")?[^>]*>([\s\S]*?)<\/c>/g;
      let cm;

      while ((cm = cellRegex.exec(rowXml)) !== null) {
        const colLetter = cm[1];
        const cellType = cm[2] || "";
        const cellBody = cm[3] || "";

        let val = "";
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellBody);
        const isMatch = /<is\b[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cellBody);

        if (cellType === "s" && vMatch) {
          const strIdx = parseInt(vMatch[1], 10);
          val = sharedStrings[strIdx] ?? "";
        } else if (cellType === "inlineStr" || isMatch) {
          val = isMatch ? isMatch[1] : "";
        } else if (cellType === "b" && vMatch) {
          val = vMatch[1] === "1" ? "TRUE" : "FALSE";
        } else if (vMatch) {
          val = vMatch[1];
        }

        val = val
          .replace(/\|/g, "\\|")
          .replace(/\r?\n/g, " ")
          .trim();
        if (val) {
          cellMap.set(colLetterToIndex(colLetter), val);
        }
      }

      if (cellMap.size > 0) {
        const maxCol = Math.max(...cellMap.keys());
        const rowCells = [];
        for (let c = 0; c <= maxCol; c++) {
          rowCells.push(cellMap.get(c) || "");
        }
        rows.push(rowCells);
      }
    }

    if (rows.length > 0) {
      const maxCols = Math.max(...rows.map((r) => r.length));
      const tableLines = [`### Sheet: ${sheetTitle}`];
      rows.forEach((r, idx) => {
        while (r.length < maxCols) r.push("");
        tableLines.push("| " + r.join(" | ") + " |");
        if (idx === 0) {
          tableLines.push("| " + Array(maxCols).fill("---").join(" | ") + " |");
        }
      });
      sections.push(tableLines.join("\n"));
    }
  }

  const resultText = sections.join("\n\n").trim();
  if (!resultText) {
    throw new Error("This Excel workbook contains no readable data");
  }
  return {
    text: resultText,
    type: "xlsx",
    sheets: sheetCount,
  };
}

// Extract text from PowerPoint presentations (.pptx)
function extractPptx(buffer) {
  const zip = readZipEntries(buffer);
  const slideKeys = Array.from(zip.keys())
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)[0], 10);
      const numB = parseInt(b.match(/\d+/)[0], 10);
      return numA - numB;
    });

  if (slideKeys.length === 0) {
    throw new Error("Invalid PowerPoint presentation: no slides found");
  }

  const slides = [];
  for (let i = 0; i < slideKeys.length; i++) {
    const slideXml = zip.get(slideKeys[i])().toString("utf8");
    const pRegex = /<a:p\b[\s\S]*?<\/a:p>/g;
    let pm;
    const slideLines = [];

    while ((pm = pRegex.exec(slideXml)) !== null) {
      const pXml = pm[0];
      const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
      let tm;
      const texts = [];
      while ((tm = tRegex.exec(pXml)) !== null) {
        texts.push(tm[1]);
      }
      const line = texts.join("").trim();
      if (line) {
        slideLines.push(line);
      }
    }

    if (slideLines.length > 0) {
      slides.push(`### Slide ${i + 1}\n${slideLines.join("\n")}`);
    }
  }

  const resultText = slides.join("\n\n").trim();
  if (!resultText) {
    throw new Error("This PowerPoint presentation contains no readable text");
  }
  return {
    text: resultText,
    type: "pptx",
    slides: slideKeys.length,
  };
}

// Parse CSV text into formatted rows / markdown table
function extractCsv(input) {
  const str = (Buffer.isBuffer(input) ? input.toString("utf8") : String(input || ""))
    .replace(/^\uFEFF/, "") // strip UTF-8 BOM
    .trim();

  if (!str) {
    throw new Error("This CSV file is empty");
  }

  // Parse CSV records according to RFC 4180
  const rows = [];
  let currentRow = [];
  let currentField = "";
  let insideQuotes = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];

    if (insideQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        insideQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        insideQuotes = true;
      } else if (ch === ",") {
        currentRow.push(currentField.trim());
        currentField = "";
      } else if (ch === "\r" && next === "\n") {
        currentRow.push(currentField.trim());
        currentField = "";
        if (currentRow.some(Boolean)) rows.push(currentRow);
        currentRow = [];
        i++;
      } else if (ch === "\n" || ch === "\r") {
        currentRow.push(currentField.trim());
        currentField = "";
        if (currentRow.some(Boolean)) rows.push(currentRow);
        currentRow = [];
      } else {
        currentField += ch;
      }
    }
  }
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(Boolean)) rows.push(currentRow);
  }

  if (rows.length === 0) {
    throw new Error("This CSV file contains no data rows");
  }

  const maxCols = Math.max(...rows.map((r) => r.length));
  const tableLines = [];
  rows.forEach((r, idx) => {
    while (r.length < maxCols) r.push("");
    const formatted = r.map((c) => c.replace(/\|/g, "\\|").replace(/\r?\n/g, " "));
    tableLines.push("| " + formatted.join(" | ") + " |");
    if (idx === 0) {
      tableLines.push("| " + Array(maxCols).fill("---").join(" | ") + " |");
    }
  });

  return {
    text: tableLines.join("\n"),
    type: "csv",
    rows: rows.length,
    columns: maxCols,
  };
}

// Plain text or Markdown document
function extractText(input, type = "txt") {
  const str = (Buffer.isBuffer(input) ? input.toString("utf8") : String(input || ""))
    .replace(/^\uFEFF/, "")
    .trim();

  if (!str) {
    throw new Error(`This ${type.toUpperCase()} file is empty`);
  }
  return {
    text: str,
    type,
    chars: str.length,
  };
}

// Unified document extractor: routes to format-specific handler
async function extractDocument(filePathOrBuffer, options = {}) {
  let buffer;
  let filename = options.filename || "";

  if (typeof filePathOrBuffer === "string") {
    const resolvedPath = path.resolve(filePathOrBuffer);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${resolvedPath}`);
    }
    const stat = fs.statSync(resolvedPath);
    if (stat.size > MAX_DOCUMENT_BYTES) {
      throw new Error(
        `File is too large (${Math.round(stat.size / 1024 / 1024)}MB, limit ${
          MAX_DOCUMENT_BYTES / 1024 / 1024
        }MB)`,
      );
    }
    buffer = await fs.promises.readFile(resolvedPath);
    filename = filename || path.basename(resolvedPath);
  } else if (Buffer.isBuffer(filePathOrBuffer)) {
    buffer = filePathOrBuffer;
  } else {
    throw new TypeError("extractDocument expects a file path string or Buffer");
  }

  const ext = (path.extname(filename) || "").toLowerCase();

  switch (ext) {
    case ".pdf": {
      const res = await extractPdfTextWithOcr(buffer, options);
      return { ...res, type: "pdf", fileName: filename, fileSize: buffer.length };
    }
    case ".docx": {
      const res = extractDocx(buffer);
      return { ...res, fileName: filename, fileSize: buffer.length };
    }
    case ".xlsx": {
      const res = extractXlsx(buffer);
      return { ...res, fileName: filename, fileSize: buffer.length };
    }
    case ".pptx": {
      const res = extractPptx(buffer);
      return { ...res, fileName: filename, fileSize: buffer.length };
    }
    case ".csv": {
      const res = extractCsv(buffer);
      return { ...res, fileName: filename, fileSize: buffer.length };
    }
    case ".txt":
    case ".text": {
      const res = extractText(buffer, "txt");
      return { ...res, fileName: filename, fileSize: buffer.length };
    }
    case ".md":
    case ".markdown": {
      const res = extractText(buffer, "md");
      return { ...res, fileName: filename, fileSize: buffer.length };
    }
    default: {
      // Magic bytes fallback inspection
      if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
        const res = await extractPdfTextWithOcr(buffer, options);
        return { ...res, type: "pdf", fileName: filename, fileSize: buffer.length };
      }
      if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
        // Zip archive -- try docx, xlsx, pptx based on internal structures
        try {
          return { ...extractDocx(buffer), fileName: filename, fileSize: buffer.length };
        } catch (_) {}
        try {
          return { ...extractXlsx(buffer), fileName: filename, fileSize: buffer.length };
        } catch (_) {}
        try {
          return { ...extractPptx(buffer), fileName: filename, fileSize: buffer.length };
        } catch (_) {}
      }
      // If it looks like plain UTF-8 text
      try {
        const str = buffer.toString("utf8");
        if (!/[\x00-\x08\x0e-\x1f]/.test(str.slice(0, 1024))) {
          return { ...extractText(buffer, ext ? ext.slice(1) : "txt"), fileName: filename, fileSize: buffer.length };
        }
      } catch (_) {}

      throw new Error(`Unsupported document type: ${ext || "unknown format"}`);
    }
  }
}

// Split large document text into chunks
function chunkDocument(text, options = {}) {
  const maxChars = options.maxChars || DEFAULT_MAX_PROMPT_CHARS;
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap || DEFAULT_CHUNK_OVERLAP;

  const trimmed = String(text || "").trim();
  if (trimmed.length <= maxChars) {
    return [trimmed];
  }

  const chunks = [];
  let start = 0;

  while (start < trimmed.length) {
    let end = Math.min(start + chunkSize, trimmed.length);

    if (end < trimmed.length) {
      // Find a clean break point (double newline, single newline, or sentence end)
      const lookback = Math.max(start + chunkSize - 1000, start);
      const window = trimmed.slice(lookback, end);
      const breakIdx = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf("\n"),
        window.lastIndexOf(". "),
      );
      if (breakIdx > 0) {
        end = lookback + breakIdx + 1;
      }
    }

    const chunk = trimmed.slice(start, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (end >= trimmed.length) {
      break;
    }
    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}

module.exports = {
  extractDocument,
  extractDocx,
  extractXlsx,
  extractPptx,
  extractCsv,
  extractText,
  chunkDocument,
  readZipEntries,
  DEFAULT_MAX_PROMPT_CHARS,
  DEFAULT_CHUNK_SIZE,
};
