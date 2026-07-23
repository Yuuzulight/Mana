// Downloads Live2D's official free "Hiyori" sample model into avatar/model/.
//
// This is Live2D Original Character sample data (Free Material License
// Agreement) and, like Cubism Core, must not be committed to the repo or
// redistributed by Mana -- every checkout that wants a default avatar fetches
// it once, directly from Live2D's own CDN, the same way the "Download"
// button on https://www.live2d.com/en/learn/sample/momose-hiyori/ does
// (see https://cubism.live2d.com/sample-data/js/download.js). Skips
// entirely if a model is already present, so it never clobbers a model you
// dropped in yourself.
const fs = require("fs");
const https = require("https");
const path = require("path");
const { execFileSync } = require("child_process");
const { findModelJson } = require("../avatar/live2d-logic");

const ZIP_URL = "https://cubism.live2d.com/sample-data/bin/hiyori/hiyori_en.zip";
const MODEL_DIR = path.join(__dirname, "..", "avatar", "model");
const TMP_ZIP = path.join(MODEL_DIR, "_hiyori_download.zip");

if (findModelJson(MODEL_DIR, fs)) {
  console.log(`A Live2D model is already present under ${MODEL_DIR}; skipping sample download.`);
  process.exit(0);
}

fs.mkdirSync(MODEL_DIR, { recursive: true });
console.log(`Downloading Live2D sample model (Hiyori) from ${ZIP_URL}`);

https
  .get(ZIP_URL, (response) => {
    if (response.statusCode !== 200) {
      console.error(`Download failed with status ${response.statusCode}`);
      process.exit(1);
    }
    const file = fs.createWriteStream(TMP_ZIP);
    response.pipe(file);
    file.on("finish", () => {
      file.close(() => {
        try {
          execFileSync("powershell.exe", [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${TMP_ZIP}' -DestinationPath '${MODEL_DIR}' -Force`,
          ]);
        } finally {
          fs.rmSync(TMP_ZIP, { force: true });
        }
        if (findModelJson(MODEL_DIR, fs)) {
          console.log(`Sample avatar ready under ${MODEL_DIR}`);
        } else {
          console.error("Extracted the download but couldn't find a .model3.json -- check the zip contents.");
          process.exit(1);
        }
      });
    });
  })
  .on("error", (error) => {
    console.error(`Download failed: ${error.message}`);
    process.exit(1);
  });
