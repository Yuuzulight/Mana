const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const express = require("express");
const { withServer } = require("./helpers");
const {
  createZipBuffer,
  privacyDataCapability,
} = require("../capabilities/privacy-data-capability");

function createTestContext() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-privacy-test-"));
  const sessionsDir = path.join(tempDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const turnsDir = path.join(tempDir, "voice", "turns");
  fs.mkdirSync(turnsDir, { recursive: true });

  // Sample session
  const testSession = {
    sessionId: "test-sess-1",
    name: "Test Chat",
    turns: [
      { user: "hello", assistant: "hi there", artifact: { language: "json", content: '{"sample":1}' } },
    ],
  };
  fs.writeFileSync(
    path.join(sessionsDir, "test-sess-1.json"),
    JSON.stringify(testSession, null, 2),
    "utf8",
  );

  // Sample memory
  fs.writeFileSync(
    path.join(tempDir, "facts.json"),
    JSON.stringify({ facts: [{ key: "user-name", text: "Yuuzu", status: "active" }] }),
    "utf8",
  );
  fs.writeFileSync(path.join(tempDir, "vault-sync.json"), JSON.stringify({ "note.md": "abc" }), "utf8");

  // Sample voice data
  fs.writeFileSync(path.join(turnsDir, "turn1.json"), JSON.stringify({ transcript: "hello" }), "utf8");
  fs.writeFileSync(path.join(turnsDir, "turn1.wav"), Buffer.from("RIFFfakeWAVEfmt "));

  // Sample audit log
  const logDir = path.join(tempDir, "tool-call-log");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "tool-calls.jsonl"), '{"tool":"test"}\n', "utf8");

  const acpMemoryStore = {
    dataDir: tempDir,
    sessionsDir,
    listSessions: () => [testSession],
    getSession: (id) => (id === "test-sess-1" ? testSession : null),
    deleteSession: (id) => {
      const p = path.join(sessionsDir, `${id}.json`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },
  };

  const pluginSettingsStore = {
    getSettings: () => ({ pluginA: true, apiKey: "secret-12345" }),
  };

  const modelSettingsStore = {
    getSettings: () => ({ model: "qwen", adminToken: "tok-abc-def" }),
  };

  return {
    tempDir,
    context: {
      acpMemoryStore,
      voiceDataDir: path.join(tempDir, "voice"),
      pluginSettingsStore,
      modelSettingsStore,
      checkAdminAuth: () => true,
    },
    cleanup: () => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

test("createZipBuffer builds valid PKZIP headers and data", () => {
  const entries = [
    { name: "README.md", data: "# Mana Export" },
    { name: "nested/file.json", data: '{"ok":true}' },
  ];
  const zip = createZipBuffer(entries);
  assert.ok(Buffer.isBuffer(zip));
  assert.ok(zip.length > 50);

  // PKZIP local header signature: PK\x03\x04
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  // PKZIP end of central directory signature: PK\x05\x06 at the end
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});

test("GET /privacy/export-all exports zip with readme, chats, memory, voice, and redacted settings", async () => {
  const { context, cleanup } = createTestContext();
  try {
    const app = express();
    privacyDataCapability.registerRoutes(app, context);

    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/privacy/export-all`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/zip");
      assert.match(res.headers.get("content-disposition"), /attachment; filename="mana-export-/);

      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.length > 100);
      assert.equal(buf.readUInt32LE(0), 0x04034b50);
      // Verify expected filenames are present in the zip central directory
      const text = buf.toString("latin1");
      assert.ok(text.includes("README.md"));
      assert.ok(text.includes("chats/test-sess-1.json"));
      assert.ok(text.includes("chats/test-sess-1.md"));
      assert.ok(text.includes("memory/facts.json"));
      assert.ok(text.includes("voice/turn1.json"));
      assert.ok(text.includes("settings/plugin-settings.json"));
      assert.ok(text.includes("settings/model-settings.json"));

      // Secrets should be redacted
      assert.ok(!text.includes("secret-12345"), "apiKey secret must not appear in export");
      assert.ok(!text.includes("tok-abc-def"), "adminToken secret must not appear in export");

      // Verify direct export entries have redacted secrets
      const { gatherExportEntries } = require("../capabilities/privacy-data-capability");
      const entries = gatherExportEntries(context);
      const pluginEntry = entries.find((e) => e.name === "settings/plugin-settings.json");
      assert.ok(pluginEntry);
      const pluginJson = JSON.parse(pluginEntry.data);
      assert.equal(pluginJson.apiKey, "[redacted]");

      const modelEntry = entries.find((e) => e.name === "settings/model-settings.json");
      assert.ok(modelEntry);
      const modelJson = JSON.parse(modelEntry.data);
      assert.equal(modelJson.adminToken, "[redacted]");
    });
  } finally {
    cleanup();
  }
});

test("POST /privacy/delete-all requires typed confirmation 'delete-everything'", async () => {
  const { context, tempDir, cleanup } = createTestContext();
  try {
    const app = express();
    app.use(express.json());
    privacyDataCapability.registerRoutes(app, context);

    await withServer(app, async (baseUrl) => {
      // Missing confirmation
      const res1 = await fetch(`${baseUrl}/privacy/delete-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res1.status, 400);

      // Wrong confirmation
      const res2 = await fetch(`${baseUrl}/privacy/delete-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "yes" }),
      });
      assert.equal(res2.status, 400);

      // Correct confirmation
      const res3 = await fetch(`${baseUrl}/privacy/delete-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "delete-everything" }),
      });
      assert.equal(res3.status, 200);
      const json = await res3.json();
      assert.equal(json.ok, true);
      assert.deepEqual(json.deleted, ["chats", "memory", "vault", "voice", "cache-logs"]);

      // Verify files were actually wiped
      assert.equal(fs.existsSync(path.join(tempDir, "sessions", "test-sess-1.json")), false);
      assert.equal(fs.existsSync(path.join(context.voiceDataDir, "turns", "turn1.json")), false);
      assert.equal(fs.existsSync(path.join(tempDir, "vault-sync.json")), false);
      assert.equal(fs.existsSync(path.join(tempDir, "tool-call-log")), false);
      // Facts.json should be reset to empty
      const facts = JSON.parse(fs.readFileSync(path.join(tempDir, "facts.json"), "utf8"));
      assert.deepEqual(facts.facts, []);
    });
  } finally {
    cleanup();
  }
});

test("POST /privacy/delete/:category wipes only the requested category", async () => {
  const { context, tempDir, cleanup } = createTestContext();
  try {
    const app = express();
    app.use(express.json());
    privacyDataCapability.registerRoutes(app, context);

    await withServer(app, async (baseUrl) => {
      // Delete voice category only
      const res = await fetch(`${baseUrl}/privacy/delete/voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "delete-voice" }),
      });
      assert.equal(res.status, 200);

      // Voice files gone
      assert.equal(fs.existsSync(path.join(context.voiceDataDir, "turns", "turn1.json")), false);
      // Other categories intact
      assert.equal(fs.existsSync(path.join(tempDir, "sessions", "test-sess-1.json")), true);
      assert.equal(fs.existsSync(path.join(tempDir, "vault-sync.json")), true);
    });
  } finally {
    cleanup();
  }
});
