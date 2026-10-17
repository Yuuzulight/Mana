// #911: safe desktop actions -- media keys, volume, opening or focusing an
// app from the Start menu, the audio output, moving files in allowed
// folders -- carried out by the native launcher (Windows
// APIs) over the vision-capture socket, which only a launcher that
// connected with ?desktop=1 answers. The launcher validates every argument;
// nothing here clicks or types into other apps. Tiers are in
// ai/tool-risk.js: focusing and listing are "read", switching the output
// and moving files are "write" (they ask first), the rest "low".
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
        "Open an app from the user's Start menu (Store apps too), or bring it to the front if it's already open. Only apps in the Start menu can be opened.",
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
  {
    type: "function",
    function: {
      name: `${DESKTOP_TOOL_PREFIX}list_folder`,
      description:
        "List the folders you may move files in (no path), or what's in one of them, newest first. Use full paths from here for desktop__move_files.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "A full folder path. Omit to list the allowed folders." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: `${DESKTOP_TOOL_PREFIX}move_files`,
      description:
        "Move files or folders into a folder, or rename one, inside the user's allowed folders (see desktop__list_folder). Never overwrites or deletes anything. The user approves it first, and it can be undone with snapshot__restore.",
      parameters: {
        type: "object",
        // "to" and new_folder first: models tend to send arguments in schema
        // order, and the approval prompt cuts off a long list of files, not
        // the destination.
        properties: {
          to: { type: "string", description: "Full path of the folder to move them into, or the new full path when renaming one item." },
          new_folder: {
            type: "boolean",
            description: "true to create \"to\" as a new folder first, inside a folder that already exists.",
          },
          from: { type: "array", items: { type: "string" }, description: "Full paths of the files or folders to move." },
        },
        required: ["to", "from"],
      },
    },
  },
];

// A big move across drives can take a while; running past this, it still
// finishes but its undo isn't recorded.
const MOVE_TIMEOUT_MS = 5 * 60 * 1000;

const ACTIONS = new Set(TOOL_SCHEMAS.map((t) => t.function.name.slice(DESKTOP_TOOL_PREFIX.length)));

function isDesktopToolName(name) {
  return typeof name === "string" && name.startsWith(DESKTOP_TOOL_PREFIX);
}

// bridge: vision-capture-bridge.js. isGaming: whether a game is running.
// voice: this turn was spoken -- mid-game, only a spoken ask runs anything,
// so nothing fires while I'm typing in a game. snapshotStore: where file
// moves are recorded so they can be undone (registerFileMoveRestorer).
function createDesktopToolSource({ bridge, isGaming = () => false, voice = false, snapshotStore = null }) {
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
      if (action === "move_files") {
        // Only the model's fields: "exact" is for undo alone.
        const request = { to: args?.to, from: args?.from, ...(args?.new_folder === true ? { new_folder: true } : {}) };
        const result = await bridge.requestDesktop(action, request, MOVE_TIMEOUT_MS);
        const snapshot = snapshotStore?.recordSnapshot({
          kind: "file-move",
          key: String(args?.to || ""),
          // created: a folder new_folder made, which undo takes away again.
          payload: { moves: result.moved, ...(result.created ? { createdFolder: result.created } : {}) },
          summary: `Moved ${result.moved.length} item(s) to ${args?.to}`,
          source: "agent",
        });
        return JSON.stringify({ status: "ok", ...result, ...(snapshot ? { undoSnapshotId: snapshot.id } : {}) });
      }
      const result = await bridge.requestDesktop(action, args);
      return JSON.stringify({ status: "ok", ...result });
    } catch (e) {
      return JSON.stringify({ status: "error", error: e.message || String(e) });
    }
  }

  return { listToolSchemas, executeTool, isKnownToolName: isDesktopToolName };
}

// Undoing a file-move snapshot moves each item back, last first, then
// removes a folder the move made, if it's empty. What
// can't go back (moved again, deleted since) is reported; only when
// nothing could does it throw, which keeps the snapshot for a retry.
function registerFileMoveRestorer(snapshotStore, bridge) {
  snapshotStore.registerRestorer("file-move", async (key, payload) => {
    const failed = [];
    let undone = 0;
    for (const move of [...(payload?.moves || [])].reverse()) {
      try {
        await bridge.requestDesktop("move_files", { from: [move.to], to: move.from, exact: true }, MOVE_TIMEOUT_MS);
        undone += 1;
      } catch (e) {
        failed.push({ path: move.to, error: e.message || String(e) });
      }
    }
    if (!undone && failed.length) throw new Error(failed.map((f) => f.error).join("; "));
    // Everything went back: the folder the move made goes too, if empty.
    if (payload?.createdFolder && !failed.length) {
      try {
        await bridge.requestDesktop("remove_empty_folder", { path: payload.createdFolder });
      } catch (e) {
        failed.push({ path: payload.createdFolder, error: e.message || String(e) });
      }
    }
    return { undone, failed };
  });
}

module.exports = {
  DESKTOP_TOOL_PREFIX,
  TOOL_SCHEMAS,
  isDesktopToolName,
  createDesktopToolSource,
  registerFileMoveRestorer,
};
