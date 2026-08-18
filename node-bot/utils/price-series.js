// Issue #358: forecasting wants a regular time series -- one value per
// period, evenly spaced, no gaps. Market sales are the opposite: irregular
// events at whatever moment somebody happened to buy something, several in
// an hour then nothing for two days.
//
// Turning one into the other is the actual work in this feature. The model
// is small and zero-shot; the data plumbing is where it can go wrong, and
// this is the part worth testing hard.

const DAY_MS = 24 * 60 * 60 * 1000;

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Median rather than mean per day: one absurdly overpriced listing should
// not drag a day's value, and market data has plenty of those.
function bucketByDay(sales, { now, days }) {
  const buckets = new Map();
  const cutoff = now - days * DAY_MS;
  for (const sale of sales || []) {
    const price = Number(sale?.pricePerUnit || 0);
    const at = Number(sale?.timestampMs || 0);
    if (!(price > 0) || !(at > 0) || at < cutoff || at > now) continue;
    // Day index counted back from now, so the last bucket is always "today"
    // regardless of when the series is generated.
    const index = Math.floor((now - at) / DAY_MS);
    if (!buckets.has(index)) buckets.set(index, []);
    buckets.get(index).push(price);
  }
  return buckets;
}

// A gap means "nobody sold one that day", which is not the same as "the
// price was zero" -- zero would teach a forecaster that the item became
// worthless. Carrying the previous value forward says the last known price
// still stands, which is what a missing sale actually implies.
//
// Leading gaps, before any sale exists, cannot be carried forward from
// anything and are dropped instead: a series should begin where the data
// does.
function toDailySeries(sales, { now = Date.now(), days = 30 } = {}) {
  const safeDays = Math.max(1, Number(days) || 30);
  const buckets = bucketByDay(sales, { now, days: safeDays });

  const points = [];
  let carried = null;
  // Oldest first, which is the order a forecaster expects.
  for (let index = safeDays - 1; index >= 0; index -= 1) {
    const dayPrices = buckets.get(index);
    const value = dayPrices ? medianOf(dayPrices) : carried;
    if (value === null || value === undefined) continue;
    carried = value;
    points.push({
      at: new Date(now - index * DAY_MS).toISOString().slice(0, 10),
      value,
      // Whether this day had a real sale or inherited the previous price.
      observed: Boolean(dayPrices),
    });
  }

  const observedCount = points.filter((p) => p.observed).length;
  return {
    points,
    observedCount,
    // A forecaster given three real observations and twenty-seven carried
    // ones will produce a confident flat line. Reporting the ratio lets the
    // caller decide whether the forecast is worth showing, rather than
    // discovering it looks certain and is not.
    coverage: points.length ? observedCount / points.length : 0,
  };
}

module.exports = { toDailySeries, medianOf };
