// Shared audio-driven lip-sync signal, framework-agnostic (no PIXI/Live2D/
// three.js dependency) so both the Live2D and VRM avatar renderers drive
// their mouth from the exact same math instead of each inventing their
// own RMS-to-openness curve (issue #161's "reuse the same signal
// pipeline" requirement). Originally lived inline in live2d-logic.js;
// extracted here once a second renderer needed the same functions.

// Maps speech RMS amplitude to a 0..1 mouth-open value with a noise floor.
function rmsToMouth(rms, options = {}) {
  const floor = options.floor === undefined ? 0.01 : options.floor;
  const gain = options.gain === undefined ? 9 : options.gain;
  const value = (Number(rms) || 0) - floor;
  if (value <= 0) {
    return 0;
  }
  return Math.min(1, value * gain);
}

// Fast attack, slower decay so the mouth snaps open but closes smoothly.
function smoothMouthValue(previous, target, dtMs, options = {}) {
  const attackMs = options.attackMs === undefined ? 40 : options.attackMs;
  const decayMs = options.decayMs === undefined ? 140 : options.decayMs;
  const prev = Number(previous) || 0;
  const next = Number(target) || 0;
  const tau = next > prev ? attackMs : decayMs;
  const alpha = Math.min(1, (Number(dtMs) || 0) / Math.max(1, tau));
  return prev + (next - prev) * alpha;
}

module.exports = { rmsToMouth, smoothMouthValue };
