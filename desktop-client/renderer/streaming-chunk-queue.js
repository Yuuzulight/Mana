// Issue #331 review (Finding 2): the streamed-sentence playback queue used
// by speakStreamingReply, extracted out of renderer.js so it has test
// coverage. Same pushChunk/markDone/cancelPending/run shape as
// windows-launcher's renderer/streaming-chunk-queue.js -- kept as a
// near-duplicate rather than a shared module across apps, matching how
// desktop-client and windows-launcher already each define their own
// stopLipSync/startLipSync rather than sharing one.
//
// Takes its synthesize/play/isCurrent primitives as injected dependencies
// instead of reaching into renderer.js's module-scope globals
// (synthesizeAndDecodeChunk, playDecodedChunk, desktopReplyPlaybackToken,
// setSprite) directly, so this module stays DOM/Electron-free and testable
// on its own -- see renderer.js's speakStreamingReply for how those get
// wired in.
//
// cancelPending() only drops chunks that haven't started synthesizing or
// playing yet -- whatever's already in flight (synthesizing or mid-
// playback) always finishes naturally.
//
// deps:
//   synthesize(text) -> Promise<audioBuffer|null>  synthesize one chunk's
//     audio; a rejection is caught here and treated as a skipped chunk, not
//     a fatal error for the rest of the queue.
//   play(audioBuffer, text) -> Promise<void>  play back one synthesized chunk
//   isCurrent() -> boolean  false once this queue has been superseded by a
//     newer one; run() stops silently as soon as this flips.
//   onIdle() -> void  called once the queue has genuinely drained (optional)
//
// Wrapped in an IIFE so its top-level declarations don't leak into the
// shared global scope classic scripts otherwise all share -- see
// avatar/live2d-logic.js for why that matters.
(function () {

function createDesktopStreamingChunkQueue({ synthesize, play, isCurrent, onIdle }) {
  const pending = [];
  let waiter = null;
  let closed = false;
  // Text of whichever chunk has been dequeued (out of `pending`) and handed
  // to synthesizeChunk() but not yet passed to play() -- the one-ahead
  // pipelining in run() below means this is *not* in `pending` by the time
  // it's playing's turn is up next, so peekPending() has to report it
  // separately or it silently vanishes from the not-yet-played snapshot.
  let inFlightText = null;

  function pushChunk(text) {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ text, done: false });
    } else {
      pending.push(text);
    }
  }

  function markDone() {
    closed = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve({ text: null, done: true });
    }
  }

  function cancelPending() {
    pending.length = 0;
    markDone();
  }

  function peekPending() {
    return inFlightText !== null ? [inFlightText, ...pending] : pending.slice();
  }

  function nextChunk() {
    if (pending.length) return Promise.resolve({ text: pending.shift(), done: false });
    if (closed) return Promise.resolve({ text: null, done: true });
    return new Promise((resolve) => { waiter = resolve; });
  }

  async function synthesizeChunk(text) {
    try {
      return await synthesize(text);
    } catch (e) {
      console.warn('Speech synthesis failed for a streamed chunk:', e.message);
      return null;
    }
  }

  async function run() {
    let current = await nextChunk();
    if (current.done) return;
    let inFlight = synthesizeChunk(current.text);

    for (;;) {
      if (!isCurrent()) return;
      const audioBuffer = await inFlight;
      if (!isCurrent()) return;

      const next = await nextChunk();
      inFlight = next.done ? null : synthesizeChunk(next.text);
      inFlightText = next.done ? null : next.text;

      if (audioBuffer) {
        await play(audioBuffer, current.text);
      }

      if (next.done) {
        // Mirrors speakReply's own tail: reset to idle once the queue has
        // genuinely run out, but only if nothing else has taken over
        // playback in the meantime.
        if (isCurrent() && onIdle) onIdle();
        return;
      }
      current = next;
    }
  }

  return { pushChunk, markDone, cancelPending, peekPending, run };
}

const exportsObj = { createDesktopStreamingChunkQueue };

if (typeof module !== "undefined" && module.exports) {
  module.exports = exportsObj;
}
if (typeof window !== "undefined") {
  window.ManaStreamingChunkQueue = exportsObj;
}

})();
