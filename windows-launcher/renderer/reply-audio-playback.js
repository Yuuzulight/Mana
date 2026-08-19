// Wires an <audio>-like element's ended/error/pause events into a promise
// that always settles exactly once. Without this, pausing playback (e.g.
// stopReplyAudio() for barge-in, the interrupt hotkey, or a fresh reply
// superseding this one) hangs the promise forever, since .pause() fires
// neither 'ended' nor 'error' -- and whatever awaits playback (e.g.
// handleTranscript's `processing` gate) hangs with it.
//
// A natural end-of-clip pause (paused flips true right before 'ended') just
// resolves a beat earlier via the same 'pause' path -- it isn't a race
// because `settled` blocks every handler from running more than once, and
// pause() on an already-paused element (true once ended) is a spec no-op
// that never fires a second 'pause'.
function waitForPlayback(audio, onSettle) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (onSettle) onSettle();
      fn();
    };

    audio.addEventListener("ended", () => finish(resolve), { once: true });
    audio.addEventListener(
      "error",
      () => finish(() => reject(new Error("Reply audio playback failed"))),
      { once: true },
    );
    audio.addEventListener("pause", () => finish(resolve), { once: true });
  });
}

module.exports = { waitForPlayback };
