// Issue #331 review (Finding 2): the streamed-sentence playback queue used
// by playStreamingReply, extracted out of renderer.js so it has test
// coverage. Same one-ahead pipelining and cancellation shape
// playReplyAudio already does over a fixed chunks[] array, generalized to a
// queue that new sentences can still be pushed into while it's running --
// needed because streamed sentences arrive over time, not all at once.
// pushChunk(text) may be called after run() has started; markDone() signals
// no more chunks are coming, so the loop can exit after the last one plays
// instead of waiting forever.
//
// Takes its synthesize/play/isCurrent primitives as injected dependencies
// instead of reaching into renderer.js's module-scope globals
// (synthesizeSpeechChunk, playAudioBlob, detectReplyEmotion,
// replyPlaybackToken, setAvatarState) directly, so this module stays
// DOM/Electron-free and testable on its own -- see renderer.js's
// playStreamingReply for how those get wired in.
//
// deps:
//   synthesize(text) -> Promise<audioBlob|null>  synthesize one chunk's audio;
//     a rejection is caught here and treated as a skipped chunk, not a fatal
//     error for the rest of the queue.
//   play(audioBlob, text) -> Promise<void>  play back one synthesized chunk
//   isCurrent() -> boolean  false once this queue has been superseded by a
//     newer one; run() stops silently as soon as this flips.
//   onIdle() -> void  called once the queue has genuinely drained (optional)
function createStreamingChunkQueue({ synthesize, play, isCurrent, onIdle }) {
  const pending = [];
  let waiter = null; // resolve function for a consumer awaiting the next chunk
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

  // Issue #331 review: for a changed:true restart, drop whatever's still
  // queued but not yet in flight instead of draining the full streamed
  // backlog first. The chunk already being synthesized/played (if any)
  // still finishes naturally -- see playStreamingReply's hang-avoidance
  // comment for why that one can't be cut short too.
  function cancelPending() {
    pending.length = 0;
    markDone();
  }

  function peekPending() {
    return inFlightText !== null ? [inFlightText, ...pending] : pending.slice();
  }

  function nextChunk() {
    if (pending.length) {
      return Promise.resolve({ text: pending.shift(), done: false });
    }
    if (closed) {
      return Promise.resolve({ text: null, done: true });
    }
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }

  // Synthesis failing (e.g. TTS not configured -- unknown until the final
  // event arrives, well after chunks may already be queued) costs this one
  // chunk, not the whole reply: skip playback for it instead of throwing.
  async function synthesizeChunk(text) {
    try {
      return await synthesize(text);
    } catch (e) {
      console.warn("Speech synthesis failed for a streamed chunk:", e.message);
      return null;
    }
  }

  async function run() {
    let current = await nextChunk();
    if (current.done) {
      return;
    }
    let inFlight = synthesizeChunk(current.text);

    for (;;) {
      if (!isCurrent()) return; // superseded, stop silently
      const audioBlob = await inFlight;
      if (!isCurrent()) return;

      const next = await nextChunk();
      inFlight = next.done ? null : synthesizeChunk(next.text);
      inFlightText = next.done ? null : next.text;

      if (audioBlob) {
        await play(audioBlob, current.text);
      }

      if (next.done) {
        // Mirrors playReplyAudio's own tail: reset to idle once the queue
        // has genuinely run out, but only if nothing else has taken over
        // playback in the meantime.
        if (isCurrent() && onIdle) {
          onIdle();
        }
        return;
      }
      current = next;
    }
  }

  return { pushChunk, markDone, cancelPending, peekPending, run };
}

module.exports = { createStreamingChunkQueue };
