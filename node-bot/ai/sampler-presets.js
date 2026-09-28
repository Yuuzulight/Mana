// Issue #675: sampler presets and thinking on/off for local llama-server
// requests. Sent in each /v1/chat/completions body, not as startup flags:
// switching needs no restart, and two profiles that resolve to the same
// model file (one shared llama-server process) still get their own settings.
// "Sampler presets" to keep them apart from presets-store.js's prompt presets.

// Qwen3 non-thinking / Qwen3.5 instruct-mode "general" settings from the
// model cards: https://huggingface.co/Qwen/Qwen3-4B and
// https://huggingface.co/Qwen/Qwen3.5-9B. Qwen3.5's card also suggests
// presence_penalty 1.5; left out to start conservative.
const STABLE = { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0 };

const SAMPLER_PRESETS = {
  // Sends nothing: llama-server's own defaults, i.e. the pre-#675 behaviour.
  none: {},
  stable: STABLE,
  // Starting point, not from a model card: Stable a little warmer, plus DRY
  // and XTC at their authors' suggested values (DRY: multiplier 0.8, base
  // 1.75, allowed length 2; XTC: threshold 0.1, probability 0.5).
  creative: {
    ...STABLE,
    temperature: 0.8,
    dry_multiplier: 0.8,
    dry_base: 1.75,
    dry_allowed_length: 2,
    xtc_probability: 0.5,
    xtc_threshold: 0.1,
  },
  // Starting point: Stable at the low temperature Best-of-N (#70) already
  // uses as its safe baseline candidate.
  precise: { ...STABLE, temperature: 0.2 },
};

// Profiles not listed use "stable". Creative is opt-in only.
const PROFILE_PRESETS = { coding: "precise" };
const THINKING_PROFILES = new Set(["quality", "coding"]);
// Thinking stays off for these whatever the profile: tool calls and their
// repair (reasoning can break the JSON), streamed replies (spoken; thinking
// only delays the first sentence), vision, Best-of-N (N candidates plus a
// 16-token judge) and small utility classifications.
const THINKING_OFF_TASKS = new Set(["tools", "stream", "vision", "bestofn", "utility"]);
const DEFAULT_REASONING_BUDGET = 512;

function envValue(env, prefix, name) {
  return String(env[`${prefix}_${String(name).toUpperCase()}`] || "").trim().toLowerCase();
}

function resolvePresetName(profile, env) {
  const configured = [envValue(env, "MANA_SAMPLER_PRESET", profile), String(env.MANA_SAMPLER_PRESET || "").trim().toLowerCase()]
    .find((name) => Object.hasOwn(SAMPLER_PRESETS, name));
  return configured || PROFILE_PRESETS[profile] || "stable";
}

// true/false, or null for "send no thinking fields" (MANA_LLAMA_REASONING
// =on|off stays the global switch it was: the launch flag alone decides).
function resolveThinking(profile, task, env) {
  const global = String(env.MANA_LLAMA_REASONING || "").toLowerCase();
  if (global === "on" || global === "off") return null;
  const flag = (name) => {
    const value = envValue(env, "MANA_THINKING", name);
    return value === "on" ? true : value === "off" ? false : null;
  };
  const taskFlag = task ? flag(task) : null;
  if (taskFlag !== null) return taskFlag;
  if (THINKING_OFF_TASKS.has(String(task || "").toLowerCase())) return false;
  const profileFlag = flag(profile);
  return profileFlag !== null ? profileFlag : THINKING_PROFILES.has(profile);
}

function resolveReasoningBudget(profile, env) {
  const raw = envValue(env, "MANA_REASONING_BUDGET", profile) || String(env.MANA_REASONING_BUDGET || "").trim();
  const budget = Number(raw);
  return raw !== "" && Number.isInteger(budget) && budget >= 0 ? budget : DEFAULT_REASONING_BUDGET;
}

// Fields to spread into a local /v1/chat/completions body (max_tokens
// included). `thinking` forces thinking on/off (the empty-reply retry).
function buildSamplingParams({ profile = "default", task = null, maxTokens, thinking, env = process.env } = {}) {
  const params = { ...SAMPLER_PRESETS[resolvePresetName(profile, env)] };
  if (String(task || "").toLowerCase() === "tools") {
    for (const key of Object.keys(params)) {
      if (key.startsWith("dry_") || key.startsWith("xtc_")) delete params[key];
    }
  }
  params.max_tokens = maxTokens;
  const think = typeof thinking === "boolean" ? thinking : resolveThinking(profile, task, env);
  if (think === null) return { params, thinking: false };
  params.chat_template_kwargs = { enable_thinking: think };
  if (think) {
    // Checked against the bundled b10507 build's llama-server-impl.dll
    // (field names present, server not run): thinking_budget_tokens is read
    // per request while --reasoning-budget stays at its -1 default. Thinking
    // tokens count toward max_tokens, so the reply keeps its own budget.
    const budget = resolveReasoningBudget(profile, env);
    params.thinking_budget_tokens = budget;
    if (Number.isFinite(maxTokens)) params.max_tokens = maxTokens + budget;
  }
  return { params, thinking: think };
}

module.exports = { SAMPLER_PRESETS, buildSamplingParams };
