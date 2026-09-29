// Issue #670: a reply sent out through Discord/Telegram/Matrix leaves this
// PC, so scrub what shouldn't go with it: local file paths, the values of
// secret-named environment variables, and credentials in well-known shapes.
// It runs on the finished reply text, so it catches whatever the model or a
// tool result put there.
const { REDACTED, isSecretKey, redactText } = require("./tool-call-log");

const LOCAL_PATH = "[local path]";
// Shorter "secret" env values (a placeholder like "changeme", a flag) would
// blank ordinary words all over a reply.
const MIN_ENV_SECRET_CHARS = 8;

// Credential shapes redactText (tool-call-log.js) doesn't already cover.
const TOKEN_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // OpenAI/Anthropic (sk-proj-..., sk-ant-...). Needs a digit, so prose
  // like "sk-learn-compatible-estimators" isn't mistaken for one.
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google
  /\bhf_[A-Za-z0-9]{30,}/g, // Hugging Face
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, // JWT
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot token
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, // Discord bot token
];

// `api_key = abc123...`, `"password": "hunter22"`: keeps the name, blanks the
// value. The name goes through the same isSecretKey rule as the tool-call
// log, so `token_count: 123456` survives.
const ASSIGNMENT_RE = /\b([A-Za-z][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)([^\s"'`,;]{6,})\3/g;

const FILE_URL_RE = /\bfile:\/\/[^\s"'<>`]+/gi;
// C:\Users\me\file.txt, D:/models/x.gguf, C:\\escaped\\json. Directory names
// may contain spaces ("Program Files"); the last component may not, so a
// path at the end of a sentence doesn't swallow the words after it.
const SEG = String.raw`[^\s\\/"'<>|?*` + "`" + String.raw`:]+`;
const WINDOWS_PATH_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/]+(?:${SEG}(?: ${SEG})*[\\/]+)*(?:${SEG})?`,
  "g",
);
const UNC_PATH_RE = /\\\\[^\s\\/"'<>|?*]+\\[^\s"'<>|]*/g;
// Absolute POSIX paths under roots that hold user or machine data, and ~/.
// The lookbehind skips the path part of a URL (example.com/home/...).
const POSIX_PATH_RE =
  /(?<![\w.~:/-])(?:~|\/(?:home|Users|root|etc|var|tmp|private|mnt|opt|srv|Volumes))\/[^\s"'<>`]*/g;

function secretEnvValues(env) {
  return Object.entries(env || {})
    .filter(([name, value]) => isSecretKey(name) && typeof value === "string" && value.length >= MIN_ENV_SECRET_CHARS)
    .map(([, value]) => value)
    // Longest first, so one secret containing another is removed whole.
    .sort((a, b) => b.length - a.length);
}

function sanitizeBridgeOutput(text, { env = process.env } = {}) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const value of secretEnvValues(env)) out = out.split(value).join(REDACTED);
  for (const re of TOKEN_RES) out = out.replace(re, REDACTED);
  // Before the assignment pass: "Authorization: Bearer <token>" would
  // otherwise lose only the word "Bearer" and keep the token.
  out = redactText(out);
  out = out.replace(ASSIGNMENT_RE, (match, name, sep, quote) =>
    isSecretKey(name) ? `${name}${sep}${quote}${REDACTED}${quote}` : match,
  );
  return out
    .replace(FILE_URL_RE, LOCAL_PATH)
    // Drive paths first: the "\\Users\\..." in a JSON-escaped C:\\Users\\...
    // would otherwise look like a UNC share and leave the "C:" behind.
    .replace(WINDOWS_PATH_RE, LOCAL_PATH)
    .replace(UNC_PATH_RE, LOCAL_PATH)
    .replace(POSIX_PATH_RE, LOCAL_PATH);
}

module.exports = { LOCAL_PATH, sanitizeBridgeOutput };
