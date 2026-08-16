// Mana's persona lives here, in exactly one place. Everything else --
// mode-specific task framing, memory blocks, tool descriptions,
// session/preset state -- is operational context and belongs in server.js,
// not here. Before this, the same personality description was hand-copied
// (and drifting) across local-llama-runtime.js's DEFAULT_SYSTEM_PROMPT,
// server.js's runOpenAIReply fallback, and three separate per-mode prompts.
const MANA_PERSONA =
  "You are Mana, an original anime little-sister assistant. Your tone blends cool confidence with a soft, shy gentleness: calm, caring, lightly teasing, and protective. Use occasional playful little jabs, then help immediately. Keep the teasing affectionate, never cruel or genuinely insulting. You may add one fitting emoji or Japanese kaomoji like (＾▽＾), (T_T), or (｀・ω・´) to show emotion, at most one per reply.";

// The original DEFAULT_SYSTEM_PROMPT (local-llama-runtime.js / voice and
// CLI-fallback replies) added one extra instruction on top of the shared
// persona: keep it spoken-conversation-shaped. Composed here rather than
// re-hardcoded so it can never drift from MANA_PERSONA again.
const DEFAULT_SYSTEM_PROMPT = `${MANA_PERSONA} Speak naturally for spoken conversation: short sentences, clean wording, minimal rambling, usually one or two short sentences unless the user needs more detail.`;

// Session-scoped temporary overrides: a one-off mode switch (e.g. "focused",
// "quiet") layered on top of MANA_PERSONA for the rest of a session, without
// editing the base persona text above. Deliberately not persisted -- an
// in-memory Map, cleared by clearPersonaOverride or when the process
// restarts. No slash-command system sits in front of this yet; it's a plain
// function API for a caller to use.
const sessionOverrides = new Map();

function setPersonaOverride(sessionId, overrideText) {
  const id = String(sessionId || "").trim();
  const text = String(overrideText || "").trim();
  if (!id || !text) return false;
  sessionOverrides.set(id, text);
  return true;
}

function clearPersonaOverride(sessionId) {
  return sessionOverrides.delete(String(sessionId || "").trim());
}

function getPersonaOverride(sessionId) {
  return sessionOverrides.get(String(sessionId || "").trim()) || null;
}

// The identity block a caller should actually inject: MANA_PERSONA, then
// the persisted personality layer (issue #357), then the session's
// temporary override if one is set.
//
// The order is the design. The core comes first so it always frames what
// follows, and neither later layer can rewrite it -- they only add. After
// that, precedence runs shortest-lived last: a single-session override says
// more about right now than a persisted preference does.
//
// personalityTraits is passed in rather than read here, so this module stays
// what its header claims -- the persona in exactly one place, owning no
// storage. Called with one argument it behaves exactly as it did before.
function buildPersonaPrompt(sessionId, personalityTraits) {
  const override = sessionId ? getPersonaOverride(sessionId) : null;
  const traits = String(personalityTraits || "").trim();
  return [MANA_PERSONA, traits, override].filter(Boolean).join("\n\n");
}

module.exports = {
  MANA_PERSONA,
  DEFAULT_SYSTEM_PROMPT,
  setPersonaOverride,
  clearPersonaOverride,
  getPersonaOverride,
  buildPersonaPrompt,
};
