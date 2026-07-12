// Previews which Live2D model the avatar will load and how Mana's states map
// onto it. Run after swapping the model folder:
//
//   npm run check-live2d-model
const fs = require("fs");
const path = require("path");
const {
  STATE_EXPRESSION_PREFERENCES,
  STATE_MOTION_PREFERENCES,
  augmentModelSettings,
  expressionForState,
  findModelJson,
  mergeStateMappings,
  motionGroupForState,
  normalizeAvatarConfig,
  parseParamIdList,
  parseStateMappingOverrides,
} = require("../avatar/live2d-logic");

const MODEL_DIR = path.join(__dirname, "..", "avatar", "model");
const explicit = process.env.MANA_LIVE2D_MODEL || "";
const modelJson = explicit
  ? fs.existsSync(explicit)
    ? explicit
    : null
  : findModelJson(MODEL_DIR, fs);

if (!modelJson) {
  console.log(
    explicit
      ? `MANA_LIVE2D_MODEL is set but does not exist: ${explicit}`
      : `No .model3.json found under ${MODEL_DIR}. Copy a model folder there.`,
  );
  process.exit(1);
}

console.log(`Model: ${modelJson}`);

const modelDir = path.dirname(modelJson);
const rawSettings = JSON.parse(fs.readFileSync(modelJson, "utf8"));
const dirFiles = fs.readdirSync(modelDir);
const settings = augmentModelSettings(
  rawSettings,
  dirFiles.filter((name) => name.toLowerCase().endsWith(".motion3.json")),
  dirFiles.filter((name) => name.toLowerCase().endsWith(".exp3.json")),
);

// Per-model config (mana-avatar.json next to the model or in the model root).
let avatarConfig = normalizeAvatarConfig(null);
for (const candidate of [
  path.join(modelDir, "mana-avatar.json"),
  path.join(MODEL_DIR, "mana-avatar.json"),
]) {
  if (fs.existsSync(candidate)) {
    try {
      avatarConfig = normalizeAvatarConfig(
        JSON.parse(fs.readFileSync(candidate, "utf8")),
      );
      console.log(`Avatar config: ${candidate}`);
    } catch (e) {
      console.log(`Avatar config INVALID (${candidate}): ${e.message}`);
    }
    break;
  }
}

const MOTION_OVERRIDES = mergeStateMappings(
  parseStateMappingOverrides(process.env.MANA_LIVE2D_STATE_MOTIONS),
  avatarConfig.stateMotions,
);
const EXPRESSION_OVERRIDES = mergeStateMappings(
  parseStateMappingOverrides(process.env.MANA_LIVE2D_STATE_EXPRESSIONS),
  avatarConfig.stateExpressions,
);

const refs = settings.FileReferences || {};
const motionGroups = Object.keys(refs.Motions || {});
const expressionNames = (refs.Expressions || [])
  .map((expression) => expression.Name)
  .filter(Boolean);

console.log(
  `Motion groups (${motionGroups.length}): ${motionGroups.join(", ") || "(none)"}`,
);
console.log(
  `Expressions (${expressionNames.length}): ${expressionNames.join(", ") || "(none)"}`,
);

// Report the effective values of the tuning params (env > mana-avatar.json
// > default, matching live2d-avatar.js) and whether the model declares each
// one (best-effort via the cdi3 display-info file when present).
const displayInfo = refs.DisplayInfo
  ? path.join(modelDir, refs.DisplayInfo)
  : null;
const displayInfoText =
  displayInfo && fs.existsSync(displayInfo)
    ? fs.readFileSync(displayInfo, "utf8")
    : null;

function reportParam(label, ids, envVar) {
  if (!ids.length) {
    console.log(`${label}: (disabled)`);
    return;
  }
  if (!displayInfoText) {
    console.log(`${label}: ${ids.join(", ")} (unknown — no DisplayInfo file)`);
    return;
  }
  const missing = ids.filter((id) => !displayInfoText.includes(`"${id}"`));
  console.log(
    missing.length
      ? `${label}: ${ids.join(", ")} — NOT FOUND: ${missing.join(", ")} (set ${envVar} or the matching mana-avatar.json field to this model's real parameter ids)`
      : `${label}: ${ids.join(", ")} (present)`,
  );
}

const mouthParam =
  process.env.MANA_LIVE2D_MOUTH_PARAM || avatarConfig.mouthParam;
reportParam("Lip sync parameter", [mouthParam], "MANA_LIVE2D_MOUTH_PARAM");
reportParam(
  "Eye-blink parameters",
  parseParamIdList(
    process.env.MANA_LIVE2D_EYE_BLINK_PARAMS,
    avatarConfig.eyeBlinkParams,
  ),
  "MANA_LIVE2D_EYE_BLINK_PARAMS",
);

console.log("\nState mapping:");
for (const state of Object.keys(STATE_MOTION_PREFERENCES)) {
  const motion = motionGroupForState(state, motionGroups, MOTION_OVERRIDES);
  const expression = expressionForState(
    state,
    expressionNames,
    EXPRESSION_OVERRIDES,
  );
  const wantsExpression = (STATE_EXPRESSION_PREFERENCES[state] || []).length > 0;
  const expressionLabel =
    expression || (wantsExpression ? "(none)" : "(default face)");
  console.log(
    `  ${state.padEnd(8)} motion: ${motion || "(none)"}  expression: ${expressionLabel}`,
  );
}

if (avatarConfig.randomMotions.length) {
  console.log("\nRandom motions:");
  for (const entry of avatarConfig.randomMotions) {
    const exists = motionGroups.some(
      (group) => group.toLowerCase() === entry.group.toLowerCase(),
    );
    console.log(
      `  ${entry.group}${exists ? "" : " (NOT FOUND in model)"} every ${Math.round(entry.minIntervalMs / 1000)}-${Math.round(entry.maxIntervalMs / 1000)}s while ${entry.states.join("/")}`,
    );
  }
}
