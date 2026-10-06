// #1383: her self-inventory, built fresh on every call from what already
// exists -- the merged tool list and the risk gate's tiers, the
// capabilities array and its health, the MCP registry, model status -- so
// it's never a second registry and never stale. It describes; it grants
// nothing: every call still goes through its approval and settings.
const { classifyToolCall, isShellTool, SELF_GATED } = require("./tool-risk");

const NAME = "capabilities__inventory";
const MAX_CHARS = 6000;
const NOTE = "Listed here isn't permission: every call still goes through its approval and settings.";

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function approvalOf(name, tier, mode) {
  if (SELF_GATED.has(name)) return "asks for itself when it needs to";
  if (isShellTool(name)) return "depends on the command";
  if (tier === "destructive" || (mode !== "off" && !(mode === "smart" && ["read", "low"].includes(tier)))) return "asks first";
  return "runs without asking";
}

// Plain data in, plain data out (tests feed it directly).
function buildInventory({ tools = [], capabilities = [], health = {}, isEnabled = () => true, mcpServers = [], modelStatus = null, approvalMode = "smart", about = "" }) {
  const q = String(about || "").toLowerCase();
  const hit = (...fields) => !q || fields.some((f) => String(f || "").toLowerCase().includes(q));

  const toolRows = tools
    .map((t) => t?.function)
    .filter((f) => f?.name && hit(f.name, f.description))
    .map((f) => {
      const { tier } = classifyToolCall(f.name, {});
      return { name: f.name, does: clip(f.description, 100), approval: approvalOf(f.name, tier, approvalMode) };
    });

  const pluginRows = capabilities
    .filter((c) => c?.key && hit(c.key, c.name, c.description))
    .map((c) => {
      const enabled = isEnabled(c);
      const h = health[c.key];
      const status = !enabled ? "off" : h?.status || (typeof c.getHealth === "function" ? "unknown" : "no health check");
      const row = { key: c.key, name: c.name || c.key, status };
      if (!enabled) row.why = "turned off in Settings > Plugins";
      else if (h?.message && !["ok", "configured", "ready"].includes(h.status)) row.why = clip(h.message, 140);
      return row;
    });

  const mcpRows = mcpServers
    .filter((s) => hit(s.name, ...(s.allowedTools || [])))
    .map((s) => ({ name: s.name, transport: s.transport?.kind || "unknown", tools: (s.allowedTools || []).length, health: "not tracked" }));

  const models = modelStatus
    ? {
        activeProfile: modelStatus.activeProfile ?? null,
        localOnly: Boolean(modelStatus.localOnly),
        remoteAiEnabled: Boolean(modelStatus.remoteAiEnabled),
        cloudFallbackEnabled: Boolean(modelStatus.cloudFallbackEnabled),
        cost: modelStatus.localOnly
          ? "local only: no paid calls"
          : modelStatus.remoteAiEnabled || modelStatus.cloudFallbackEnabled
            ? "cloud models are configured and may cost money"
            : "local models only",
      }
    : { status: "not reported", cost: "unknown" };

  return fit({ note: NOTE, approvalMode, tools: toolRows, plugins: pluginRows, mcpServers: mcpRows, models, ...(q ? { about } : {}) });
}

// Bounded for her context: halve the longest list until it fits, saying
// how many were left out.
function fit(inv) {
  const lists = ["tools", "plugins", "mcpServers"];
  const more = {};
  while (JSON.stringify(inv).length > MAX_CHARS) {
    const longest = lists.reduce((a, b) => (inv[b].length > inv[a].length ? b : a));
    if (inv[longest].length <= 1) break;
    const keep = Math.ceil(inv[longest].length / 2);
    more[longest] = (more[longest] || 0) + inv[longest].length - keep;
    inv = { ...inv, [longest]: inv[longest].slice(0, keep) };
  }
  return Object.keys(more).length ? { ...inv, leftOut: more, hint: "Ask again with `about` to narrow it." } : inv;
}

// deps are getters, read when she calls it.
function createInventoryToolSource(deps) {
  return {
    listToolSchemas: () => [
      {
        type: "function",
        function: {
          name: NAME,
          description:
            "What you can do right now: your tools and whether they ask first, plugins and why one is off or unhealthy, MCP servers, models and local-only mode. Check it before saying you can or can't do something, and pick an alternative from it instead of inventing a tool. Listing isn't permission.",
          parameters: { type: "object", properties: { about: { type: "string", description: "Optional word to narrow it, e.g. 'calendar' or 'browser'." } } },
        },
      },
    ],
    isKnownToolName: (n) => n === NAME,
    executeTool: async (n, args) => {
      if (n !== NAME) throw new Error("Unknown inventory tool");
      return JSON.stringify(
        buildInventory({
          tools: deps.tools(),
          capabilities: deps.capabilities(),
          health: deps.health(),
          isEnabled: deps.isEnabled,
          mcpServers: deps.mcpServers(),
          modelStatus: deps.modelStatus(),
          approvalMode: deps.approvalMode(),
          about: args?.about,
        }),
      );
    },
  };
}

module.exports = { NAME, MAX_CHARS, buildInventory, createInventoryToolSource };
