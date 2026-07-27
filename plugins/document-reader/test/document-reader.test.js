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

    let parseCalled = false;
    await assert.rejects(
      () =>
        documentReader.ingestPdf(bigPdf, {
          pdfParse: async () => {
            parseCalled = true;
            return { text: "should not get here" };
          },
        }),
      /too large to ingest/,
    );
    assert.equal(parseCalled, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
});

test("ingestPdf parses a valid-magic-byte PDF via the injected pdfParse and ingests the extracted text", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-doc-reader-parse-test-"));
  try {
    const pdfPath = path.join(tempDir, "report.pdf");
    fs.writeFileSync(pdfPath, "%PDF-1.4\n%fake body, parsing is mocked below%");

    const result = await documentReader.ingestPdf(pdfPath, {
      pdfParse: async (buffer) => {
        assert.ok(Buffer.isBuffer(buffer));
        return { text: "Extracted PDF body about quarterly hydration goals." };
      },
    });
    try {
      assert.equal(result.sourceType, "pdf");
      assert.equal(result.title, "report");
      const contents = fs.readFileSync(result.path, "utf8");
      assert.match(contents, /Extracted PDF body about quarterly hydration goals\./);
    } finally {
      await documentReader.removeDocument(result.id);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true });
  }
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
