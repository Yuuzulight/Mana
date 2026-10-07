// Issue #675: sampler presets and thinking on/off for local llama-server
// requests. Sent in each /v1/chat/completions body, not as startup flags:
// switching needs no restart, and two profiles that resolve to the same
// model file (one shared llama-server process) still get their own settings.
// "Sampler presets" to keep them apart from presets-store.js's prompt presets.
const fs = require("node:fs");
const path = require("node:path");

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

// data/sampler-presets.json tunes these without a code change, e.g.
// {"creative": {"temperature": 0.9}, "mine": {"min_p": 0.05}}: each entry is
// merged over the built-in preset of that name (a new name starts empty and
// can then be picked with MANA_SAMPLER_PRESET). Only the sampler fields below
// are taken, as numbers; "none" always sends nothing. Read per request, so an
// edit applies on the next reply. MANA_SAMPLER_PRESETS_DIR moves the file.
const PRESET_FIELDS = new Set([
  "temperature", "top_p", "top_k", "min_p", "repeat_penalty",
  "dry_multiplier", "dry_base", "dry_allowed_length", "xtc_probability", "xtc_threshold",
]);

function loadSamplerPresets(env) {
  const file = path.join(env.MANA_SAMPLER_PRESETS_DIR || path.join(__dirname, "..", "data"), "sampler-presets.json");
  let table;
  try {
    table = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") console.warn(`sampler presets: ignoring ${file}: ${e.message}`);
    return SAMPLER_PRESETS;
  }
  // Null prototype: a "__proto__" key in the file is then just a name.
  const presets = Object.assign(Object.create(null), SAMPLER_PRESETS);
  for (const [rawName, values] of Object.entries(table && typeof table === "object" ? table : {})) {
    const name = rawName.trim().toLowerCase();
    if (name === "none" || !values || typeof values !== "object") continue;
    const fields = Object.entries(values).filter(([key, value]) => PRESET_FIELDS.has(key) && Number.isFinite(value));
    presets[name] = { ...(Object.hasOwn(SAMPLER_PRESETS, name) ? SAMPLER_PRESETS[name] : {}), ...Object.fromEntries(fields) };
  }
  return presets;
}

// Profiles not listed use "stable". Creative is opt-in only.
const PROFILE_PRESETS = { coding: "precise" };
const THINKING_PROFILES = new Set(["quality", "coding"]);
// Thinking stays off for these whatever the profile: tool calls and their
// repair (reasoning can break the JSON), streamed replies (spoken; thinking
// only delays the first sentence), vision, Best-of-N (N candidates plus a
// 16-token judge) and small utility classifications. A "think harder" turn
// still thinks on the tool loop and streamed replies (see runToolAwareReply
// for how reasoning is kept out of tool calls); the tool-call repair never.
const THINKING_OFF_TASKS = new Set(["tools", "stream", "vision", "bestofn", "utility"]);
const DEFAULT_REASONING_BUDGET = 512;
// A "think harder" turn's own budget (MANA_THINK_HARDER_BUDGET): at the
// ~80-97 tokens/s measured on the RTX 5080, about 11-13 s of thinking (Q43:
// 2048 was wasted on trivial questions). Each tool-loop round thinks at most
// THINK_HARDER_TOOL_ROUND_BUDGET, since a tool turn thinks on every round.
const THINK_HARDER_BUDGET = 1024;
const THINK_HARDER_TOOL_ROUND_BUDGET = 512;

function envValue(env, prefix, name) {
  return String(env[`${prefix}_${String(name).toUpperCase()}`] || "").trim().toLowerCase();
}

function resolvePresetName(profile, env, presets) {
  const configured = [envValue(env, "MANA_SAMPLER_PRESET", profile), String(env.MANA_SAMPLER_PRESET || "").trim().toLowerCase()]
    .find((name) => Object.hasOwn(presets, name));
  return configured || PROFILE_PRESETS[profile] || "stable";
}

