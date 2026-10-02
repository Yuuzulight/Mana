const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { useTestAdminToken, withServer, useTempDir } = require("./helpers");
useTempDir("MANA_PENDING_WRITES_DIR");
// #842: these routes are admin-only; every request here sends ADMIN_TOKEN.
const fetch = useTestAdminToken();

// /admin/pending-writes/:id/approve and /reject build a filesystem path
// from :id (path.join(PENDING_DIR, id)) -- without validation, an id like
// "../../whatever" would let a request write/delete files outside
// PENDING_DIR. See the CodeQL "uncontrolled data used in path expression"
// fix in server.js.
test("pending-writes approve/reject reject ids with path traversal characters", async () => {
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    for (const action of ["approve", "reject"]) {
      for (const badId of ["../../etc/passwd", "..%2f..%2fescape", "a/b", "a\\b"]) {
        const res = await fetch(
          `${baseUrl}/admin/pending-writes/${encodeURIComponent(badId)}/${action}`,
          { method: "POST" },
        );
        assert.equal(
          res.status,
          400,
          `expected 400 for ${action} with id ${JSON.stringify(badId)}, got ${res.status}`,
        );
      }
    }
  });
});

test("pending-writes approve accepts a well-formed id", async () => {
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/admin/pending-writes/abc-123_XYZ/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // No file exists for this id, but it must get past validation (200) and
    // never a 400 -- proves the safe-id regex isn't over-rejecting.
    assert.equal(res.status, 200);
  });
});

// #838: the waiting loop polls for the marker file and archives the request
// itself; the routes used to archive (and delete the marker) at once, so
// the loop never saw an approval and every one timed out.
test("pending-writes approve/reject leave the marker for the waiting loop to read", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-pending-marker-"));
  const saved = process.env.MANA_PENDING_WRITES_DIR;
  process.env.MANA_PENDING_WRITES_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, "w1.json"), JSON.stringify({ id: "w1", path: "a.txt" }));
    fs.writeFileSync(path.join(dir, "w2.json"), JSON.stringify({ id: "w2", path: "b.txt" }));
    const app = createApp();

    await withServer(app, async (baseUrl) => {
      const post = (url) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal((await post(`${baseUrl}/admin/pending-writes/w1/approve`)).status, 200);
      assert.equal((await post(`${baseUrl}/admin/pending-writes/w2/reject`)).status, 200);

      const listed = await (await fetch(`${baseUrl}/admin/pending-writes`)).json();
      const byId = Object.fromEntries(listed.pending.map((p) => [p.id, p]));
      assert.equal(byId.w1.approved, true);
      assert.equal(byId.w2.rejected, true);
    });
    assert.ok(fs.existsSync(path.join(dir, "w1.approved.json")));
    assert.ok(fs.existsSync(path.join(dir, "w2.rejected.json")));
  } finally {
    if (saved === undefined) delete process.env.MANA_PENDING_WRITES_DIR;
    else process.env.MANA_PENDING_WRITES_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
