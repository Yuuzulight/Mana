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
