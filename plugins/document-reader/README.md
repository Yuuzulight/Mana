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

## Why PDF parsing is dependency-injectable

`ingestPdf(filePath, { pdfParse })` accepts an optional `pdfParse`
override. In production it lazily `require("pdf-parse")`; tests inject a
fake parser instead of depending on a byte-perfect PDF fixture, which is
fragile to hand-construct and orthogonal to what this plugin is actually
responsible for (parsing correctness is `pdf-parse`'s job, not this
plugin's).
