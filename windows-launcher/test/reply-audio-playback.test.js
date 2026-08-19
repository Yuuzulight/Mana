const assert = require("node:assert/strict");
const test = require("node:test");

const { waitForPlayback } = require("../renderer/reply-audio-playback");

// Minimal stand-in for the slice of HTMLMediaElement behavior this module
// depends on (per the WHATWG spec: pause() fires 'pause' unless already
// paused; reaching natural end fires 'ended' but not 'pause').
class FakeAudio {
  constructor() {
    this._listeners = {};
    this.paused = true;
  }
  addEventListener(type, fn, opts) {
    (this._listeners[type] ||= []).push({ fn, once: !!(opts && opts.once) });
  }
  _emit(type) {
    const list = this._listeners[type] || [];
    this._listeners[type] = list.filter((l) => !l.once);
    for (const l of list) l.fn();
  }
  play() {
    this.paused = false;
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this._emit("pause");
  }
  reachNaturalEnd() {
    this.paused = true;
    this._emit("ended");
  }
  raiseError() {
    this._emit("error");
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}

test("waitForPlayback resolves on 'ended'", async () => {
  const audio = new FakeAudio();
  audio.play();
  const p = waitForPlayback(audio);
  audio.reachNaturalEnd();
  await assert.doesNotReject(p);
});

test("waitForPlayback rejects on 'error'", async () => {
  const audio = new FakeAudio();
  audio.play();
  const p = waitForPlayback(audio);
  audio.raiseError();
  await assert.rejects(p, /Reply audio playback failed/);
});

// This is the actual bug: stopReplyAudio() interrupts playback with
// .pause(), which fires neither 'ended' nor 'error'. Before the fix, the
// promise this guards (and the `processing` gate awaiting it in renderer.js)
// hung forever whenever a reply was interrupted mid-playback.
test("waitForPlayback resolves on 'pause' instead of hanging when playback is interrupted", async () => {
  const audio = new FakeAudio();
  audio.play();
  const p = waitForPlayback(audio);
  audio.pause();
  await withTimeout(assert.doesNotReject(p), 200);
});

test("waitForPlayback settles exactly once when 'pause' races 'ended' at natural end", async () => {
  const audio = new FakeAudio();
  audio.play();
  let settleCount = 0;
  const p = waitForPlayback(audio, () => {
    settleCount += 1;
  }).then((v) => {
    settleCount += 1000; // resolve path marker, distinct from onSettle count
    return v;
  });
  // Some engines fire 'pause' immediately before 'ended' at natural end.
  audio._emit("pause");
  audio._emit("ended");
  await p;
  assert.equal(settleCount, 1001);
});

test("waitForPlayback runs onSettle exactly once even if error follows pause", async () => {
  const audio = new FakeAudio();
  audio.play();
  let onSettleCalls = 0;
  const p = waitForPlayback(audio, () => {
    onSettleCalls += 1;
  });
  audio.pause();
  audio._emit("error");
  await assert.doesNotReject(p);
  assert.equal(onSettleCalls, 1);
});
