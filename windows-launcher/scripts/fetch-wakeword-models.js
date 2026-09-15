// Downloads openWakeWord's two backbone models (melspectrogram +
// embedding) into assets/wakeword/ -- see issue #342. Third-party
// pretrained models with a stable GitHub release URL, so this follows
// the same fetch-not-commit convention as fetch-silero-vad.js. mana.onnx
// (our own trained classifier, same directory) IS committed directly,
// since nothing else hosts it yet -- not fetched by this script.
//
// Voice input still works without these: the acoustic wake-word
// pre-filter just gets skipped (getWakeWordClassifier() returns null)
// if either file is missing, falling back to today's text-only gating.
//
// Unlike fetch-silero-vad.js's target (raw.githubusercontent.com, serves
// directly), GitHub release asset URLs 302-redirect to a signed
// storage URL -- confirmed directly, not assumed -- so this needs actual
// redirect-following, which plain https.get doesn't do on its own.
const fs = require("fs");
const https = require("https");
const path = require("path");

const MODELS = [
  {
    name: "melspectrogram.onnx",
    url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx",
  },
  {
    name: "embedding_model.onnx",
    url: "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx",
  },
];

const TARGET_DIR = path.join(__dirname, "..", "assets", "wakeword");
const MAX_REDIRECTS = 5;

function download(url, target, redirectsLeft) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "mana-fetch-wakeword-models" } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          response.resume();
          download(response.headers.location, target, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode} for ${url}`));
          return;
        }
        const file = fs.createWriteStream(target);
        response.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

async function main() {
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  for (const model of MODELS) {
    const target = path.join(TARGET_DIR, model.name);
    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      console.log(`${model.name} already present: ${target}`);
      continue;
    }
    console.log(`Downloading ${model.name} from ${model.url}`);
    await download(model.url, target, MAX_REDIRECTS);
    console.log(`Saved ${target}`);
  }
}

main().catch((error) => {
  console.error(`Download failed: ${error.message}`);
  process.exit(1);
});
