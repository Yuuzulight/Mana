// #1231: the task generator's parts -- operators, validator (with a fake
// test runner), issue writer and held-out split. No real tests are run.
const assert = require("node:assert/strict");
const test = require("node:test");

const { tokenize, OPERATORS, edits, mutant } = require("../bench/gen/mutate");
const { judge, validateMutant, writeIssue, purpose, split, difficulty } = require("../bench/gen/generate-tasks");

const SAMPLE = `// Loads things.
async function load(opts = {}, limit = 5000) {
  if (!opts.path) return null;
  if (opts.size > 3 && opts.ready) {
    throw new RangeError("too big");
  }
  if (opts.name === "x") throw new Error("bad name");
  const data = await read(opts.path, limit);
  const re = /a\\/b/g;
  const half = data.length / 2;
  const t = \`\${opts.size - 1} of \${\`\${limit}\`}\`;
  return { data: data.slice(0, opts.size - 1), ok: true, re, half, t };
}
async function read(p, n) {
  return String(p).repeat(n);
}
module.exports = { load };
`;

test("the tokenizer tells a regex from a division and keeps templates whole", () => {
  const toks = tokenize(SAMPLE);
  assert.deepEqual(toks.filter((k) => k.t === "regex").map((k) => k.v), ["/a\\/b/g"]);
  assert.ok(toks.some((k) => k.t === "punc" && k.v === "/"));
  assert.deepEqual(toks.filter((k) => k.t === "tmpl").map((k) => k.v), ["`${opts.size - 1} of ${`${limit}`}`"]);
  assert.ok(!toks.some((k) => k.v === "Loads"));
});

test("every operator makes valid, different programs here, none inside a template", () => {
  const tmpl = tokenize(SAMPLE).find((k) => k.t === "tmpl");
  for (const op of Object.keys(OPERATORS)) {
    const found = edits(SAMPLE, [op]);
    assert.ok(found.length, `${op} found nothing`);
    const outs = found.map((e) => mutant(SAMPLE, e));
    for (const [i, out] of outs.entries()) {
      assert.ok(out, `${op}: ${found[i].note} doesn't compile`);
      assert.notEqual(out, SAMPLE);
      assert.ok(found[i].end <= tmpl.s || found[i].start >= tmpl.e, `${op} edited inside the template`);
    }
    assert.equal(new Set(outs).size, outs.length, `${op} made the same program twice`);
  }
});

test("each operator makes the bug it names", () => {
  const all = (op) => edits(SAMPLE, [op]).map((e) => mutant(SAMPLE, e));
  const has = (op, text) => assert.ok(all(op).some((s) => s.includes(text)), `${op} never made ${text}`);
  has("comparison", "opts.size >= 3");
  has("off-by-one", "opts.size > 4");
  has("off-by-one", "data.slice(0, opts.size)");
  has("negate-condition", "if (!(opts.name === \"x\"))");
  has("negate-condition", "opts.name !== \"x\"");
  has("negate-condition", "if (opts.path) return null;");
  has("drop-condition", "if (opts.size > 3) {");
  has("wrong-default", "limit = 500)");
  has("wrong-default", "ok: false");
  has("swap-args", "read(limit, opts.path)");
  has("remove-await", "const data = read(");
  has("wrong-key", "if (!opts.size) return null;");
  assert.ok(all("drop-early-return").some((s) => !s.includes("return null") && s.includes("async function load(opts = {}, limit = 5000) {\n  if (opts.size")));
  has("wrong-error", "throw new Error(\"too big\")");
  has("wrong-error", "throw new Error(\"too big\");\n  const data");
  // Never a call's name, a declaration's parameters or an argument that's a callback.
  assert.ok(all("wrong-key").every((s) => s.includes("data.slice(0") && s.includes("data.length")));
  assert.ok(!all("swap-args").some((s) => s.includes("read(n, p)")));
  assert.deepEqual(edits("arr.forEach((x) => f(x), this);\n", ["swap-args"]), []);
});

test("a source that doesn't compile after an edit is no mutant", () => {
  assert.equal(mutant("const a = 1;\n", { start: 6, end: 7, text: "(" }), null);
  assert.equal(mutant("const a = 1;\n", { start: 10, end: 11, text: "1" }), null);
});

const pass = (name) => ({ name, parents: [], passed: true });
const fail = (name, extra) => ({ name, parents: ["suite"], passed: false, failureType: "testCodeFailure", ...extra });
const assertion = (name, message) => fail(name, { code: "ERR_ASSERTION", error: "AssertionError", message });

