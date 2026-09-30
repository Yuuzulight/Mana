# document-reader

Ingest a local PDF or a specific web page into Mana's existing memory
retriever (`node-bot/tools/retriever-index.js`), so she can recall and cite
it in later replies.

This intentionally doesn't stand up a separate document/vector store.
Ingested text is written to `node-bot/data/documents/<id>.txt` and folded
into the same retriever index that background memory and Deep Research
reports already use, via a single-file `incrementalScan`. Since Mana's
chat-reply path already searches that index for every reply, an ingested
PDF or page becomes part of what she can recall automatically -- no extra
wiring needed on the reply path.

## Routes

- `POST /documents/ingest/pdf` -- `{ filePath }`, an absolute path to a
  local `.pdf` file. Rejects non-`.pdf` extensions, missing files, and
  files that don't start with the `%PDF-` magic header (a renamed or
  truncated file won't silently "ingest" as empty). Capped at 25MB.
- `POST /documents/ingest/url` -- `{ url }`. Fetched via node-bot's
  `web-access.js` `fetchPage`, so it inherits the same SSRF guard as every
  other web-reading feature (private/loopback address rejection, redirect
  re-validation, http/https only) rather than duplicating that logic here.
- `GET /documents` -- lists ingested documents (id, size, ingest time).
- `DELETE /documents/:id` -- removes a document and re-syncs the retriever
  index.

## PDF text extraction

`pdf-text.js` is our own extractor (no dependency beyond Node's zlib):
`extractPdfText(buffer)` returns `{ text, pages }`. It handles classic and
stream xrefs (plus a scan-and-rebuild when the xref is damaged), object
streams, Flate (with PNG predictors), LZW, ASCII85 and ASCIIHex streams,
the page tree with inherited resources, Form XObjects, and ToUnicode /
WinAnsi / MacRoman / Standard / `/Differences` font encodings.

It refuses, with a clear error, encrypted PDFs and PDFs with no text at all
(usually scans; there's no OCR). Input size, object count, decompressed
bytes, nesting depth and operator count are all capped, so a hostile file
fails fast instead of hanging or exhausting memory. Not supported:
decryption, OCR, right-to-left or vertical layout, annotations and form
fields.

The test fixtures under `test/fixtures/` were printed by headless Edge
(playwright-core `page.pdf()`); the other test PDFs are built in
`test/pdf-text.test.js`.
