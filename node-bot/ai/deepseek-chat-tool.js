// #1406: "use DeepSeek for this" in my chat. Only when I ask: a coding
// request runs on DeepSeek (Flash, or Pro if I say so) with her coding
// tools, through the same policy as her own calls (risk gate, hooks, log),
// so its edits are proposals I review like hers. It runs straight away,
// even at peak price, and its cost goes in API spending (use: chat), apart
// from self-work's daily limit. Local-only, no key, or switched off: no.
const { isLocalOnly } = require("../local-only");
const { describeUsage } = require("../api-spending");
const { TIERS } = require("../self-work-escalation");

const NAME = "coding__ask_deepseek";
const MAX_ROUNDS = 20;

// settings: () => { enabled, baseUrl, apiKey }; runtime: remoteToolReply;
// codingSchemas: () => her coding tools' schemas; policy: () => this turn's
// final tool policy.
function createDeepSeekChatToolSource({ settings, runtime, spending, codingSchemas, policy, env = process.env }) {
  const schema = {
    type: "function",
    function: {
      name: NAME,
      description:
        "Hand a coding request to DeepSeek, a remote model, which reads the code and proposes edits with your coding tools; the user reviews every proposal. Only when the user explicitly asks you to use DeepSeek. It costs money (shown in API spending). Use model \"pro\" only when they ask for Pro.",
      parameters: {
        type: "object",
        properties: {
          request: { type: "string", description: "The coding request, with the files or code it's about." },
          model: { type: "string", enum: ["flash", "pro"], description: "flash unless the user asked for Pro." },
        },
        required: ["request"],
      },
    },
  };

  async function run({ request, model }) {
    const s = settings();
    if (isLocalOnly(env)) return { status: "unavailable", reason: "local-only mode is on" };
    if (!s.enabled) return { status: "unavailable", reason: "DeepSeek is switched off in Settings" };
    if (!s.apiKey) return { status: "unavailable", reason: "there's no DeepSeek key in Settings" };
    const text = String(request || "").trim();
    if (!text) return { status: "error", error: "the request is empty" };
    const tier = TIERS.find((t) => t.id === (model === "pro" ? "pro" : "flash"));
    const used = { cacheHit: 0, cacheMiss: 0, output: 0, reasoning: 0, usd: 0, peak: false };
    const onResponse = (json) => {
      const t = spending?.record({ model: tier.model, use: "chat", usage: json?.usage || {} });
      if (!t) return;
      for (const k of ["cacheHit", "cacheMiss", "output", "reasoning"]) used[k] += t[k];
      used.usd = t.usd === null || used.usd === null ? null : used.usd + t.usd;
      used.peak ||= t.peak;
    };
    const loop = runtime.remoteToolReply({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: tier.model, thinking: tier.thinking, onResponse });
    const names = new Set(codingSchemas().map((t) => t.function?.name));
    names.delete(NAME);
    const sub = {
      tools: codingSchemas().filter((t) => names.has(t.function?.name)),
      executeTool: async (name, args) => {
        if (!names.has(name)) throw new Error(`${name} isn't one of the coding tools`);
        return policy().executeTool(name, args);
      },
    };
    const reply = await loop(text, sub, {
      maxRounds: MAX_ROUNDS,
      overrideSystemPrompt:
        "You are helping Mana with a coding request from the person she works for. Read the code you need with the tools, then propose minimal edits; every proposal is reviewed before it's applied. Reply with a short summary of what you proposed and why.",
    });
    return {
      status: "ok",
      model: tier.label,
      answer: String(reply?.content || "").slice(0, 8000),
      proposals: (reply?.toolCalls || []).filter((c) => c.name === "coding__propose_edit" && c.ok !== false).length,
      cost: `${describeUsage(used)}${used.peak ? ", peak" : ", off-peak"}`,
    };
  }

  return {
    listToolSchemas: () => [schema],
    isKnownToolName: (name) => name === NAME,
    async executeTool(name, args = {}) {
      if (name !== NAME) throw new Error(`unknown tool: ${name}`);
      try {
        return JSON.stringify(await run(args));
      } catch (e) {
        return JSON.stringify({ status: "error", error: String(e.message || e).slice(0, 500) });
      }
    },
  };
}

module.exports = { createDeepSeekChatToolSource, NAME };
