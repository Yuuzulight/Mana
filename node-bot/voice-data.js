// #1107: my kept voice clips for a Whisper fine-tune. The native launcher
// writes them (Settings > Voice, "Keep my voice clips for training") as
// <dir>/turns/<time>.wav plus a <time>.json sidecar:
//   { heard, transcript, corrected, language, model, durationSec, recordedAt }
// heard is what whisper wrote, transcript the same after my mishearing fixes
// at the time. This side only fills in corrected when I add a fix later.
// Local only; nothing here is uploaded.
const fs = require("node:fs");
const path = require("node:path");
const { correctTranscript, saysPhrase } = require("./speech-vocabulary");

const DEFAULT_VOICE_DATA_DIR = "D:\\ManaAI\\voice-data";

function voiceDataDir(env = process.env) {
  return env.MANA_VOICE_DATA_DIR || DEFAULT_VOICE_DATA_DIR;
}

// A new mishearing fix (heard -> term): every kept clip whose text still has
// heard gets corrected. One that has term as well is left alone: that's most
// likely me saying the fix itself ("I said Gigi Murin, not GG Moon", which
// speech__add_word needs both in). Returns how many sidecars changed.
// ponytail: reads every sidecar; fine for the ~20k clips 2 GB holds, and a
// fix is a rare, by-hand event.
async function applyCorrectionToClips(dir, heard, term) {
  const turns = path.join(dir, "turns");
  let names;
  try {
    names = (await fs.promises.readdir(turns)).filter((n) => n.endsWith(".json"));
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
  let changed = 0;
  for (const name of names) {
    const file = path.join(turns, name);
    try {
      const clip = JSON.parse(await fs.promises.readFile(file, "utf8"));
      const text = clip.corrected || clip.transcript || clip.heard;
      if (typeof text !== "string" || !saysPhrase(text, heard) || saysPhrase(text, term)) continue;
      clip.corrected = correctTranscript(text, { [heard]: term });
      await fs.promises.writeFile(file, `${JSON.stringify(clip, null, 2)}\n`, "utf8");
      changed += 1;
    } catch (e) {
      // Pruned meanwhile, or a broken sidecar: leave it.
      if (e.code !== "ENOENT") console.warn(`[Mana] Couldn't update voice clip ${name}: ${e.message}`);
    }
  }
  return changed;
}

module.exports = { DEFAULT_VOICE_DATA_DIR, applyCorrectionToClips, voiceDataDir };
