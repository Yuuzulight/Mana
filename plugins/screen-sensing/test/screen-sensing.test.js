const assert = require("node:assert/strict");
const test = require("node:test");

const { createAttentionGate, similarity } = require("../screen-sensing");

test("similarity returns 0 for unrelated text and something higher for overlapping text", () => {
  assert.equal(similarity("", "coding in a text editor"), 0);
  assert.equal(similarity("coding in a text editor", ""), 0);
  assert.ok(similarity("coding in a text editor", "watching a video player") < similarity(
    "coding in a text editor",
    "still coding in the text editor",
  ));
});

test("attention gate surfaces the first genuine glance", () => {
  const gate = createAttentionGate({ now: () => 1000 });
  const decision = gate.decide("The user is writing code in an editor.");
  assert.equal(decision.shouldSurface, true);
  assert.equal(decision.reason, "new");
});

test("attention gate skips when gaming mode is active, regardless of content", () => {
  const gate = createAttentionGate({ now: () => 1000 });
  const decision = gate.decide("The user is writing code in an editor.", { gamingModeActive: true });
  assert.equal(decision.shouldSurface, false);
  assert.equal(decision.reason, "gaming-mode-active");
});

test("attention gate skips a near-empty/failed summary", () => {
  const gate = createAttentionGate({ now: () => 1000 });
  const decision = gate.decide("...");
  assert.equal(decision.shouldSurface, false);
  assert.equal(decision.reason, "summary-too-short");
});

test("attention gate skips consecutive glances with no meaningful change", () => {
  const gate = createAttentionGate({ now: () => 1000 });
  const first = gate.decide("The user is writing code in a text editor.");
  assert.equal(first.shouldSurface, true);

  // Same activity, slightly reworded -- should read as "nothing changed".
  const second = gate.decide("The user is still writing code in a text editor.", );
  assert.equal(second.shouldSurface, false);
  assert.equal(second.reason, "no-meaningful-change");
});

test("attention gate enforces a cooldown between surfaced interruptions even after a genuine change", () => {
  let now = 1000;
  const gate = createAttentionGate({ now: () => now, cooldownMs: 60000 });

  const first = gate.decide("The user is writing code.");
  assert.equal(first.shouldSurface, true);

  now += 5000; // well inside the cooldown
  const second = gate.decide("The user is now watching a video, a completely different activity.");
  assert.equal(second.shouldSurface, false);
  assert.equal(second.reason, "cooldown");

  now += 60000; // cooldown elapsed
  const third = gate.decide("The user is now reading a long document about astronomy.");
  assert.equal(third.shouldSurface, true);
});

test("attention gate change-detection compares against the previous glance even when that glance didn't surface", () => {
  let now = 1000;
  const gate = createAttentionGate({ now: () => now, cooldownMs: 0 });

  gate.decide("The user is coding.", { gamingModeActive: true }); // skipped, but still updates lastGlanceSummary
  const next = gate.decide("The user is coding."); // identical to the skipped glance above
  assert.equal(next.shouldSurface, false);
  assert.equal(next.reason, "no-meaningful-change");
});
