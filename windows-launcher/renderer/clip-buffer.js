// Issue #450: a small ring buffer of {image, timestamp} screen captures for
// the "what just happened?" clip hotkey. Kept DOM-free/IPC-free so it's
// testable directly -- renderer.js owns the actual capture timer and the
// screen:capture-primary IPC call, this just tracks what's accumulated.

const MAX_FRAMES = 5;

function createClipBuffer() {
  return [];
}

function pushFrame(buffer, image, timestamp) {
  const next = buffer.concat([{ image, timestamp }]);
  return next.length > MAX_FRAMES ? next.slice(next.length - MAX_FRAMES) : next;
}

// Span between the oldest and newest buffered frame, in seconds -- the real
// lookback window, not the target ~15s (which only holds once the buffer's
// full). 0 for an empty or single-frame buffer, since there's no span yet.
function getSpanSeconds(buffer) {
  if (buffer.length < 2) {
    return 0;
  }
  const oldest = buffer[0].timestamp;
  const newest = buffer[buffer.length - 1].timestamp;
  return (newest - oldest) / 1000;
}

function getImages(buffer) {
  return buffer.map((frame) => frame.image);
}

module.exports = {
  MAX_FRAMES,
  createClipBuffer,
  pushFrame,
  getSpanSeconds,
  getImages,
};
