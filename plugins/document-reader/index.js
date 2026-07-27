const documentReader = require("./document-reader");

function registerDocumentReaderRoutes(app, deps) {
  const { fetchPage } = deps;

  app.post("/documents/ingest/pdf", async (req, res) => {
    try {
      const result = await documentReader.ingestPdf(req.body?.filePath);
      return res.json(result);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.post("/documents/ingest/url", async (req, res) => {
    try {
      const result = await documentReader.ingestUrl(req.body?.url, { fetchPage });
      return res.json(result);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  app.get("/documents", (req, res) => {
    return res.json({ documents: documentReader.listDocuments() });
  });

  app.delete("/documents/:id", async (req, res) => {
    try {
      const result = await documentReader.removeDocument(req.params.id);
      return res.json(result);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });
}

function pdfParseAvailable() {
  try {
    require.resolve("pdf-parse");
    return true;
  } catch (e) {
    return false;
  }
}

// This is Mana's plugin entry point convention: everything document-reader.js
// exports, plus the route registration + metadata a plugin needs to show up
// in GET /plugins and get wired into node-bot's capabilities array. See
// plugins/README.md.
module.exports = {
  ...documentReader,
  key: "documentReader",
  name: "Document Reader",
  category: "Knowledge",
  defaultEnabled: true,
  description:
    "Ingest local PDFs or a specific web page into Mana's existing memory retriever, so she can recall and cite them in replies.",
  registerRoutes: registerDocumentReaderRoutes,
  getHealth: () => {
    const available = pdfParseAvailable();
    return {
      status: available ? "configured" : "degraded",
      configured: available,
      message: available
        ? `${documentReader.listDocuments().length} document(s) ingested`
        : "pdf-parse dependency missing -- PDF ingestion unavailable",
    };
  },
};
