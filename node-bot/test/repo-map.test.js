const assert = require("node:assert/strict");
const test = require("node:test");

const { extractSymbols, buildRepoMap } = require("../utils/repo-map");

test("extracts top-level functions and classes with their lines", () => {
  const src = [
    "function alpha(a) { return a; }",
    "",
    "class Beta {",
    "  gamma() {}",
    "}",
  ].join("\n");
  const symbols = extractSymbols(src);
  assert.deepEqual(symbols, [
    { kind: "function", name: "alpha", line: 1 },
    { kind: "class", name: "Beta", line: 3 },
    { kind: "method", name: "gamma", line: 4 },
  ]);
});

test("includes assigned function expressions, which read as declarations", () => {
  const symbols = extractSymbols("const doThing = (x) => x;\nconst other = function named() {};");
  assert.deepEqual(symbols.map((s) => s.name), ["doThing", "other"]);
});

test("does not find declarations inside strings or comments", () => {
  // The reason for tree-sitter over a regex: the map has to be trustworthy
  // enough to reason from.
  const symbols = extractSymbols('// function ghost() {}\nconst s = "function phantom() {}";');
  assert.deepEqual(symbols.map((s) => s.name), []);
});

test("ranks files by overlap with the request", () => {
  const files = [
    { relativePath: "src/unrelated.js", content: "function zzz() {}" },
    { relativePath: "src/payment-gateway.js", content: "function chargeCard() {}" },
  ];
  const map = buildRepoMap(files, { relevantTo: "fix the payment gateway charge" });
  // The relevant file should come first, not filesystem order.
  assert.ok(map.text.indexOf("payment-gateway.js") < map.text.indexOf("unrelated.js"));
});

test("an unranked map is deterministic rather than filesystem-ordered", () => {
  const files = [
    { relativePath: "b.js", content: "function b() {}" },
    { relativePath: "a.js", content: "function a() {}" },
  ];
  assert.ok(buildRepoMap(files).text.indexOf("a.js") < buildRepoMap(files).text.indexOf("b.js"));
});

test("omits whole files rather than half a symbol list", () => {
  const files = [];
  for (let i = 0; i < 40; i += 1) {
    files.push({ relativePath: `f${i}.js`, content: `function fn${i}() {}\nfunction gn${i}() {}` });
  }
  const map = buildRepoMap(files, { maxChars: 200 });
  assert.ok(map.omitted > 0);
  assert.ok(map.text.includes("more file(s) omitted"));
  // Half a file's symbol list reads as though the rest does not exist.
  for (const block of map.text.split("\n\n")) {
    if (!block.startsWith("f")) continue;
    const lines = block.split("\n");
    if (lines.length > 1) assert.equal(lines.length, 3, "a listed file must show all its symbols");
  }
});

test("a file that will not parse is skipped, not fatal", () => {
  const files = [
    { relativePath: "broken.js", content: "function ((( {" },
    { relativePath: "fine.js", content: "function ok() {}" },
  ];
  const map = buildRepoMap(files);
  // A partial map is useful; no map is not.
  assert.match(map.text, /fine\.js/);
});

test("files with no symbols are left out entirely", () => {
  const map = buildRepoMap([{ relativePath: "consts.js", content: "const x = 1;" }]);
  assert.equal(map.files, 0);
  assert.equal(map.text, "");
});

test("maps Mana's own source without throwing", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..", "utils");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({ relativePath: `utils/${f}`, content: fs.readFileSync(path.join(dir, f), "utf8") }));
  const map = buildRepoMap(files, { maxChars: 8000, relevantTo: "sentence chunking for speech" });
  assert.ok(map.files > 0);
  // Real source, real ranking: the chunker should outrank unrelated utils.
  assert.match(map.text.split("\n\n")[0], /sentence-chunker/);
});
