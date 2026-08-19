const assert = require("node:assert/strict");
const test = require("node:test");

// streaming-chunk-queue.js is a classic-script IIFE for the context-isolated
// renderer, but it also assigns to module.exports when required from Node
// (see the file's own dual-export tail) -- same dual-export pattern as
// reply-emotion.js and live2d-logic.js in this app.
const { createDesktopStreamingChunkQueue } = require("../renderer/streaming-chunk-queue");

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Lets every already-queued microtask (promise .then/await continuations)
// run before we proceed -- run()'s internals (nextChunk -> synthesizeChunk
// -> synthesize) advance across several microtask ticks that async/await
// doesn't make directly observable, so tests use this instead of guessing a
// tick count.
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Builds a queue backed by controllable per-chunk synthesize promises (keyed
// by text) so tests can decide exactly when a chunk "finishes synthesizing".
function makeQueue({ isCurrent = () => true } = {}) {
  const synthesizeCalls = [];
  const playCalls = [];
  const pendingSynth = new Map(); // text -> deferred
  let idleCalls = 0;

  function synthesize(text) {
    synthesizeCalls.push(text);
    const d = deferred();
    pendingSynth.set(text, d);
    return d.promise;
  }

  function resolveSynth(text, audioBuffer) {
    pendingSynth.get(text).resolve(audioBuffer);
  }

  async function play(audioBuffer, text) {
    playCalls.push({ audioBuffer, text });
  }

  const queue = createDesktopStreamingChunkQueue({
    synthesize,
    play,
    isCurrent,
    onIdle: () => {
      idleCalls += 1;
    },
  });

  return {
    queue,
    synthesizeCalls,
    playCalls,
    resolveSynth,
    idleCalls: () => idleCalls,
  };
}

test("pushChunk before run() starts: the chunk is synthesized and played, then onIdle fires", async () => {
  const q = makeQueue();
  q.queue.pushChunk("hello");
  q.queue.markDone();

  const runPromise = q.queue.run();
  await flushMicrotasks();
  assert.deepEqual(q.synthesizeCalls, ["hello"]);

  q.resolveSynth("hello", "hello-buffer");
  await runPromise;

  assert.deepEqual(q.playCalls, [{ audioBuffer: "hello-buffer", text: "hello" }]);
  assert.equal(q.idleCalls(), 1);
});

test("pushChunk after run() has started and is waiting for the next chunk", async () => {
  const q = makeQueue();
  // No chunks pushed yet -- run() reaches nextChunk()'s waiter branch
  // synchronously (the Promise executor runs before the first await
  // suspends run()), so pushing right after this call lands on that waiter.
  const runPromise = q.queue.run();

  q.queue.pushChunk("late");
  q.queue.markDone();
  await flushMicrotasks();
  assert.deepEqual(q.synthesizeCalls, ["late"]);

  q.resolveSynth("late", "late-buffer");
  await runPromise;

  assert.deepEqual(q.playCalls, [{ audioBuffer: "late-buffer", text: "late" }]);
  assert.equal(q.idleCalls(), 1);
});

test("cancelPending() mid-flight drops queued-but-not-dequeued chunks but lets the in-flight one finish", async () => {
  const q = makeQueue();
  q.queue.pushChunk("first");
  q.queue.pushChunk("second");
  q.queue.pushChunk("third");

  const runPromise = q.queue.run();
  await flushMicrotasks();
  // "first" was dequeued and handed to synthesize(); "second"/"third" are
  // still sitting in the pending array at this point.
  assert.deepEqual(q.synthesizeCalls, ["first"]);

  q.queue.cancelPending();
  q.resolveSynth("first", "first-buffer");
  await runPromise;

  // "second" and "third" were still queued (not yet dequeued) when
  // cancelPending ran, so they were dropped -- never synthesized, never
  // played. "first" was already in flight and finished naturally.
  assert.deepEqual(q.synthesizeCalls, ["first"]);
  assert.deepEqual(q.playCalls, [{ audioBuffer: "first-buffer", text: "first" }]);
  assert.equal(q.idleCalls(), 1);
});

test("cancelPending() with an empty queue (nothing ever pushed) does not hang and skips playback", async () => {
  const q = makeQueue();
  q.queue.cancelPending();

  await q.queue.run();

  assert.deepEqual(q.synthesizeCalls, []);
  assert.deepEqual(q.playCalls, []);
  // The queue was empty at the very start, so run() returns before ever
  // reaching the "drained" tail -- onIdle is only for a queue that actually
  // processed at least one chunk.
  assert.equal(q.idleCalls(), 0);
});

test("markDone() with an empty queue (nothing ever pushed) does not hang and skips playback", async () => {
  const q = makeQueue();
  q.queue.markDone();

  await q.queue.run();

  assert.deepEqual(q.synthesizeCalls, []);
  assert.deepEqual(q.playCalls, []);
  assert.equal(q.idleCalls(), 0);
});

test("run() stops silently once isCurrent() flips false, without calling onIdle", async () => {
  let current = true;
  const q = makeQueue({ isCurrent: () => current });
  q.queue.pushChunk("only");
  q.queue.markDone();

  const runPromise = q.queue.run();
  await flushMicrotasks();
  assert.deepEqual(q.synthesizeCalls, ["only"]);

  // Superseded by a newer request while synthesis is still in flight.
  current = false;
  q.resolveSynth("only", "only-buffer");
  await runPromise;

  // isCurrent() is checked right after the synth await, before play() -- so
  // a supersede there skips playback entirely.
  assert.deepEqual(q.playCalls, []);
  assert.equal(q.idleCalls(), 0);
});
