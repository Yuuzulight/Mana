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
  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(VISION_TOOL_PREFIX.length);
    if (action !== "look") {
      throw new Error(`unknown vision tool: ${qualifiedName}`);
    }
    const prompt = String(args?.prompt || "").trim();
    if (!prompt) {
      throw new Error("prompt is required");
    }

    const vision = typeof getVisionStatus === "function" ? getVisionStatus() : null;
    if (!vision || !vision.available) {
      return JSON.stringify({ status: "error", error: "no local vision model available" });
    }

    if (!isPluginEnabled(screenSensingPlugin, pluginSettingsStore)) {
      return JSON.stringify({
        status: "error",
        error: "vision look requires the screen-sensing plugin to be enabled",
      });
    }

    let image;
    try {
      image = await visionCaptureBridge.requestCapture();
    } catch (e) {
      return JSON.stringify({
        status: "error",
        error: `could not capture the screen: ${e.message || e}`,
      });
    }

    const description = await runVisionReply(prompt, [image]);
    return JSON.stringify({ status: "ok", description: description || "" });
  }

  return { listToolSchemas, executeTool, isKnownToolName: isVisionToolName };
}

module.exports = {
  VISION_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isVisionToolName,
  createVisionToolSource,
};
