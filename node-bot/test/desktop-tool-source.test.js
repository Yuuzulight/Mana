// #911: desktop__* tools relay to the launcher, and only a spoken ask runs
// one while a game is running.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createDesktopToolSource, registerFileMoveRestorer } = require("../ai/desktop-tool-source");

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
  assert.deepEqual(names, [
    "desktop__media",
    "desktop__set_volume",
    "desktop__open_app",
    "desktop__focus_app",
    "desktop__list_audio_outputs",
    "desktop__set_audio_output",
    "desktop__list_folder",
    "desktop__move_files",
  ]);
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

test("a file move is recorded as a snapshot, and undoing it moves each item back, last first", async () => {
  const moved = [
    { from: "C:\Users\me\Downloads\a.png", to: "C:\Users\me\Pictures\a.png" },
    { from: "C:\Users\me\Downloads\b.png", to: "C:\Users\me\Pictures\b.png" },
  ];
  const bridge = fakeBridge({ answer: { moved, failed: [] } });
  const records = [];
  let restorer = null;
  const snapshotStore = {
    recordSnapshot: (record) => (records.push(record), { id: "snap-1" }),
    registerRestorer: (kind, fn) => (restorer = { kind, fn }),
  };
  const source = createDesktopToolSource({ bridge, snapshotStore });

  const out = JSON.parse(
    await source.executeTool("desktop__move_files", { from: ["a", "b"], to: "C:\Users\me\Pictures", exact: true }),
  );
  assert.equal(out.undoSnapshotId, "snap-1");
  // the model can't ask for undo's exact mode itself
  assert.deepEqual(bridge.sent[0].args, { from: ["a", "b"], to: "C:\Users\me\Pictures" });
  assert.deepEqual(records[0].payload, { moves: moved });
  assert.equal(records[0].kind, "file-move");

  registerFileMoveRestorer(snapshotStore, bridge);
  assert.equal(restorer.kind, "file-move");
  bridge.sent.length = 0;
  assert.deepEqual(await restorer.fn(records[0].key, records[0].payload), { undone: 2, failed: [] });
  assert.deepEqual(
    bridge.sent.map((s) => s.args),
    [
      { from: [moved[1].to], to: moved[1].from, exact: true },
      { from: [moved[0].to], to: moved[0].from, exact: true },
    ],
  );

  const gone = fakeBridge({ answer: new Error("C:\Users\me\Pictures\a.png doesn't exist") });
  registerFileMoveRestorer(snapshotStore, gone);
  await assert.rejects(() => restorer.fn(records[0].key, records[0].payload), /doesn't exist/);
});

test("a move can ask for a new destination folder, and only as true", async () => {
  const bridge = fakeBridge({ answer: { moved: [], failed: [] } });
  const source = createDesktopToolSource({ bridge });
  await source.executeTool("desktop__move_files", { to: "C:\Users\me\Pictures\Cats", new_folder: true, from: ["a"] });
  await source.executeTool("desktop__move_files", { to: "C:\Users\me\Pictures\Cats", new_folder: "yes", from: ["a"] });
  assert.deepEqual(
    bridge.sent.map((s) => s.args),
    [
      { to: "C:\Users\me\Pictures\Cats", from: ["a"], new_folder: true },
      { to: "C:\Users\me\Pictures\Cats", from: ["a"] },
    ],
  );
});
