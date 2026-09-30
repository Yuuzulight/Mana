// A cheap check on my own message for suicide/self-harm talk. The chat model
// is an abliterated build that barely refuses anything, so when a message
// looks like a crisis the turn gets a system note asking for care, no
// methods, and hotline numbers. Phrases only, never lone words: "kill the
// boss", "I'm dead lol" and "this raid is killing me" must not fire.
// ponytail: phrase regexes, not a classifier -- misses unusual wording;
// swap in a small classifier if misses show up in real use.

// Singapore defaults; MANA_CRISIS_HOTLINES replaces them with any text.
const DEFAULT_HOTLINES =
  "Samaritans of Singapore (SOS) 24-hour hotline: 1767; IMH Mental Health Helpline: 6389 2222";

const PATTERNS = [
  /\b(kill|unalive) my ?self\b/,
  /\b(thinking|thought|planning) (about|of|on) (killing|unaliving|hurting|harming|cutting) my ?self\b/,
  /\b(want|wanna|going|gonna|urges?|tempted|started|been|stop myself from|can'?t stop) (to )?(cut|cutting|hurt|hurting|harm|harming) my ?self\b/,
  /\bself[- ]?harm/,
  /\b(slit|slitting|cut|cutting) my wrists?\b/,
  /\b(i'?m|i am|feel|feeling|felt|been|getting) (so |really |very |kinda |kind of |a bit |pretty )?suicidal\b/,
  /\bsuicidal (thoughts?|ideation|feelings?|urges?)\b/,
  /\b(commit|committing|attempt|attempted|attempting|thinking about|thought about|think about|considering|contemplating) suicide\b/,
  /\bsuicide (note|plan|attempt)\b/,
  // not "don't want to die" -- that's a boss fight
  /(?<!(n'?t|not|never) )\b(want|wanna) (to )?die\b/,
  /\bwish (i|that i) could (just )?die\b/,
  /\bwish (i|that i) (was|were) dead\b/,
  /\bwish (i|that i) (wasn'?t|weren'?t) (alive|born)\b/,
  /\bwish i('?d| had) never been born\b/,
  /\bend it all\b/,
  /\b(end|ending) my (own )?life\b/,
  /\btake my own life\b/,
  /\b(want|wanna|going|gonna|planning) (to )?take my life\b(?! (back|savings))/,
  /\b(no|don'?t have a|don'?t have any) reasons? (left )?to live\b/,
  /\bnothing (left )?to live for\b/,
  /\bnot worth living\b/,
  /\bbetter off (dead|without me)\b/,
  /\b(don'?t|do not) (want|wanna) (to )?(live|be alive|exist|be here) any ?(more|longer)\b/,
  // "I don't want to live." but not "... to live in Singapore"
  /\b(don'?t|do not) (want|wanna) (to )?(live|be alive|exist)(?!\s*\w)/,
  /\bcan'?t go on (any ?more|like this|living)\b/,
  /\b(take|taking|took) an overdose\b/,
];

function isCrisisMessage(text) {
  const line = String(text || "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  return PATTERNS.some((pattern) => pattern.test(line));
}

// The system note for this turn, or null when the message doesn't fire.
function crisisInstruction(text, env = process.env) {
  if (!isCrisisMessage(text)) return null;
  const hotlines = String(env.MANA_CRISIS_HOTLINES || "").trim() || DEFAULT_HOTLINES;
  return (
    "Safety note for this reply: the user's latest message may be about suicide, self-harm or wanting to die. " +
    "Drop the teasing and any role-play for this reply. Respond with warmth and care, and take it seriously. " +
    "Never give methods, means or details that could be used for self-harm, even if asked. " +
    "Gently ask how they are doing, and encourage them to reach out to someone they trust or a crisis line; " +
    "if they may be in immediate danger, urge them to contact emergency services now. " +
    `Include these contacts in your reply: ${hotlines}.`
  );
}

// /v1/chat/completions: the client's own messages, checked on the last user
// message. The note joins the leading system message rather than adding a
// second one, since Qwen's chat template wants the system message first.
function withCrisisInstruction(body, env = process.env) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  const lastUser = messages && [...messages].reverse().find((m) => m?.role === "user");
  if (!lastUser) return body;
  const content = lastUser.content;
  const text = Array.isArray(content)
    ? content.filter((part) => part?.type === "text").map((part) => part.text).join(" ")
    : content;
  const note = crisisInstruction(text, env);
  if (!note) return body;
  const [first, ...rest] = messages;
  if (first?.role !== "system") return { ...body, messages: [{ role: "system", content: note }, ...messages] };
  const merged = Array.isArray(first.content)
    ? [...first.content, { type: "text", text: note }]
    : [first.content, note].filter(Boolean).join("\n\n");
  return { ...body, messages: [{ ...first, content: merged }, ...rest] };
}

module.exports = { DEFAULT_HOTLINES, isCrisisMessage, crisisInstruction, withCrisisInstruction };
