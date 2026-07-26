const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");

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
