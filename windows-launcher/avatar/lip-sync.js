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

// Issue #275: MFCC (Mel-Frequency Cepstral Coefficients) extraction --
// mel filterbank + log energy + DCT-II -- run over the same AnalyserNode
// frequency-domain data spectralCentroidHz already reads. Genuine viseme
// discrimination (below) is a formant-band read of the filterbank's
// pre-DCT mel energies, not the DCT'd coefficients themselves -- formant
// frequencies (F1/F2, the vocal-tract resonances that actually distinguish
// "ah"/"ee"/"oo") live directly in the frequency-banded energy, and reading
// them there is verifiable against textbook formant tables in a way that
// classifying on abstract cepstral coefficients (which would need labeled
// training data this project doesn't have) is not. The two stay paired in
// one extraction pass -- computeMfcc returns both -- because they're the
// same mel-filterbank computation; splitting them would mean building the
// filterbank twice per frame.
const melFilterbankCache = new Map();

function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
  return 700 * (10 ** (mel / 2595) - 1);
}

// Standard triangular mel filterbank: numFilters overlapping triangles
// spaced evenly on the mel scale between minHz/maxHz, each expressed as a
// weight per FFT bin. Built once per (numFilters, fftSize, sampleRate,
// minHz, maxHz) combination and cached -- these are all constant for the
// life of an audio context, and rebuilding ~26 x 257 weights on every
// ~30Hz lip-sync tick would be wasted work.
function buildMelFilterbank(numFilters, fftSize, sampleRate, minHz, maxHz) {
  const numBins = fftSize / 2 + 1;
  const minMel = hzToMel(minHz);
  const maxMel = hzToMel(maxHz);
  const melPoints = new Array(numFilters + 2);
  for (let i = 0; i < melPoints.length; i += 1) {
    melPoints[i] = minMel + ((maxMel - minMel) * i) / (numFilters + 1);
  }
  const hzPoints = melPoints.map(melToHz);
  const binPoints = hzPoints.map((hz) => Math.floor(((fftSize + 1) * hz) / sampleRate));

  const filters = [];
  const centerHz = [];
  for (let f = 0; f < numFilters; f += 1) {
    const left = binPoints[f];
    const center = binPoints[f + 1];
    const right = binPoints[f + 2];
    const weights = new Float64Array(numBins);
    for (let bin = left; bin < center; bin += 1) {
      if (bin >= 0 && bin < numBins && center > left) {
        weights[bin] = (bin - left) / (center - left);
      }
    }
    for (let bin = center; bin < right; bin += 1) {
      if (bin >= 0 && bin < numBins && right > center) {
        weights[bin] = (right - bin) / (right - center);
      }
    }
    filters.push(weights);
    centerHz.push(hzPoints[f + 1]);
  }
  return { filters, centerHz };
}

function getMelFilterbank(numFilters, fftSize, sampleRate, minHz, maxHz) {
  const key = `${numFilters}:${fftSize}:${sampleRate}:${minHz}:${maxHz}`;
  let filterbank = melFilterbankCache.get(key);
  if (!filterbank) {
    filterbank = buildMelFilterbank(numFilters, fftSize, sampleRate, minHz, maxHz);
    melFilterbankCache.set(key, filterbank);
  }
  return filterbank;
}

// DCT-II, the same transform classic MFCC pipelines use to decorrelate log
// mel energies into cepstral coefficients.
function dct2(input, numCoefficients) {
  const n = input.length;
  const output = new Float64Array(numCoefficients);
  for (let k = 0; k < numCoefficients; k += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += input[i] * Math.cos((Math.PI / n) * (i + 0.5) * k);
    }
    output[k] = sum;
  }
  return output;
}

