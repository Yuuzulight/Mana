// #1282 (part of #697): "not now", "never bring this up again" and quiet
// hours, asked for in chat. One tool over proactive.js's settings; with no
// arguments it just reports them.
const TOOL_NAME = "proactive__settings";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: TOOL_NAME,
      description:
        "Change or check when you speak up on your own (unprompted remarks: briefing, check-in, dream-insight, ...). " +
        "\"Not now\" / \"quiet for a bit\": snooze_minutes (default 60; 0 resumes). " +
        "\"Don't bring this up again\": mute the kind -- the result's lastRemark.reason is the kind of your last remark. " +
        "unmute turns a kind back on. Quiet hours: a daily window where you hold remarks until it ends. " +
        "Reminders the user set still arrive. Returns the current settings.",
      parameters: {
        type: "object",
        properties: {
          snooze_minutes: { type: "number", description: "Hold unprompted remarks this many minutes. 0 resumes now." },
          mute: { type: "string", description: "A remark kind to stop until unmuted, e.g. briefing." },
          unmute: { type: "string", description: "A muted remark kind to turn back on." },
          quiet_hours_enabled: { type: "boolean", description: "Turn the quiet-hours window on or off." },
          quiet_start: { type: "string", description: "Quiet hours start, 24-hour HH:MM." },
          quiet_end: { type: "string", description: "Quiet hours end, 24-hour HH:MM." },
        },
      },
    },
  },
];

function createProactiveToolSource({ proactive }) {
  async function executeTool(name, args = {}) {
    if (name !== TOOL_NAME) throw new Error(`unknown proactive tool: ${name}`);
    const patch = {};
    if (args.snooze_minutes !== undefined) patch.snoozeMinutes = args.snooze_minutes;
    if (args.mute !== undefined) patch.mute = args.mute;
    if (args.unmute !== undefined) patch.unmute = args.unmute;
    const quietHours = { enabled: args.quiet_hours_enabled, start: args.quiet_start, end: args.quiet_end };
    if (Object.values(quietHours).some((v) => v !== undefined)) patch.quietHours = quietHours;
    return JSON.stringify({ ok: true, ...proactive.updateSettings(patch) });
  }

  return { listToolSchemas: () => TOOL_SCHEMAS, executeTool, isKnownToolName: (name) => name === TOOL_NAME };
}

module.exports = { createProactiveToolSource };
