const assert = require("node:assert/strict");
const test = require("node:test");

const { createMarketForecaster } = require("../utils/market-forecast");

function fakeRun(response, { status = 0 } = {}) {
  return () => ({ status, stdout: typeof response === "string" ? response : JSON.stringify(response) });
}

test("returns the parsed forecast on success", () => {
  const f = createMarketForecaster({
    runScript: fakeRun({ ok: true, horizon: 3, forecast: [1, 2, 3], contextPoints: 20 }),
  });
  const result = f.forecast({ values: [1, 2, 3, 4], horizon: 3 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.forecast, [1, 2, 3]);
});

test("an empty series is refused without spawning anything", () => {
  let spawned = false;
  const f = createMarketForecaster({
    runScript: () => {
      spawned = true;
      return { status: 0, stdout: "{}" };
    },
  });
  const result = f.forecast({ values: [] });
  assert.equal(result.ok, false);
  assert.equal(spawned, false);
});

test("non-numeric values are dropped rather than sent", () => {
  let sent = null;
  const f = createMarketForecaster({
    runScript: (payload) => {
      sent = JSON.parse(payload);
      return { status: 0, stdout: JSON.stringify({ ok: true, forecast: [] }) };
    },
  });
  f.forecast({ values: [1, "two", null, 3, NaN] });
  assert.deepEqual(sent.values, [1, 3]);
});

test("the script reporting its own failure comes back readable", () => {
  // A missing model or an offline machine should arrive as a reason, not a
  // stack trace.
  const f = createMarketForecaster({
    runScript: fakeRun({ ok: false, reason: "not enough history to forecast", have: 4, need: 16 }),
  });
  const result = f.forecast({ values: [1, 2, 3, 4] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not enough history/);
});

test("a non-zero exit degrades rather than throws", () => {
  const f = createMarketForecaster({ runScript: fakeRun("", { status: 1 }) });
  const result = f.forecast({ values: [1, 2, 3] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exited 1/);
});

test("a spawn that throws degrades rather than propagates", () => {
  const f = createMarketForecaster({
    runScript: () => {
      throw new Error("python missing");
    },
  });
  // The price the user actually asked for is still correct; only the
  // forecast is missing.
  const result = f.forecast({ values: [1, 2, 3] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /python missing/);
});

test("unparseable output degrades rather than throws", () => {
  const f = createMarketForecaster({ runScript: fakeRun("not json at all") });
  assert.equal(f.forecast({ values: [1, 2, 3] }).ok, false);
});