// magnitudesDb: Float32Array from AnalyserNode.getFloatFrequencyData (dB).
// Returns { mfcc, melEnergies, melCenterHz } -- melEnergies/melCenterHz are
// classifyViseme's input, mfcc is the literal cepstral fingerprint (kept
// for callers that want the classic MFCC vector itself, e.g. future
// per-voice calibration per issue #275's own "out of scope for now" note).
function computeMfcc(magnitudesDb, sampleRate, fftSize, options = {}) {
  const numFilters = options.numFilters === undefined ? 26 : options.numFilters;
  const numCoefficients = options.numCoefficients === undefined ? 13 : options.numCoefficients;
  const minHz = options.minHz === undefined ? 0 : options.minHz;
  const maxHz = options.maxHz === undefined ? sampleRate / 2 : options.maxHz;
  const { filters, centerHz } = getMelFilterbank(numFilters, fftSize, sampleRate, minHz, maxHz);

  const numBins = magnitudesDb.length;
  const power = new Float64Array(numBins);
  for (let i = 0; i < numBins; i += 1) {
    const db = magnitudesDb[i];
    // Power, not amplitude -- dB is 10*log10(power), not 20*log10(power).
    power[i] = Number.isFinite(db) ? 10 ** (db / 10) : 0;
  }

  const melEnergies = new Float64Array(numFilters);
  for (let f = 0; f < numFilters; f += 1) {
    const weights = filters[f];
    let sum = 0;
    for (let i = 0; i < numBins; i += 1) {
      sum += weights[i] * power[i];
    }
    melEnergies[f] = sum;
  }

  const logEnergies = new Float64Array(numFilters);
  const floor = 1e-10;
  for (let f = 0; f < numFilters; f += 1) {
    logEnergies[f] = Math.log(Math.max(floor, melEnergies[f]));
  }

  return {
    mfcc: Array.from(dct2(logEnergies, numCoefficients)),
    melEnergies: Array.from(melEnergies),
    melCenterHz: centerHz,
  };
}

// A small, fixed viseme set -- not a full phoneme inventory, just enough to
// distinguish the mouth shapes that actually read differently on an avatar:
// "aa" (open, e.g. father), "ee" (close/front, e.g. see), "oo" (close/back,
// e.g. boot), "neutral" (silence or ambiguous). Bands are typical adult
// vowel formant ranges (F1 = jaw openness, F2 = tongue front/back) -- a
// generic classifier per issue #275's explicit scope, not a per-voice
// calibrated one.
const VISEME_FORMANT_BANDS = {
  aa: { f1: [600, 1000], f2: [1000, 1900] },
  ee: { f1: [250, 450], f2: [1900, 3000] },
  oo: { f1: [250, 450], f2: [600, 1100] },
};

function bandEnergy(melEnergies, melCenterHz, loHz, hiHz) {
  let sum = 0;
  for (let i = 0; i < melEnergies.length; i += 1) {
    if (melCenterHz[i] >= loHz && melCenterHz[i] < hiHz) {
      sum += melEnergies[i];
    }
  }
  return sum;
}

// mfccResult: the object computeMfcc returns. Picks whichever viseme's
// formant bands hold the largest share of this frame's mel energy;
// "neutral" only when there's essentially no signal (silence). There is no
// tie-margin -- a genuinely ambiguous frame still deterministically picks
// whichever viseme scores highest (ties go to "aa", first in
// VISEME_FORMANT_BANDS' iteration order), not "neutral"; that's an
// acceptable simplification for a coarse mouth-shape signal, not a bug.
function classifyViseme(mfccResult, options = {}) {
  const { melEnergies, melCenterHz } = mfccResult || {};
  if (!melEnergies || !melCenterHz) {
    return "neutral";
  }
  const totalEnergy = melEnergies.reduce((sum, value) => sum + value, 0);
  const silenceFloor = options.silenceFloor === undefined ? 1e-6 : options.silenceFloor;
  if (totalEnergy <= silenceFloor) {
    return "neutral";
  }

  let best = "neutral";
  let bestScore = 0;
  for (const [viseme, bands] of Object.entries(VISEME_FORMANT_BANDS)) {
    const f1 = bandEnergy(melEnergies, melCenterHz, bands.f1[0], bands.f1[1]);
    const f2 = bandEnergy(melEnergies, melCenterHz, bands.f2[0], bands.f2[1]);
    const score = (f1 + f2) / totalEnergy;
    if (score > bestScore) {
      bestScore = score;
      best = viseme;
    }
  }
  return best;
}

// Maps a classified viseme to the same -1..1 mouth-form range
// centroidToMouthForm already drives ParamMouthForm with (negative =
// rounder/"o"/"u", positive = wider/"i"/"e") so it can be dropped in at the
// exact same call site.
function visemeToMouthForm(viseme) {
  if (viseme === "ee") return 1;
  if (viseme === "oo") return -1;
  return 0;
}

module.exports = {
  rmsToMouth,
  smoothMouthValue,
  spectralCentroidHz,
  centroidToMouthForm,
  vrmMouthBlendShapes,
  computeMfcc,
  classifyViseme,
  visemeToMouthForm,
};
