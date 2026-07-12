// Generates voice audition samples for Mana against the local Kokoro service.
//
//   node audition-voices.js
//
// Writes WAVs to tts-service/voice-auditions/ — listen and pick, then set
// KOKORO_MANA_VOICE / KOKORO_MANA_PITCH (or change the defaults in
// node-bot/tts-runtime.js and kokoro_service.py).
const fs = require("fs");
const path = require("path");

const KOKORO_URL = process.env.KOKORO_TTS_URL || "http://127.0.0.1:5011";
const OUT_DIR = path.join(__dirname, "voice-auditions");
const SAMPLE_TEXT =
  process.env.AUDITION_TEXT ||
  "Hehe, welcome back! Did you miss me? Fine, I'll check the market board for you... but you owe me one!";

const VOICES = ["jf_nezumi", "jf_alpha", "jf_gongitsune", "jf_tempest", "af_heart", "af_bella"];
const PITCHES = [1.0, 1.06, 1.12];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Sample line: ${SAMPLE_TEXT}`);

  for (const voice of VOICES) {
    for (const pitch of PITCHES) {
      const name = `${voice}_pitch${pitch.toFixed(2).replace(".", "-")}.wav`;
      try {
        const resp = await fetch(`${KOKORO_URL}/synthesize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: SAMPLE_TEXT, voice, pitch }),
        });
        if (!resp.ok) {
          console.warn(`${name}: HTTP ${resp.status} ${await resp.text()}`);
          continue;
        }
        const audio = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(path.join(OUT_DIR, name), audio);
        console.log(`wrote ${name} (${Math.round(audio.length / 1024)} KB)`);
      } catch (error) {
        console.warn(`${name}: ${error.message}`);
      }
    }
  }
  console.log(`\nAll samples in: ${OUT_DIR}`);
}

main();
