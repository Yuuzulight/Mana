const assert = require("node:assert/strict");
const test = require("node:test");

const { toDailySeries, medianOf } = require("../utils/price-series");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-17T12:00:00.000Z");

function sale(daysAgo, pricePerUnit) {
  return { pricePerUnit, timestampMs: NOW - daysAgo * DAY };
}

test("produces one point per day, oldest first", () => {
  const { points } = toDailySeries([sale(2, 100), sale(1, 110), sale(0, 120)], {
    now: NOW,
    days: 3,
  });
  assert.deepEqual(points.map((p) => p.value), [100, 110, 120]);
});

test("uses the median within a day, not the mean", () => {
  // One absurd listing should not drag the day, and market data is full of them.
  const { points } = toDailySeries([sale(0, 100), sale(0, 110), sale(0, 99999)], {
    now: NOW,
    days: 1,
  });
  assert.equal(points[0].value, 110);
});

test("carries the last known price across a day with no sales", () => {
  const { points } = toDailySeries([sale(3, 500), sale(0, 520)], { now: NOW, days: 4 });
  // A gap means nobody sold one, not that the price was zero -- zero would
  // teach a forecaster the item became worthless.
  assert.deepEqual(points.map((p) => p.value), [500, 500, 500, 520]);
  assert.deepEqual(points.map((p) => p.observed), [true, false, false, true]);
});

test("drops leading gaps rather than inventing a price", () => {
  const { points } = toDailySeries([sale(1, 300)], { now: NOW, days: 5 });
  // A series should begin where the data does.
  assert.equal(points.length, 2);
  assert.equal(points[0].value, 300);
});

test("reports how much of the series was actually observed", () => {
  const { coverage, observedCount, points } = toDailySeries([sale(4, 10), sale(0, 12)], {
    now: NOW,
    days: 5,
  });
  assert.equal(observedCount, 2);
  assert.equal(points.length, 5);
  // A forecaster given two real points and three carried ones produces a
  // confident flat line; the caller needs to know that before showing it.
  assert.ok(coverage > 0.39 && coverage < 0.41);
});

test("ignores sales outside the window, in the future, or priced at zero", () => {
  const { points, observedCount } = toDailySeries(
    [sale(99, 5), sale(-1, 7), { pricePerUnit: 0, timestampMs: NOW }, sale(0, 42)],
    { now: NOW, days: 3 },
  );
  assert.equal(observedCount, 1);
  assert.equal(points[points.length - 1].value, 42);
});

test("no usable sales yields an empty series rather than a fabricated one", () => {
  const result = toDailySeries([], { now: NOW, days: 7 });
  assert.deepEqual(result.points, []);
  assert.equal(result.coverage, 0);
});

test("medianOf averages the middle pair on an even count", () => {
  assert.equal(medianOf([10, 20, 30, 40]), 25);
  assert.equal(medianOf([]), null);
});