test("judge: only assertion failures kill; a crash, a timeout or a bad exit don't", () => {
  const killed = judge({ code: 1, results: [pass("a"), assertion("b", "1 !== 2"), { ...fail("suite"), parents: [], failureType: "subtestsFailed" }] });
  assert.deepEqual(killed, { verdict: "killed", failing: [{ name: "suite > b", test: "b", parents: ["suite"], message: "1 !== 2" }] });
  assert.equal(judge({ code: 0, results: [pass("a")] }).verdict, "survived");
  assert.equal(judge({ code: 1, results: [pass("a")] }).verdict, "crash");
  assert.equal(judge({ code: 1, results: [assertion("b", "x"), fail("c", { error: "TypeError", message: "x is not a function" })] }).verdict, "crash");
  assert.equal(judge({ code: 1, results: [fail("c", { failureType: "testTimeoutFailure" })] }).verdict, "timeout");
  assert.equal(judge({ code: null, timedOut: true, results: [] }).verdict, "timeout");
});

test("validateMutant runs the covering tests fastest first and stops at the first that fails", async () => {
  const ran = [];
  const runs = {
    "test/slow.test.js": { code: 1, ms: 900, results: [assertion("slow one", "boom")] },
    "test/fast.test.js": { code: 0, ms: 10, results: [pass("fast one")] },
    "test/mid.test.js": { code: 1, ms: 50, results: [assertion("mid one", "expected 3")] },
  };
  const tests = [{ file: "test/slow.test.js", ms: 800 }, { file: "test/fast.test.js", ms: 5 }, { file: "test/mid.test.js", ms: 40 }];
  const r = await validateMutant(tests, async (t) => (ran.push(t.file), runs[t.file]));

  assert.deepEqual(ran, ["test/fast.test.js", "test/mid.test.js"]);
  assert.equal(r.verdict, "killed");
  assert.equal(r.test, "test/mid.test.js");
  assert.equal(r.ms, 50);
  assert.equal(r.failing[0].message, "expected 3");

  const survived = await validateMutant([{ file: "test/fast.test.js", ms: 5 }], async (t) => runs[t.file]);
  assert.deepEqual(survived, { verdict: "survived" });
});

test("the issue reads like a bug report: test name, what came back, the area; no file or line", () => {
  const failing = [
    { name: "voice > picks fast at 8 GB", test: "picks fast at 8 GB", parents: ["voice"], message: "Expected values to be strictly equal:\n\n'default' !== 'fast'\n\nat D:\\Mana-worktrees\\taskgen-1\\node-bot\\x.js" },
    { name: "voice > b", test: "b", parents: ["voice"], message: "x" },
  ];
  const { title, body } = writeIssue({
    id: "gen-wrong-key-model-management-abc",
    failing,
    area: purpose("// #1086 (part of #625): model-management.js picks a model profile from VRAM. More text.\nconst a = 1;\n"),
    scrubPaths: ["D:\\Mana-worktrees\\taskgen-1"],
  });
  assert.match(title, /picks fast at 8 GB/);
  assert.match(body, /^Area: Picks a model profile from VRAM\.\n/);
  assert.match(body, /voice: picks fast at 8 GB\./);
  assert.match(body, /'default' !== 'fast'/);
  assert.match(body, /The same thing shows up in:\n- voice > b/);
  assert.match(body, /at <dir>\\node-bot\\x\.js/);
  assert.doesNotMatch(body, /model-management|#1086|#625|Mana-worktrees|line \d/);
  // Deterministic.
  assert.deepEqual(writeIssue({ id: "gen-x", failing }), writeIssue({ id: "gen-x", failing }));
  assert.equal(purpose("const a = 1;\n"), "");
  assert.equal(purpose("// Issue #700 (Q12b): Mana's mood, a slow state (server.js) that drifts.\nconst a = 1;\n"), "Mana's mood, a slow state that drifts.");
});

test("held-out split is by source file alone, about 10%", () => {
  assert.equal(split("node-bot/a.js"), split("node-bot/a.js"));
  const files = Array.from({ length: 2000 }, (_, i) => `node-bot/file-${i}.js`);
  const held = files.filter((f) => split(f) === "heldout").length;
  assert.ok(held > 140 && held < 260, `${held} of 2000 held out`);
});

test("difficulty: a big file, one failing test and a quiet operator make it harder", () => {
  assert.equal(difficulty({ op: "comparison", lines: 100, failing: 3 }), "easy");
  assert.equal(difficulty({ op: "comparison", lines: 500, failing: 1 }), "medium");
  assert.equal(difficulty({ op: "remove-await", lines: 2000, failing: 1 }), "hard");
});
