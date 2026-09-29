// #675 (Q12b): Mana turns deep thinking on herself when the user asks for
// more care in any words ("take your time with this", "be really careful"),
// not only the fixed "think harder" phrases. It lasts for the task: she
// turns it off when the task is done or the user moves on, and it never
// outlives MAX_DEEP_THINKING_REPLIES replies. No approval: it only changes
// how long she thinks, never what she can do. The native launcher lights its
// Think button from /reply/stream's final `deepThinking` and sends
// thinkHarder: false when the user clicks it off.
const DEEP_THINKING_TOOL_NAME = "deep_thinking__set";
const MAX_DEEP_THINKING_REPLIES = 10;

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: DEEP_THINKING_TOOL_NAME,
      description:
        "Turn deep thinking (slower, more careful replies) on or off. Turn it on when the user asks you to think harder, take your time or be extra careful with something, in any words. It lasts for that task: turn it off once the task is done or the user moves on to something else. It switches itself off after 10 replies.",
      parameters: {
        type: "object",
        properties: {
          on: { type: "boolean", description: "true to turn deep thinking on, false to turn it off." },
        },
        required: ["on"],
      },
    },
  },
];

// Per session (key = sessionId, null included): replies left.
function createDeepThinkingState() {
  const left = new Map();
  return {
    // Once per reply: whether Mana's own deep thinking covers it (and
    // counts it against the cap).
    takeReply(key) {
      const n = left.get(key) || 0;
      if (n > 1) left.set(key, n - 1);
      else left.delete(key);
      return n > 0;
    },
    // Only ever called mid-reply, so the reply that turns it on counts.
    // Turning it on again while on doesn't reset the cap.
    set(key, on) {
      if (!on) left.delete(key);
      else if (!left.has(key)) left.set(key, MAX_DEEP_THINKING_REPLIES - 1);
    },
    isOn: (key) => left.has(key),
  };
}

// onSet(on) is the reply's own hook: it records the change and makes the
// rest of this reply think (or not).
function createDeepThinkingToolSource({ onSet }) {
  return {
    listToolSchemas: () => TOOL_SCHEMAS,
    isKnownToolName: (name) => name === DEEP_THINKING_TOOL_NAME,
    async executeTool(name, args) {
      if (name !== DEEP_THINKING_TOOL_NAME) throw new Error(`unknown deep_thinking tool: ${name}`);
      if (typeof args?.on !== "boolean") throw new Error("on (true or false) is required");
      onSet(args.on);
      return JSON.stringify({ ok: true, deepThinking: args.on });
    },
  };
}

module.exports = {
  DEEP_THINKING_TOOL_NAME,
  MAX_DEEP_THINKING_REPLIES,
  createDeepThinkingState,
  createDeepThinkingToolSource,
};
