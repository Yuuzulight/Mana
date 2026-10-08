// #1426: Settings' "Tell Mana what to remember or change". She reads what
// she knows and what I asked, and answers with a suggested change ("I'll
// change Editor from ... to .... Okay?"); nothing is written until I press
// Save it, which applies the same changes as my own words. Like every memory
// write, it's my OK that saves it.
const { FACT_CATEGORIES } = require("./acp-memory-store");

const ACTIONS = ["add", "change", "archive", "forget"];
const MAX_CHANGES = 5;
const MAX_REQUEST_CHARS = 500;
const MAX_TEXT_CHARS = 500;

const liveFacts = (store) => store.listFacts().filter((f) => f.status === "active" || f.status === "pending");

function buildPrompt(facts, request) {
  const known = facts.length
    ? facts.map((f) => `- ${f.key}: ${f.text} [${f.category || "other"}]`).join("\n")
    : "(nothing yet)";
  return [
    "You help the user edit what Mana, their desktop companion, remembers about them.",
    "What she remembers now, one fact per line as key: text [category]:",
    known,
    "",
    `The user says: ${JSON.stringify(request)}`,
    "",
    "Work out the change they want. Answer with JSON only, nothing else:",
    '{"reply": "<one short sentence as Mana saying what you\'ll change, ending with Okay?>", "changes": [{"action": "add" | "change" | "archive" | "forget", "key": "<the fact\'s key; for add, a short new label>", "text": "<the fact as a short sentence, for add and change>", "category": "about-you" | "projects" | "hobbies" | "people" | "other"}]}',
    'Use "change" to correct a fact, "archive" for one that is still true but no longer matters, and "forget" for one that is wrong.',
    "Only change facts the user asked about. If nothing should change, give an empty list and say why in reply.",
  ].join("\n");
}

// The first {...} in a reply (a model may wrap it in prose or a fence).
function parseAnswer(reply) {
  const text = String(reply || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

// Only changes that can apply to what she knows now: a known action, an
// existing key for change/archive/forget (an add on a taken key becomes a
// change), text where it's needed, a known category or none.
function cleanChanges(changes, facts) {
  const byKey = new Map(facts.map((f) => [f.key.toLowerCase(), f]));
  const clean = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    let action = String(change?.action || "").toLowerCase();
    const key = String(change?.key || "").trim().slice(0, 200);
    const text = typeof change?.text === "string" ? change.text.trim().slice(0, MAX_TEXT_CHARS) : "";
    const category = FACT_CATEGORIES.includes(change?.category) ? change.category : null;
    if (!ACTIONS.includes(action) || !key) continue;
    const existing = byKey.get(key.toLowerCase());
    if (action === "add" && existing) action = "change";
    if (action !== "add" && !existing) continue;
    if ((action === "add" || action === "change") && !text) continue;
    clean.push({
      action,
      key: existing ? existing.key : key,
      ...(action === "add" || action === "change" ? { text } : {}),
      ...(category ? { category } : {}),
      ...(existing && action === "change" ? { was: existing.text } : {}),
    });
    if (clean.length >= MAX_CHANGES) break;
  }
  return clean;
}

// runModel(prompt, maxTokens) -> reply text, or null when no model is
// loaded. Returns {reply, changes}, or {error, status}.
async function askMemory({ store, runModel, request }) {
  const said = String(request || "").trim().slice(0, MAX_REQUEST_CHARS);
  if (!said) return { status: 400, error: "Tell her what to remember or change first" };
  const facts = liveFacts(store);
  const reply = runModel ? await runModel(buildPrompt(facts, said), 500) : null;
  if (reply == null) return { status: 503, error: "Her model isn't loaded right now. Try again in a moment." };
  const answer = parseAnswer(reply);
  if (!answer) return { status: 422, error: "She couldn't work out a change from that. Try saying it another way." };
  const changes = cleanChanges(answer.changes, facts);
  const words = typeof answer.reply === "string" && answer.reply.trim() ? answer.reply.trim().slice(0, 400) : null;
  return {
    reply: words || (changes.length ? "Here's what I'd change. Okay?" : "I don't think anything needs changing."),
    changes,
  };
}

// Save it: the same changes, checked again against what she knows now, as
// the user's own words.
function applyMemoryChanges({ store, changes }) {
  const clean = cleanChanges(changes, liveFacts(store));
  const origin = { kind: "user_stated" };
  for (const change of clean) {
    if (change.action === "archive" || change.action === "forget") {
      store.rememberFact({ key: change.key, action: change.action === "archive" ? "archive" : "remove", source: "human", origin });
    } else {
      store.rememberFact({
        key: change.key,
        text: change.text,
        action: change.action === "add" ? "insert" : "patch",
        source: "human",
        origin,
        ...(change.category ? { category: change.category } : {}),
      });
    }
  }
  return { applied: clean.length };
}

module.exports = { askMemory, applyMemoryChanges, buildPrompt, cleanChanges, parseAnswer };
