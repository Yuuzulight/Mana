const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createAcpTestRunner,
  isDisallowedCommand,
  parseCommandLine,
} = require("../acp-test-runner");

test("parseCommandLine parses quoted arguments without shell execution", () => {
  assert.deepEqual(parseCommandLine('node --check "server file.js"'), {
    command: "node",
    args: ["--check", "server file.js"],
  });
});

test("test runner rejects destructive and unapproved commands", async () => {
  assert.equal(isDisallowedCommand("git reset --hard"), true);
  assert.equal(isDisallowedCommand("Remove-Item -Recurse ."), true);
  const runner = createAcpTestRunner({ spawnImpl: () => { throw new Error("not called"); } });

  await assert.rejects(() => runner.run("git reset --hard", { cwd: "C:\\ManaAI\\Mana" }), /not allowed/i);
  await assert.rejects(() => runner.run("npm install", { cwd: "C:\\ManaAI\\Mana" }), /not allowed/i);
});

test("test runner executes allowed commands with no shell", async () => {
  const calls = [];
  const runner = createAcpTestRunner({
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        stdout: { on: (event, handler) => event === "data" && handler(Buffer.from("ok")) },
        stderr: { on: () => {} },
        on: (event, handler) => event === "close" && handler(0),
        kill: () => {},
      };
    },
  });

  const result = await runner.run("node --test", { cwd: "C:\\ManaAI\\Mana" });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(calls[0].command, "node");
  assert.deepEqual(calls[0].args, ["--test"]);
  assert.equal(calls[0].options.shell, false);
});