// true/false, or null for "send no thinking fields" (MANA_LLAMA_REASONING
// =on|off stays the global switch it was: the launch flag alone decides, even
// over an explicit `override`).
function resolveThinking(profile, task, env, override) {
  const global = String(env.MANA_LLAMA_REASONING || "").toLowerCase();
  if (global === "on" || global === "off") return null;
  if (typeof override === "boolean") return override;
  if (typeof override === "number") return override > 0;
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

// Live on b10507 + Qwen3.5-9B (#770): when the budget runs out mid-thought
// the model keeps reasoning, untagged, in `content` until max_tokens. With
// this closing line sent as reasoning_budget_message it answers cleanly
// (finish "stop", well under max_tokens) at budgets 64, 512 and 2048.
const REASONING_BUDGET_MESSAGE = "\n\nOkay, I've thought about this enough. Time to answer the user directly.\n";

function resolveReasoningBudget(profile, env, thinkHarder, task) {
  const raw = thinkHarder
    ? String(env.MANA_THINK_HARDER_BUDGET || "").trim()
    : envValue(env, "MANA_REASONING_BUDGET", profile) || String(env.MANA_REASONING_BUDGET || "").trim();
  const value = Number(raw);
  let budget = thinkHarder ? THINK_HARDER_BUDGET : DEFAULT_REASONING_BUDGET;
  if (raw !== "" && Number.isInteger(value) && value >= 0) budget = value;
  return thinkHarder && task === "tools" ? Math.min(budget, THINK_HARDER_TOOL_ROUND_BUDGET) : budget;
}

// Fields to spread into a local /v1/chat/completions body (max_tokens
// included). `thinking`: true is a "think harder" turn (thinking on, with
// its own bigger budget, even for tasks that normally never think), false
// forces thinking off (the empty-reply retry).
function buildSamplingParams({ profile = "default", task = null, maxTokens, thinking, env = process.env } = {}) {
  const presets = loadSamplerPresets(env);
  const params = { ...presets[resolvePresetName(profile, env, presets)] };
  if (String(task || "").toLowerCase() === "tools") {
    for (const key of Object.keys(params)) {
      if (key.startsWith("dry_") || key.startsWith("xtc_")) delete params[key];
    }
  }
  params.max_tokens = maxTokens;
  const think = resolveThinking(profile, task, env, thinking);
  if (think === null) return { params, thinking: false };
  params.chat_template_kwargs = { enable_thinking: think };
  if (think) {
    // Checked against the bundled b10507 build's llama-server-impl.dll
    // (field names present, server not run): thinking_budget_tokens is read
    // per request while --reasoning-budget stays at its -1 default. Thinking
    // tokens count toward max_tokens, so the reply keeps its own budget.
    // #1426: a number is a thinking level's own budget (tool rounds capped as for "think harder").
    const taskName = String(task || "").toLowerCase();
    const budget = typeof thinking === "number"
      ? (taskName === "tools" ? Math.min(thinking, THINK_HARDER_TOOL_ROUND_BUDGET) : thinking)
      : resolveReasoningBudget(profile, env, thinking === true, taskName);
    params.thinking_budget_tokens = budget;
    params.reasoning_budget_message = REASONING_BUDGET_MESSAGE;
    if (Number.isFinite(maxTokens)) params.max_tokens = maxTokens + budget;
  }
  return { params, thinking: think };
}

// #1426: the chat composer's thinking levels. Off never thinks; Low,
// Medium and Max think on every reply with their own budget; High is
// "think harder" (THINK_HARDER_BUDGET, MANA_THINK_HARDER_BUDGET). Anything
// else is undefined: the profile decides, as before levels.
const THINKING_LEVELS = { off: false, low: 256, medium: DEFAULT_REASONING_BUDGET, high: true, max: 2048 };
function thinkingForLevel(level) {
  return Object.hasOwn(THINKING_LEVELS, String(level)) ? THINKING_LEVELS[level] : undefined;
}

module.exports = { SAMPLER_PRESETS, buildSamplingParams, thinkingForLevel };
