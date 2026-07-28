// Issue #211: buildSnippets() is the shared helper search()'s three
// branches all now call instead of each doing its own flat
// slice(0, 800) -- tested directly against real temp files rather than
// through search()/loadIndexSync(), since INDEX_PATH is a fixed path (not
// env-overridable) and buildSnippets never touches it.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildSnippets } = require("../tools/retriever-index");

function writeTempFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retriever-compress-"));
  const file = path.join(dir, "note.md");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

test("buildSnippets flat-truncates to 800 chars when no compress function is given", async () => {
  const file = writeTempFile("x".repeat(2000));
  const out = await buildSnippets([{ id: file, path: file, score: 1 }], "query", null);
  assert.equal(out.length, 1);
  assert.equal(out[0].snippet.length, 800);
  assert.equal(out[0].snippet, "x".repeat(800));
  assert.equal(out[0]._raw, undefined, "internal _raw field must not leak");
});

test("buildSnippets returns an empty snippet (not a throw) when the file can't be read", async () => {
  const out = await buildSnippets(
    [{ id: "missing", path: "/no/such/file.md", score: 1 }],
    "query",
    null,
  );
  assert.equal(out[0].snippet, "");
});

test("buildSnippets calls compress once for the whole batch and uses the condensed result", async () => {
  const fileA = writeTempFile("Apples are a fruit that grows on trees. ".repeat(30));
  const fileB = writeTempFile("Bananas are a fruit that grows on plants. ".repeat(30));
  const compressCalls = [];
  const out = await buildSnippets(
    [
      { id: fileA, path: fileA, score: 2 },
      { id: fileB, path: fileB, score: 1 },
    ],
    "what fruit grows on trees?",
    async (prompt) => {
      compressCalls.push(prompt);
      return "[1] condensed: apples grow on trees\n[2] condensed: bananas grow on plants";
    },
  );
  assert.equal(compressCalls.length, 1, "one batched call, not one per file");
  assert.match(compressCalls[0], /Research question: what fruit grows on trees\?/);
  assert.match(compressCalls[0], new RegExp(`\\[1\\] ${path.basename(fileA)}`));
  assert.match(compressCalls[0], new RegExp(`\\[2\\] ${path.basename(fileB)}`));
  assert.equal(out[0].snippet, "condensed: apples grow on trees");
  assert.equal(out[1].snippet, "condensed: bananas grow on plants");
});

test("buildSnippets keeps the flat-truncated snippet for a file the compress response didn't cover", async () => {
  const fileA = writeTempFile("content A");
  const fileB = writeTempFile("content B");
  const out = await buildSnippets(
    [
      { id: fileA, path: fileA, score: 1 },
      { id: fileB, path: fileB, score: 1 },
    ],
    "query",
    async () => "[1] condensed A only",
  );
  assert.equal(out[0].snippet, "condensed A only");
  assert.equal(out[1].snippet, "content B");
});

test("buildSnippets keeps flat-truncated snippets (never throws) when compress itself fails", async () => {
  const file = writeTempFile("original content");
  const out = await buildSnippets(
    [{ id: file, path: file, score: 1 }],
    "query",
    async () => {
      throw new Error("compressor unavailable");
    },
  );
  assert.equal(out[0].snippet, "original content");
});

test("buildSnippets skips the compress call entirely when every file failed to read", async () => {
  let called = false;
  const out = await buildSnippets(
    [{ id: "missing", path: "/no/such/file.md", score: 1 }],
    "query",
    async () => {
      called = true;
      return "[1] whatever";
    },
  );
  assert.equal(called, false, "no point compressing nothing");
  assert.equal(out[0].snippet, "");
});
