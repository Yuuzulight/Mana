const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const documentReader = require("../document-reader");

// Every test uses its own doc id (timestamp-suffixed by safeDocId) and
// cleans up after itself via removeDocument, so tests can run in any order
// without clobbering each other's entries in the shared retriever index.

test("ingestText writes a .txt file under DOCS_DIR and folds it into the retriever, then removeDocument cleans it up", async () => {
  const result = await documentReader.ingestText({
    title: "test-doc-basic",
    sourceType: "test",
    text: "Mana remembers this fact for later recall.",
  });

  assert.equal(result.title, "test-doc-basic");
  assert.equal(result.sourceType, "test");
  assert.ok(fs.existsSync(result.path));
  assert.ok(result.path.startsWith(documentReader.DOCS_DIR));

  const contents = fs.readFileSync(result.path, "utf8");
  assert.match(contents, /Mana remembers this fact for later recall\./);
  assert.match(contents, /Source: test/);

  const listed = documentReader.listDocuments();
  assert.ok(listed.some((d) => d.id === result.id));

  await documentReader.removeDocument(result.id);
  assert.ok(!fs.existsSync(result.path));
  assert.ok(!documentReader.listDocuments().some((d) => d.id === result.id));
});

test("ingestText rejects empty/whitespace-only text", async () => {
  await assert.rejects(
    () => documentReader.ingestText({ title: "empty", sourceType: "test", text: "   " }),
    /No text content/,
  );
});

test("ingestText truncates to the retriever's per-file character cap", async () => {
  const huge = "x".repeat(50000);
  const result = await documentReader.ingestText({
    title: "huge-doc",
    sourceType: "test",
    text: huge,
  });
  try {
    assert.ok(result.chars <= 20000);
    const contents = fs.readFileSync(result.path, "utf8");
    assert.ok(contents.length <= 20000);
  } finally {
    await documentReader.removeDocument(result.id);
  }
});

