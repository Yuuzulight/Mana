const assert = require("node:assert/strict");
const test = require("node:test");

const { runToolScript } = require("../tools/script-runner");

test("runToolScript returns the script's final value", async () => {
  const { result } = await runToolScript("return 1 + 2;");
  assert.equal(result, 3);
});

test("runToolScript lets the script call an injected tool and use its result", async () => {
  const { result } = await runToolScript(
    "const a = await tools.double(3); const b = await tools.double(a); return b;",
    { tools: { double: (n) => n * 2 } },
  );
  assert.equal(result, 12);
});

test("runToolScript chains multiple different tool calls in one script", async () => {
  const calls = [];
  const { result } = await runToolScript(
    `
      const first = await tools.search("cats");
      const second = await tools.search("dogs");
      return [first, second];
    `,
    {
      tools: {
        search: async (query) => {
          calls.push(query);
          return `result:${query}`;
        },
      },
    },
  );
  assert.deepEqual(result, ["result:cats", "result:dogs"]);
  assert.deepEqual(calls, ["cats", "dogs"]);
});

test("runToolScript surfaces a tool's rejection as a script error", async () => {
  await assert.rejects(
    () =>
      runToolScript("await tools.fail();", {
        tools: {
          fail: async () => {
            throw new Error("boom");
          },
        },
      }),
    /boom/,
  );
});

test("runToolScript rejects a call to a tool name that wasn't provided", async () => {
  // Not in `tools`, so the sandbox's `tools` proxy never gets an entry for
  // it -- the script fails immediately inside the vm, the same as calling
  // any other undefined function, before an IPC round-trip is even
  // attempted. The parent's "unknown tool" guard in script-runner.js is a
  // defensive check for a mismatch that can't happen through this path.
  await assert.rejects(
    () => runToolScript("return await tools.notReal();", { tools: {} }),
    /tools\.notReal is not a function/,
  );
});

test("runToolScript has no require/process/fs access in the sandbox", async () => {
  await assert.rejects(
    () => runToolScript("return require('node:fs');"),
    /require is not defined/,
  );
});

// Regression coverage for a real vm sandbox escape: any injected object or
// function crossing into the sandbox keeps its outer `.constructor` chain
// by default, so `injectedValue.constructor.constructor("return process")()`
// reaches the parent process's real Function constructor -- full
// fs/network/process access, no different from running the string directly
// in node-bot. Verified against the real forked worker, not a mock, since
// that's exactly the class of gap a mocked test would never catch.
test("runToolScript blocks the .constructor escape via an injected tool function", async () => {
  await assert.rejects(
    () =>
      runToolScript("return tools.echo.constructor('return process')().pid;", {
        tools: { echo: (x) => x },
      }),
    /constructor is not a function/,
  );
});

test("runToolScript blocks the .constructor escape via the global object itself", async () => {
  await assert.rejects(
    () => runToolScript("return this.constructor.constructor('return process')();"),
    /process is not defined/,
  );
});

test("runToolScript blocks the .constructor escape via setTimeout/console", async () => {
  await assert.rejects(
    () => runToolScript("return setTimeout.constructor('return process')();"),
    /constructor is not a function/,
  );
  await assert.rejects(
    () => runToolScript("return console.log.constructor('return process')();"),
    /constructor is not a function/,
  );
});

test("runToolScript surfaces a thrown error from the script itself", async () => {
  await assert.rejects(
    () => runToolScript("throw new Error('script blew up');"),
    /script blew up/,
  );
});

test("runToolScript enforces its wall-clock timeout", async () => {
  await assert.rejects(
    () =>
      runToolScript("await new Promise((r) => setTimeout(r, 5000)); return 1;", {
        timeoutMs: 200,
      }),
    /timed out/,
  );
});

test("runToolScript captures console.log calls from the script as logs", async () => {
  const { result, logs } = await runToolScript(
    "console.log('hello', 1); return 'done';",
  );
  assert.equal(result, "done");
  assert.deepEqual(logs, ["hello 1"]);
});

test("runToolScript exposes options.inputs as a plain sandbox.inputs object", async () => {
  const { result } = await runToolScript("return inputs.name;", { inputs: { name: "Mana" } });
  assert.equal(result, "Mana");
});

test("runToolScript defaults inputs to an empty object when omitted", async () => {
  const { result } = await runToolScript("return typeof inputs;");
  assert.equal(result, "object");
});

// inputs are plain data, not capabilities like tools -- an object value
// passed as an input shouldn't keep its outer-realm .constructor chain
// crossing into the sandbox, same as everything else seal() strips.
test("runToolScript blocks the .constructor escape via an injected inputs value", async () => {
  await assert.rejects(
    () =>
      runToolScript("return inputs.value.constructor.constructor('return process')().pid;", {
        inputs: { value: {} },
      }),
    /Cannot read propert/,
  );
});

test("runToolScript caps total buffered log output instead of growing unbounded", async () => {
  const { logs } = await runToolScript(
    `for (let i = 0; i < 5000; i++) { console.log("x".repeat(50)); } return "done";`,
  );
  const totalChars = logs.reduce((sum, line) => sum + line.length, 0);
  // 5000 lines * 50 chars = 250000 chars if uncapped; the cap should have
  // stopped well short of that.
  assert.ok(totalChars < 25000, `expected capped log output, got ${totalChars} chars`);
});
