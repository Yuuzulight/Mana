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

// Spectral centroid (Hz) from a Web Audio AnalyserNode's frequency-domain
// magnitudes (dB, as returned by getFloatFrequencyData). A rough
// "brightness" proxy -- higher for front/unrounded vowels and sibilants,
// lower for back/rounded vowels -- used to vary mouth *shape* alongside the
// existing RMS-driven mouth *openness*, so talking doesn't read as one flat
// jaw-flap regardless of what's being said. Reuses the AnalyserNode the lip
// sync pipeline already creates for RMS -- no new audio graph or dependency
// (inspired by Project AIRI's wlipsync-based phoneme lip sync, but adapted
// to Mana's existing signal instead of pulling in a WASM classifier).
function spectralCentroidHz(magnitudesDb, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const floorDb = -100;
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < magnitudesDb.length; i += 1) {
    const db = magnitudesDb[i];
    if (!Number.isFinite(db) || db <= floorDb) {
      continue;
    }
    const magnitude = 10 ** (db / 20);
    weighted += magnitude * (i * binHz);
    total += magnitude;
  }
  return total > 0 ? weighted / total : 0;
}

// Maps a spectral centroid (Hz) to a -1..1 mouth-form target: negative
// (rounder, e.g. "o"/"u") for bassy/low-centroid audio, positive (wider,
// e.g. "i"/"e") for bright/high-centroid audio. A coarse heuristic -- not a
// phoneme classifier -- meant to add shape variation, not linguistic
// accuracy. centroidLowHz/HighHz bound the range that maps to -1/+1; the
// defaults sit roughly where voiced speech centroids fall in practice.
function centroidToMouthForm(centroidHz, options = {}) {
  const value = Number(centroidHz) || 0;
  // spectralCentroidHz returns exactly 0 for true silence (no magnitude
  // above its noise floor) -- treat that as "no signal, stay neutral"
  // rather than mapping it into the low end of the bassy/rounded range.
  if (value <= 0) {
    return 0;
  }
  const low =
    options.centroidLowHz === undefined ? 600 : options.centroidLowHz;
  const high =
    options.centroidHighHz === undefined ? 2600 : options.centroidHighHz;
  if (high <= low) {
    return 0;
  }
  const t = (value - low) / (high - low);
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * 2 - 1;
}

// Blends VRM's discrete mouth blend-shape presets from the same two
// signals already driving Live2D's ParamMouthOpenY/ParamMouthForm:
// openness (mouthValue, 0..1 from rmsToMouth) and brightness (form, -1..1
// from centroidToMouthForm). "aa" is the dominant open-mouth shape; the
// secondary shape leans toward "ih" (bright/wide) or "ou" (bassy/rounded)
// depending on which way brightness leans. A coarse two-shape
// approximation of Project AIRI's phoneme-classifier-driven "winner +
// runner" wlipsync blend, built from signals Mana already has instead of
// a new WASM dependency.
function vrmMouthBlendShapes(mouthValue, form) {
  const openness = Math.max(0, Math.min(1, Number(mouthValue) || 0));
  const brightness = Math.max(-1, Math.min(1, Number(form) || 0));
  const secondaryWeight = openness * Math.abs(brightness);
  return {
    aa: openness * (1 - Math.abs(brightness) * 0.5),
    ih: brightness > 0 ? secondaryWeight : 0,
    ou: brightness < 0 ? secondaryWeight : 0,
  };
}

module.exports = {
  rmsToMouth,
  smoothMouthValue,
  spectralCentroidHz,
  centroidToMouthForm,
  vrmMouthBlendShapes,
};
