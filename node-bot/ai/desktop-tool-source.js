// #911: safe desktop actions -- media keys, volume, opening or focusing an
// app from the Start menu, the audio output -- carried out by the native launcher (Windows
// APIs) over the vision-capture socket, which only a launcher that
// connected with ?desktop=1 answers. The launcher validates every argument;
// nothing here clicks or types into other apps. Tiers are in
// ai/tool-risk.js: focusing and listing are "read", switching the output
// is "write" (asks first), the rest "low".
const DESKTOP_TOOL_PREFIX = "desktop__";

const APP_NAME = {
  type: "string",
  description: "The app's name as it appears in the Start menu, e.g. \"Discord\" or \"Spotify\".",
};

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: `${DESKTOP_TOOL_PREFIX}media`,
      description: "Press a media key on the user's PC: play/pause, next track or previous track.",
      parameters: {
        type: "object",
        properties: { key: { type: "string", enum: ["play_pause", "next", "previous"] } },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: `${DESKTOP_TOOL_PREFIX}set_volume`,
      description:
        "Change the PC's volume, or one app's volume. Only when the user asks you to change the volume. Give either level (0-100) or change (e.g. -10 for quieter). Returns the new level.",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "Only this app's volume, e.g. \"Spotify\". Omit for the whole PC." },
          level: { type: "number", description: "New volume, 0-100." },
          change: { type: "number", description: "Relative change in percentage points, -100 to 100." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: `${DESKTOP_TOOL_PREFIX}open_app`,
      description:
        "Open an app from the user's Start menu, or bring it to the front if it's already open. Only apps with a Start-menu shortcut can be opened.",
      parameters: { type: "object", properties: { name: APP_NAME }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: `${DESKTOP_TOOL_PREFIX}focus_app`,
      description: "Bring an app that's already open to the front. Doesn't start anything.",
      parameters: { type: "object", properties: { name: APP_NAME }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: `${DESKTOP_TOOL_PREFIX}list_audio_outputs`,
      description: "List the PC's audio output devices (speakers, headsets) and which one is in use.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: `${DESKTOP_TOOL_PREFIX}set_audio_output`,
      description:
        "Switch the PC's sound to another output device. The user approves it first. Use a name from desktop__list_audio_outputs.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The device's name, or a unique part of it." } },
        required: ["name"],
      },
    },
  },
];

const ACTIONS = new Set(TOOL_SCHEMAS.map((t) => t.function.name.slice(DESKTOP_TOOL_PREFIX.length)));

function isDesktopToolName(name) {
  return typeof name === "string" && name.startsWith(DESKTOP_TOOL_PREFIX);
}

// bridge: vision-capture-bridge.js. isGaming: whether a game is running.
// voice: this turn was spoken -- mid-game, only a spoken ask runs anything,
// so nothing fires while I'm typing in a game.
function createDesktopToolSource({ bridge, isGaming = () => false, voice = false }) {
  function listToolSchemas() {
    return bridge.hasDesktop() ? TOOL_SCHEMAS : [];
  }

  async function executeTool(qualifiedName, args) {
    const action = qualifiedName.slice(DESKTOP_TOOL_PREFIX.length);
    if (!ACTIONS.has(action)) throw new Error(`unknown desktop tool: ${qualifiedName}`);
    if (!voice && isGaming()) {
      return JSON.stringify({
        status: "error",
        error: "desktop actions are paused while a game is running unless the user asks by voice",
      });
    }
    try {
      const result = await bridge.requestDesktop(action, args);
      return JSON.stringify({ status: "ok", ...result });
    } catch (e) {
      return JSON.stringify({ status: "error", error: e.message || String(e) });
    }
  }

  return { listToolSchemas, executeTool, isKnownToolName: isDesktopToolName };
}

module.exports = { DESKTOP_TOOL_PREFIX, TOOL_SCHEMAS, isDesktopToolName, createDesktopToolSource };
