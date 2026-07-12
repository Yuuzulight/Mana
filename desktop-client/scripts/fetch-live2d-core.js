// Downloads the Live2D Cubism Core runtime into assets/live2d/.
//
// Cubism Core is proprietary (Live2D Proprietary Software License) and must
// not be committed to the repository, so every checkout fetches it once from
// the official Live2D CDN. The avatar falls back to PNG sprites without it.
// Mirrors windows-launcher/scripts/fetch-live2d-core.js.
const fs = require("fs");
const https = require("https");
const path = require("path");

const CORE_URL =
  "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";
const TARGET = path.join(__dirname, "..", "assets", "live2d", "live2dcubismcore.min.js");

if (fs.existsSync(TARGET) && fs.statSync(TARGET).size > 0) {
  console.log(`Live2D Cubism Core already present: ${TARGET}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(TARGET), { recursive: true });
console.log(`Downloading Live2D Cubism Core from ${CORE_URL}`);

https
  .get(CORE_URL, (response) => {
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
