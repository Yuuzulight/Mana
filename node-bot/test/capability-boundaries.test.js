const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("general server routes do not own FFXIV public route paths", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "server-routes.js"),
    "utf8",
  );

  assert.equal(source.includes('"/ffxiv/market"'), false);
  assert.equal(source.includes('"/ffxiv/crafting/profit"'), false);
  assert.equal(source.includes('"/ffxiv/market/from-screen"'), false);
});
