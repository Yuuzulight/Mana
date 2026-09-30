// Issue #417: lets the model itself decide, mid-reply, that seeing the
// screen would help -- instead of vision only being reachable via the
// Ctrl+Alt+M hotkey or the opt-in ambient screen-sensing loop. Same
// tool-source shape as expression-tool-source.js (ai/tool-source.js's
// contract): listToolSchemas/executeTool/isKnownToolName.
//
// Three ways this can fail before ever reaching a real description, each
// returned as a {status:"error", error} JSON string (never thrown -- these
// are expected, user-facing conditions, not programmer errors), matching
// skill-tool-source.js's error-return convention:
//   1. No local vision model installed (same getVisionStatus() check
//      /vision/describe already applies).
//   2. The screen-sensing plugin isn't enabled -- reusing that toggle
//      rather than adding a new one, since both this and the ambient
//      glance loop are "let Mana see the screen without a hotkey."
//   3. The capture bridge couldn't get an image in time (no client
//      connected, or the client never responded within its timeout).
const { isPluginEnabled } = require("../capabilities/registry");

const VISION_TOOL_PREFIX = "vision__";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${VISION_TOOL_PREFIX}look`,
      description:
        "Look at the user's screen right now and describe what's on it. Use this when seeing the screen would genuinely help answer the question -- not for every turn.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What to look for or ask about the screen.",
          },
        },
        required: ["prompt"],
      },
    },
  },
];

// #912: one webcam snapshot, only for things I'm showing Mana. Gated on the
// vision model and a camera-capable client (the native launcher, which
// enforces its own off-by-default camera toggle), not on screen sensing.
const CAMERA_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: `${VISION_TOOL_PREFIX}camera`,
    description:
      "Take one snapshot with the user's webcam and describe it. Only use this when the user asks you to look at something they're showing you (\"look at this\", \"what am I holding?\"), never on your own.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What to look for or ask about the snapshot.",
        },
      },
      required: ["prompt"],
    },
  },
};

// #962: keeps the last camera snapshot as a JPEG, only when I ask. The
// launcher holds the snapshot and writes the file (PicturesMana, or the
// folder from Settings > Voice). Write tier (tool-risk.js).
const SAVE_SNAPSHOT_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: `${VISION_TOOL_PREFIX}save_snapshot`,
    description:
      "Save the last camera snapshot as a photo in the user's Pictures folder. Only when the user asks to keep it (\"save that\", \"keep this photo\"), never on your own.",
    parameters: { type: "object", properties: {} },
  },
};

function isVisionToolName(name) {
  return typeof name === "string" && name.startsWith(VISION_TOOL_PREFIX);
}

function createVisionToolSource({
  getVisionStatus,
  runVisionReply,
  visionCaptureBridge,
  screenSensingPlugin,
  pluginSettingsStore,
}) {
  // #787: not offered when it could only fail (no vision model, or the
  // screen-sensing plugin is off) -- goal mode spent rounds retrying it.
  function visionAvailable() {
    const vision = typeof getVisionStatus === "function" ? getVisionStatus() : null;
    return Boolean(vision && vision.available);
  }

  function listToolSchemas() {
    const camera = Boolean(visionCaptureBridge.hasCamera?.());
    // #962: saving needs no vision model, only the launcher with the snapshot.
    const save = camera ? [SAVE_SNAPSHOT_TOOL_SCHEMA] : [];
    if (!visionAvailable()) return save;
    return [
      ...(isPluginEnabled(screenSensingPlugin, pluginSettingsStore) ? TOOL_SCHEMAS : []),
      ...(camera ? [CAMERA_TOOL_SCHEMA] : []),
      ...save,
    ];
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(VISION_TOOL_PREFIX.length);
    if (action === "save_snapshot") {
      try {
        const saved = await visionCaptureBridge.requestCapture({ save: true });
        // A launcher without #962 answers with a screenshot instead.
        if (!/.jpg$/i.test(saved)) throw new Error("this launcher can't save snapshots; update it");
        return JSON.stringify({ status: "ok", saved });
      } catch (e) {
        return JSON.stringify({ status: "error", error: `could not save the snapshot: ${e.message || e}` });
      }
    }
    if (action !== "look" && action !== "camera") {
      throw new Error(`unknown vision tool: ${qualifiedName}`);
    }
    const camera = action === "camera";
    const prompt = String(args?.prompt || "").trim();
    if (!prompt) {
      throw new Error("prompt is required");
    }

    if (!visionAvailable()) {
      return JSON.stringify({ status: "error", error: "no local vision model available" });
    }

    if (!camera && !isPluginEnabled(screenSensingPlugin, pluginSettingsStore)) {
      return JSON.stringify({
        status: "error",
        error: "vision look requires the screen-sensing plugin to be enabled",
      });
    }

    let image;
    try {
      image = await visionCaptureBridge.requestCapture({ camera });
    } catch (e) {
      return JSON.stringify({
        status: "error",
        error: `${camera ? "could not use the camera" : "could not capture the screen"}: ${e.message || e}`,
      });
    }

    try {
      const description = await runVisionReply(prompt, [image]);
      return JSON.stringify({ status: "ok", description: description || "" });
    } catch (e) {
      return JSON.stringify({
        status: "error",
        error: `could not describe the ${camera ? "snapshot" : "screen"}: ${e.message || e}`,
      });
    }
  }

  return { listToolSchemas, executeTool, isKnownToolName: isVisionToolName };
}

module.exports = {
  VISION_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isVisionToolName,
  createVisionToolSource,
};
