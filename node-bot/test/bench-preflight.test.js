// #1467: the bench's preflight -- the harness and the cases, checked before
// any GPU time. Fakes for the sandbox, llama-server and the model.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const pre = require("../bench/preflight");
const { HARNESS_ERROR } = require("../bench/self-work-bench");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mana-preflight-"));

function repoWithModules() {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, "node-bot", "node_modules"), { recursive: true });
  return repo;
}

test("copy sources: missing, broken or not covering node_modules is a problem; covering it isn't", () => {
  const repo = repoWithModules();
  const modules = path.join(repo, "node-bot", "node_modules");
  assert.match(pre.copySourcesProblem(repo, { load: () => ({ dependencyRoots: [] }) }), /doesn't approve .*node_modules.*Copy would leave the approved source/);
  assert.match(
    pre.copySourcesProblem(repo, { load: () => { throw new Error("Invalid sandbox copy-source configuration"); } }),
    /is invalid \(Invalid sandbox copy-source configuration\)/,
  );
  assert.equal(pre.copySourcesProblem(repo, { load: () => ({ dependencyRoots: [modules] }) }), null);
  assert.equal(pre.copySourcesProblem(repo, { load: () => ({ dependencyRoots: [path.join(repo, "node-bot")] }) }), null, "a parent folder covers it");
  assert.equal(pre.copySourcesProblem(tmp(), { load: () => ({ dependencyRoots: [] }) }), null, "no node_modules, nothing to approve");
});

test("sandbox: a real test run through the link; a failed or thrown run is a problem, and the probe is cleaned up", async () => {
  const wt = tmp();
  const seen = [];
  const run = (exitCode) => async (command, cwd, opts) => {
    seen.push({ command, cwd, opts });
    return { exitCode, output: "tail of output" };
  };
  assert.equal(await pre.sandboxProblem(wt, { run: run(0), copySources: { dependencyRoots: [] } }), null);
  assert.equal(seen[0].command, "node --test test/bench-preflight.test.js");
  assert.equal(seen[0].cwd, path.join(wt, "node-bot"));
  assert.equal(seen[0].opts.workspaceRoot, wt);
  assert.match(await pre.sandboxProblem(wt, { run: run(1), copySources: { dependencyRoots: [] } }), /failed \(exit 1\): tail of output/);
  const thrown = async () => { throw new Error("Copy would leave the approved source: x"); };
  assert.match(await pre.sandboxProblem(wt, { run: thrown, copySources: { dependencyRoots: [] } }), /couldn't run: Copy would leave/);
  assert.equal(fs.existsSync(path.join(wt, "node-bot", "test", "bench-preflight.test.js")), false);
});

test("the sandbox helper: missing on Windows is a problem; there, or not Windows, isn't", () => {
  const dir = tmp();
  const helper = path.join(dir, "Mana.AnalysisSandbox.exe");
  assert.match(pre.helperProblem({ helper, platform: "win32" }), /helper .* is missing .*copy tools\/analysis-sandbox\/bundle/);
  assert.equal(pre.helperProblem({ helper, platform: "linux" }), null);
  fs.writeFileSync(helper, "");
  assert.equal(pre.helperProblem({ helper, platform: "win32" }), null);
});

test("server args: flags llama-server doesn't list are named; values and known flags pass", () => {
  const help = () => "-fa,   --flash-attn [on|off|auto]\n-fit,  --fit [on|off]\n-ctk,  --cache-type-k TYPE\n-lm,   --load-mode MODE\n";
  assert.equal(pre.serverArgsProblem("--fit,on,-fa,on,-ctk,q8_0,--load-mode,none", "llama-server.exe", { help }), null);
  assert.equal(pre.serverArgsProblem("", "llama-server.exe", { help }), null);
  assert.match(pre.serverArgsProblem("--fit,on,--fitt-target,768,-ncmoe,20", "llama-server.exe", { help }), /doesn't know --fitt-target, -ncmoe/);
});

test("cases: an unsound one is left out with why, and a verdict is cached until the case changes", async () => {
  const file = path.join(tmp(), "verified.json");
  const cases = [
    { id: "a", base: "1", hiddenTests: [] },
    { id: "b", base: "2", hiddenTests: [] },
    { id: "c", base: "3", hiddenTests: [] },
  ];
  const verdicts = { a: { ok: true, failsAtBase: true, passesWithFix: true }, b: { ok: false, failsAtBase: false, passesWithFix: true }, c: { ok: false, failsAtBase: true, passesWithFix: false } };
  let checks = 0;
  const verify = async (c) => (checks++, verdicts[c.id]);
  const log = () => {};
  const first = await pre.soundCases(cases, verify, { file, log });
  assert.deepEqual(first.sound.map((c) => c.id), ["a"]);
  assert.deepEqual(first.skipped, [
    { id: "b", why: "its hidden tests already pass at the base (a free pass)" },
    { id: "c", why: "its hidden tests don't pass with the fix" },
  ]);
  assert.equal(checks, 3);
  await pre.soundCases(cases, verify, { file, log });
  assert.equal(checks, 3, "cached");
  await pre.soundCases([{ ...cases[0], base: "9" }], verify, { file, log });
  assert.equal(checks, 4, "a changed case is checked again");
  const guarded = await pre.soundCases(cases, verify, { file, log, guarded: (c) => (c.id === "a" ? "its fix changes self-work.js" : null) });
  assert.deepEqual(guarded.skipped[0], { id: "a", why: "its fix changes self-work.js" });
  assert.equal(checks, 4, "a guarded case isn't even checked");
});

test("the model: a parsed tool call passes; none, or a failed loop, is a problem", async () => {
  const calls = async (prompt, policy) => {
    assert.equal(policy.tools[0].function.name, "bench_ping");
    await policy.executeTool("bench_ping", { n: 1 });
    return { content: "done" };
  };
  assert.equal(await pre.toolCallProblem(calls), null);
  assert.match(await pre.toolCallProblem(async () => ({ content: '<tool_call>{"name": "bench_ping"}</tool_call>' })), /didn't make a tool call/);
  assert.match(await pre.toolCallProblem(async () => { throw new Error("500"); }), /first tool call failed: 500/);
});

test("harness errors: the sandbox and test runner, not her own mistakes", () => {
  assert.ok(HARNESS_ERROR.test("Copy would leave the approved source: D:\\x\\node_modules"));
  assert.ok(HARNESS_ERROR.test("Native execution helper is unavailable; no unrestricted fallback"));
  assert.ok(!HARNESS_ERROR.test("ENOENT: no such file or directory, open 'data/facts.json'"));
  assert.ok(!HARNESS_ERROR.test("old_text isn't in node-bot/util.js"));
});

test("the sandbox check loads every package module she uses, sub-paths included", () => {
  const wt = tmp();
  fs.mkdirSync(path.join(wt, "node-bot", "ai"), { recursive: true });
  fs.writeFileSync(path.join(wt, "node-bot", "package.json"), JSON.stringify({ dependencies: { axios: "1", "@modelcontextprotocol/sdk": "1", uuid: "1" } }));
  fs.writeFileSync(path.join(wt, "node-bot", "ai", "a.js"), 'const x = require("axios");\nconst y = require("@modelcontextprotocol/sdk/server/mcp.js");\nconst z = require("node:fs");\nconst w = require("./local");\n');
  fs.writeFileSync(path.join(wt, "node-bot", "b.js"), 'require("@modelcontextprotocol/sdk/server/mcp.js");\n');
  assert.deepEqual(pre.usedSpecifiers(path.join(wt, "node-bot"), ["axios", "@modelcontextprotocol/sdk", "uuid"]), ["@modelcontextprotocol/sdk/server/mcp.js", "axios"]);
});

test("a package that doesn't load in the sandbox is named in the problem", async () => {
  const wt = tmp();
  fs.mkdirSync(path.join(wt, "node-bot"), { recursive: true });
  fs.writeFileSync(path.join(wt, "node-bot", "package.json"), JSON.stringify({ dependencies: { ws: "1" } }));
  fs.writeFileSync(path.join(wt, "node-bot", "c.js"), 'require("ws");\n');
  const run = async () => ({ exitCode: 1, output: "not ok 1 - ws\n  Cannot find module 'ws'\n" });
  assert.match(await pre.sandboxProblem(wt, { run, copySources: { dependencyRoots: [] } }), /these don't load: ws/);
});

test("the case cache changes when the harness changes", () => {
  const f = path.join(tmp(), "harness.js");
  fs.writeFileSync(f, "one");
  const before = pre.harnessFingerprint([f]);
  fs.writeFileSync(f, "two");
  assert.notEqual(pre.harnessFingerprint([f]), before);
});