test("ingestPdf validates extension, existence, and PDF magic bytes before parsing", async () => {
  await assert.rejects(
    () => documentReader.ingestPdf("C:\\docs\\not-a-pdf.txt"),
    /must point to a \.pdf file/,
  );
  await assert.rejects(
    () => documentReader.ingestPdf("C:\\does\\not\\exist.pdf"),
    /File not found/,
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-doc-reader-test-"));
  try {
    const fakePdf = path.join(tempDir, "fake.pdf");
    fs.writeFileSync(fakePdf, "this is not actually a pdf");
    await assert.rejects(
      () => documentReader.ingestPdf(fakePdf),
      /does not look like a valid PDF/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("ingestPdf rejects an oversized file before ever parsing it", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-doc-reader-size-test-"));
  try {
    const bigPdf = path.join(tempDir, "big.pdf");
    const fd = fs.openSync(bigPdf, "w");
    fs.writeSync(fd, "%PDF-1.4\n");
    fs.ftruncateSync(fd, 26 * 1024 * 1024);
    fs.closeSync(fd);

    await assert.rejects(() => documentReader.ingestPdf(bigPdf), /too large to ingest/);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("ingestPdf extracts a real PDF's text and ingests it", async () => {
  const result = await documentReader.ingestPdf(path.join(__dirname, "fixtures", "chromium-mixed.pdf"));
  try {
    assert.equal(result.sourceType, "pdf");
    assert.equal(result.title, "chromium-mixed");
    const contents = fs.readFileSync(result.path, "utf8");
    assert.match(contents, /The quick brown fox jumps over the lazy dog\./);
    assert.match(contents, /日本語のテキスト/);
  } finally {
    await documentReader.removeDocument(result.id);
  }
});

test("ingestPdf refuses a PDF with no text instead of ingesting nothing", async () => {
  await assert.rejects(
    () => documentReader.ingestPdf(path.join(__dirname, "fixtures", "image-only.pdf")),
    /no extractable text/,
  );
});

test("ingestUrl requires a fetchPage dependency and ingests what it returns", async () => {
  await assert.rejects(
    () => documentReader.ingestUrl("https://example.com"),
    /fetchPage dependency is required/,
  );

  const fakeFetchPage = async (url) => ({
    url,
    title: "Example Domain",
    text: "This domain is for use in illustrative examples.",
    truncated: false,
  });

  const result = await documentReader.ingestUrl("https://example.com", {
    fetchPage: fakeFetchPage,
  });
  try {
    assert.equal(result.sourceType, "url");
    assert.equal(result.title, "Example Domain");
    const contents = fs.readFileSync(result.path, "utf8");
    assert.match(contents, /This domain is for use in illustrative examples\./);
    assert.match(contents, /Source: url \(https:\/\/example\.com\)/);
  } finally {
    await documentReader.removeDocument(result.id);
  }
});

test("removeDocument rejects a missing id and sanitizes path-traversal attempts", async () => {
  await assert.rejects(() => documentReader.removeDocument(""), /id is required/);
  await assert.rejects(
    () => documentReader.removeDocument("../../etc/passwd"),
    /Document not found/,
  );
});

test("isValidPdfFile checks the %PDF- magic header", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-doc-reader-magic-test-"));
  try {
    const realish = path.join(tempDir, "real.pdf");
    fs.writeFileSync(realish, "%PDF-1.7\n...");
    const fake = path.join(tempDir, "fake.pdf");
    fs.writeFileSync(fake, "not a pdf at all");

    assert.equal(documentReader.isValidPdfFile(realish), true);
    assert.equal(documentReader.isValidPdfFile(fake), false);
    assert.equal(documentReader.isValidPdfFile(path.join(tempDir, "missing.pdf")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("listDocuments skips a document deleted between readdir and stat instead of throwing", async () => {
  const result = await documentReader.ingestText({
    title: "test-doc-vanishing",
    sourceType: "test",
    text: "This one disappears mid-list.",
  });
  const realStatSync = fs.statSync;
  fs.statSync = (p, opts) => (p === result.path ? realStatSync(`${p}.missing`, opts) : realStatSync(p, opts));
  try {
    const listed = documentReader.listDocuments();
    assert.ok(!listed.some((d) => d.id === result.id));
  } finally {
    fs.statSync = realStatSync;
    await documentReader.removeDocument(result.id);
  }
});

// Helper to create test zip files for docx/xlsx/pptx fixtures
const zlib = require("zlib");
const {
  extractDocument,
  extractDocx,
  extractXlsx,
  extractPptx,
  extractCsv,
  extractText,
  chunkDocument,
} = require("../document-extract");
const { extractPdfTextWithOcr } = require("../pdf-text");

function createTestZip(files) {
  const fileRecords = [];
  let offset = 0;
  const parts = [];

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const dataBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const compressed = zlib.deflateRawSync(dataBuf);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    fileRecords.push({
      nameBuf,
      compressedLen: compressed.length,
      uncompressedLen: dataBuf.length,
      offset,
    });

    parts.push(localHeader, compressed);
    offset += localHeader.length + compressed.length;
  }

  const cdStart = offset;
  let cdSize = 0;

  for (const rec of fileRecords) {
    const cdHeader = Buffer.alloc(46 + rec.nameBuf.length);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0, 8);
    cdHeader.writeUInt16LE(8, 10);
    cdHeader.writeUInt32LE(0, 16);
    cdHeader.writeUInt32LE(rec.compressedLen, 20);
    cdHeader.writeUInt32LE(rec.uncompressedLen, 24);
    cdHeader.writeUInt16LE(rec.nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(rec.offset, 42);
    rec.nameBuf.copy(cdHeader, 46);

    parts.push(cdHeader);
    cdSize += cdHeader.length;
    offset += cdHeader.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(fileRecords.length, 8);
  eocd.writeUInt16LE(fileRecords.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  parts.push(eocd);

  return Buffer.concat(parts);
}

test("extractDocx parses paragraphs and tables into formatted text and markdown tables", () => {
  const docXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Quarterly Summary</w:t></w:r></w:p>
    <w:p><w:r><w:t>Key metrics below:</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Latency</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>0.8s</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;

  const zip = createTestZip({ "word/document.xml": docXml });
  const result = extractDocx(zip);

  assert.equal(result.type, "docx");
  assert.equal(result.tables, 1);
  assert.match(result.text, /Quarterly Summary/);
  assert.match(result.text, /\| Metric \| Value \|/);
  assert.match(result.text, /\| Latency \| 0\.8s \|/);
});

test("extractXlsx parses shared strings, numbers, booleans, and sheets into markdown tables", () => {
  const sstXml = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Model</t></si>
  <si><t>Engine</t></si>
  <si><t>Qwen3-TTS</t></si>
  <si><t>CUDA Graphs</t></si>
</sst>`;

  const wbXml = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets>
    <sheet name="VoiceStack" sheetId="1" r:id="rId1" />
  </sheets>
</workbook>`;

  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1"><v>Port</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>2</v></c>
      <c r="B2" t="s"><v>3</v></c>
      <c r="C2"><v>5012</v></c>
    </row>
  </sheetData>
</worksheet>`;

  const zip = createTestZip({
    "xl/sharedStrings.xml": sstXml,
    "xl/workbook.xml": wbXml,
    "xl/worksheets/sheet1.xml": sheetXml,
  });

  const result = extractXlsx(zip);
  assert.equal(result.type, "xlsx");
  assert.equal(result.sheets, 1);
  assert.match(result.text, /### Sheet: VoiceStack/);
  assert.match(result.text, /\| Model \| Engine \|/);
  assert.match(result.text, /\| Qwen3-TTS \| CUDA Graphs \| 5012 \|/);
});

test("extractPptx parses slides in order with slide headers", () => {
  const s1Xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Mana Architecture</a:t></a:r></a:p>
    <a:p><a:r><a:t>Offline-first desktop companion</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;

  const s2Xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Voice System</a:t></a:r></a:p>
    <a:p><a:r><a:t>Qwen3-TTS exclusively</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;

  const zip = createTestZip({
    "ppt/slides/slide1.xml": s1Xml,
    "ppt/slides/slide2.xml": s2Xml,
  });

  const result = extractPptx(zip);
  assert.equal(result.type, "pptx");
  assert.equal(result.slides, 2);
  assert.match(result.text, /### Slide 1\nMana Architecture\nOffline-first desktop companion/);
  assert.match(result.text, /### Slide 2\nVoice System\nQwen3-TTS exclusively/);
});

test("extractCsv parses quotes, commas, newlines and formats as a markdown table", () => {
  const csv = `Item,Description,Price\n"5080 GPU","RTX 5080, 16GB",1199\n"Audio DAC","Schiit Hel 2E",199\n`;
  const result = extractCsv(csv);

  assert.equal(result.type, "csv");
  assert.equal(result.rows, 3);
  assert.match(result.text, /\| Item \| Description \| Price \|/);
  assert.match(result.text, /\| 5080 GPU \| RTX 5080, 16GB \| 1199 \|/);
});

test("extractPdfTextWithOcr falls back to OCR when a PDF contains no text", async () => {
  const imagePdfPath = path.join(__dirname, "fixtures", "image-only.pdf");
  const buffer = fs.readFileSync(imagePdfPath);

  // Without OCR runner, rejects as having no text
  await assert.rejects(
    () => extractPdfTextWithOcr(buffer),
    /no extractable text/,
  );

  // With mock OCR runner, extracts image and returns OCR text
  let ocrCalledWithBuffer = false;
  const mockRunOcr = async (imgBuf) => {
    ocrCalledWithBuffer = Buffer.isBuffer(imgBuf);
    return "Recognized text from scanned document";
  };

  const ocrResult = await extractPdfTextWithOcr(buffer, { runOcr: mockRunOcr });
  assert.equal(ocrCalledWithBuffer, true);
  assert.equal(ocrResult.ocr, true);
  assert.equal(ocrResult.text, "Recognized text from scanned document");
});

test("chunkDocument splits large documents cleanly on paragraph breaks", () => {
  const p1 = "First paragraph content. ".repeat(200); // ~5000 chars
  const p2 = "Second paragraph content. ".repeat(200);
  const p3 = "Third paragraph content. ".repeat(200);
  const fullText = `${p1}\n\n${p2}\n\n${p3}`;

  const smallChunks = chunkDocument(fullText, { maxChars: 6000, chunkSize: 5500, overlap: 300 });
  assert.ok(smallChunks.length >= 3);
  assert.ok(smallChunks[0].includes("First paragraph"));
  assert.ok(smallChunks[1].includes("Second paragraph"));
});

test("extractAndPrepareForChat inlines small documents and chunks large documents into retriever", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-chat-prep-test-"));
  try {
    // 1. Small document
    const smallDocxPath = path.join(tempDir, "small.docx");
    const smallZip = createTestZip({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Short memo about Mana</w:t></w:r></w:p></w:body></w:document>`,
    });
    fs.writeFileSync(smallDocxPath, smallZip);

    const smallPrep = await documentReader.extractAndPrepareForChat(smallDocxPath, {
      maxPromptChars: 5000,
    });
    assert.equal(smallPrep.ok, true);
    assert.equal(smallPrep.chunked, false);
    assert.equal(smallPrep.text, "Short memo about Mana");
    assert.equal(smallPrep.fileName, "small.docx");

    // 2. Large document (exceeds maxPromptChars)
    const largeDocxPath = path.join(tempDir, "large.docx");
    const hugeParagraphs = Array.from({ length: 100 }, (_, i) => `<w:p><w:r><w:t>Paragraph ${i}: ${"Lorem ipsum text. ".repeat(30)}</w:t></w:r></w:p>`).join("");
    const largeZip = createTestZip({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${hugeParagraphs}</w:body></w:document>`,
    });
    fs.writeFileSync(largeDocxPath, largeZip);

    const largePrep = await documentReader.extractAndPrepareForChat(largeDocxPath, {
      maxPromptChars: 2000,
    });
    assert.equal(largePrep.ok, true);
    assert.equal(largePrep.chunked, true);
    assert.ok(largePrep.chunksCount >= 1);
    assert.ok(largePrep.excerpt.includes("Paragraph 0"));
    assert.ok(largePrep.documentId);

    // Clean up retriever doc
    await documentReader.removeDocument(largePrep.documentId);

    // 3. Unreadable document (corrupted/missing)
    const corruptPath = path.join(tempDir, "broken.docx");
    fs.writeFileSync(corruptPath, "not a real docx archive");
    const brokenPrep = await documentReader.extractAndPrepareForChat(corruptPath);
    assert.equal(brokenPrep.ok, false);
    assert.ok(brokenPrep.error);
    assert.equal(brokenPrep.fileName, "broken.docx");
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("ingestDocument ingests Word and Excel documents directly into retriever index", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-ingest-doc-test-"));
  try {
    const docxPath = path.join(tempDir, "meeting-notes.docx");
    const zip = createTestZip({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Meeting notes from Oct 3 2026: discuss issue 1325 attachment feature.</w:t></w:r></w:p></w:body></w:document>`,
    });
    fs.writeFileSync(docxPath, zip);

    const res = await documentReader.ingestDocument(docxPath);
    assert.equal(res.sourceType, "docx");
    assert.equal(res.title, "meeting-notes");

    const content = fs.readFileSync(res.path, "utf8");
    assert.match(content, /Meeting notes from Oct 3 2026/);

    await documentReader.removeDocument(res.id);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

