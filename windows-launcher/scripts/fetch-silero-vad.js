// Downloads Silero VAD's streaming ONNX model into assets/vad/.
//
// Small (~2.3MB) but still a binary, machine-fetched artifact -- not
// committed to the repository, same treatment as the Live2D Cubism Core
// runtime (see fetch-live2d-core.js). Voice input still works without it:
// recordUntilSilence() falls back to the existing RMS-threshold check in
// renderer.js if the VAD model is missing or fails to load.
const fs = require("fs");
const https = require("https");
const path = require("path");

const MODEL_URL =
  "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx";
const TARGET = path.join(__dirname, "..", "assets", "vad", "silero_vad.onnx");

if (fs.existsSync(TARGET) && fs.statSync(TARGET).size > 0) {
  console.log(`Silero VAD model already present: ${TARGET}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
console.log(`Downloading Silero VAD model from ${MODEL_URL}`);

https
  .get(MODEL_URL, { headers: { "User-Agent": "mana-fetch-silero-vad" } }, (response) => {
    if (response.statusCode !== 200) {
      console.error(`Download failed with status ${response.statusCode}`);
      process.exit(1);
    }
    const file = fs.createWriteStream(TARGET);
    response.pipe(file);
    file.on("finish", () => {
      file.close(() => {
        console.log(`Saved ${TARGET}`);
      });
    });
  })
  .on("error", (error) => {
    console.error(`Download failed: ${error.message}`);
    process.exit(1);
  });
