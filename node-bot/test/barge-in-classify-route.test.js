const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");
const { withServer } = require("./helpers");

test("POST /barge-in/classify returns a category for valid text", async () => {
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/barge-in/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "wait, hold on" }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.category, "correction");
    assert.equal(typeof body.reason, "string");
    assert.equal(body.input_length, "wait, hold on".length);
  });
});

test("POST /barge-in/classify rejects a missing text field", async () => {
  const app = createApp();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/barge-in/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
  });
});
