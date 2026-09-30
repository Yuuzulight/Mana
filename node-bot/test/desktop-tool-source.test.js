// #911: desktop__* tools relay to the launcher, and only a spoken ask runs
// one while a game is running.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createDesktopToolSource } = require("../ai/desktop-tool-source");

function fakeBridge({ desktop = true, answer = { level: 40 } } = {}) {
  const sent = [];
  return {
    sent,
    hasDesktop: () => desktop,
    requestDesktop: async (action, args) => {
      sent.push({ action, args });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test("offered only while a launcher that does desktop actions is connected", () => {
  assert.equal(createDesktopToolSource({ bridge: fakeBridge({ desktop: false }) }).listToolSchemas().length, 0);
  const names = createDesktopToolSource({ bridge: fakeBridge() }).listToolSchemas().map((t) => t.function.name);
  assert.deepEqual(names, ["desktop__media", "desktop__set_volume", "desktop__open_app", "desktop__focus_app"]);
});

test("relays the call and returns the launcher's result or error", async () => {
  const bridge = fakeBridge();
  const source = createDesktopToolSource({ bridge });
  assert.deepEqual(JSON.parse(await source.executeTool("desktop__set_volume", { change: -10 })), { status: "ok", level: 40 });
  assert.deepEqual(bridge.sent, [{ action: "set_volume", args: { change: -10 } }]);

  const failing = createDesktopToolSource({ bridge: fakeBridge({ answer: new Error("Spotify isn't playing any sound right now") }) });
  assert.deepEqual(JSON.parse(await failing.executeTool("desktop__set_volume", { app: "Spotify", level: 10 })), {
    status: "error",
    error: "Spotify isn't playing any sound right now",
  });
  await assert.rejects(() => source.executeTool("desktop__format_disk", {}), /unknown desktop tool/);
});

test("while a game is running, nothing runs unless the turn was spoken", async () => {
  const bridge = fakeBridge();
  const typed = createDesktopToolSource({ bridge, isGaming: () => true });
  assert.equal(JSON.parse(await typed.executeTool("desktop__media", { key: "play_pause" })).status, "error");
  assert.equal(bridge.sent.length, 0);

  const spoken = createDesktopToolSource({ bridge, isGaming: () => true, voice: true });
  assert.equal(JSON.parse(await spoken.executeTool("desktop__media", { key: "play_pause" })).status, "ok");
  assert.equal(bridge.sent.length, 1);
});
