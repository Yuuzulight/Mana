// Issue #624: pre-storage secret/PII filter for long-term memory. Screen
// text (UI tree or OCR) and vision descriptions reach memory indirectly --
// they go into the reply prompt, the reply can quote them back, and
// appendTurn stores that reply. Nothing tracks which words came from the
// screen, so acp-memory-store.js runs this over everything it persists
// (turns, their tool-call args, facts) instead: a terminal API key Mana
// read off the screen ends up as "[redacted]" in the session file, the
// search index, the entity index/memory graph, and everything Dream Mode
// later consolidates from them.
//
// Builds on tool-call-log.js's redactText (bearer tokens, sk-/gh*_ keys,
// ?token= query params) with the shapes that matter for memory text.
// Deliberately no "looks high-entropy" rule, for the same reason that file
// gives: hashes and ids are ordinary content.
const { redactText } = require("../tool-call-log");

const REDACTED = "[redacted]";

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // JWT
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, REDACTED],
  // Provider key shapes redactText doesn't cover (sk-ant-..., fine-grained
  // GitHub, Slack, AWS, Google, Hugging Face, GitLab).
  [
    /\b(?:sk-[\w-]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|hf_[A-Za-z0-9]{30,}|glpat-[\w-]{20,})/g,
    REDACTED,
  ],
  // NAME=value / "password: value", the way a terminal env dump or a config
  // file shows them. Keeps the name so the memory still says what was there.
  [/(\b\w*(?:api[_-]?key|secret|token|passw(?:or)?d)\s*[:=]\s*["']?)[^\s"']{8,}/gi, `$1${REDACTED}`],
  // US SSN, Singapore NRIC/FIN
  [/\b\d{3}-\d{2}-\d{4}\b/g, REDACTED],
  [/\b[STFGM]\d{7}[A-Z]\b/g, REDACTED],
];

// ponytail: Luhn is the whole "classifier" -- about 1 in 10 random 13-19
// digit runs (long timestamps, order numbers) passes it and gets redacted
// too. Add an issuer-prefix check if that shows up in real memory.
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

function passesLuhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Strings are redacted; arrays and plain objects (tool-call args) are
// walked; anything else is returned unchanged.
function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSensitive(v)]));
  }
  if (typeof value !== "string") return value;
  let out = redactText(value);
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out.replace(CARD_RE, (match) => (passesLuhn(match.replace(/\D/g, "")) ? REDACTED : match));
}

module.exports = { redactSensitive };
