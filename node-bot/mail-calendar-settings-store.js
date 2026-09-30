// #906: the email and calendar accounts Mana reads, set in Settings >
// Calendar & email (data/mail-calendar.json). Each account's whole config
// -- server, username, app password, feed URL -- is saved as one Windows
// DPAPI blob, like brain.apiKey (#645): only this Windows account on this
// PC can read it. Where DPAPI isn't there it's saved in plain text, said
// out loud. A password may also be a keyring:<target> (Credential Manager)
// or op://... (1Password) reference, as in .env (#793), read when used.
const fs = require("node:fs");
const path = require("node:path");
const dpapi = require("./dpapi");
const { readKeyringSecrets, readOnePasswordSecret } = require("./load-env");

const ENTROPY = "Mana.MailCalendar";
const FIELDS = {
  email: ["host", "port", "user", "password", "mailbox"],
  calendar: ["url", "user", "password"],
};

function resolveReference(value, { readKeyring = readKeyringSecrets, readOnePassword = readOnePasswordSecret } = {}) {
  if (value.startsWith("keyring:")) {
    const [secret] = readKeyring([value.slice("keyring:".length)]);
    if (secret == null) throw new Error(`no Credential Manager entry "${value.slice(8)}"`);
    return secret;
  }
  return value.startsWith("op://") ? readOnePassword(value) : value;
}

function createMailCalendarSettingsStore(options = {}) {
  const filePath = options.filePath || path.join(__dirname, "data", "mail-calendar.json");
  const secrets = options.secrets || {
    protect: (value) => dpapi.protect(value, ENTROPY),
    unprotect: (blob) => dpapi.unprotect(blob, ENTROPY),
  };
  // Decrypting starts PowerShell (~0.5s): one decrypt per saved blob.
  const cache = new Map();

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAll(all) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    fs.renameSync(`${filePath}.tmp`, filePath);
  }

  function isConfigured(kind) {
    return Boolean(readAll()[kind]);
  }

  // The saved config, secrets decrypted but references not resolved.
  function stored(kind) {
    const saved = readAll()[kind];
    if (!saved) return null;
    if (typeof saved === "object") return saved;
    if (!cache.has(saved)) {
      try {
        cache.set(saved, JSON.parse(secrets.unprotect(saved)));
      } catch {
        console.warn(
          `[Mana] The ${kind} settings couldn't be decrypted (another Windows account, a copied profile, or damage). Enter them again in Settings.`,
        );
        cache.set(saved, null);
      }
    }
    return cache.get(saved);
  }

  // For the mail/calendar clients: with the password reference resolved.
  function get(kind) {
    const config = stored(kind);
    if (!config) return null;
    return config.password ? { ...config, password: resolveReference(config.password, options) } : { ...config };
  }

  // partial: any of FIELDS[kind]. A blank or missing password keeps the
  // saved one (Settings never gets it back to show); so does a blank url.
  function set(kind, partial = {}) {
    if (!FIELDS[kind]) throw new Error(`unknown account kind: ${kind}`);
    const next = { ...(stored(kind) || {}) };
    for (const field of FIELDS[kind]) {
      if (partial[field] === undefined) continue;
      const value = String(partial[field] ?? "").trim();
      if (value || !["password", "url"].includes(field)) next[field] = value;
    }
    if (kind === "email") {
      if (!next.host || !next.user || !next.password) throw new Error("email needs a server, username and app password");
      if (!/^[a-z0-9.-]+$/i.test(next.host)) throw new Error("server must be a host name like imap.gmail.com");
      const port = Number(next.port || 993);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be a number like 993");
      next.port = port;
    } else {
      // http only to this PC (a local Radicale): elsewhere it would send the
      // app password in the clear.
      if (!/^(https|webcal):\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(next.url || "")) {
        throw new Error("calendar needs an https:// (or webcal://) address");
      }
      if (!next.user) delete next.password; // a feed URL is its own secret
      else if (!next.password) throw new Error("a CalDAV calendar needs its app password");
    }
    const all = readAll();
    try {
      all[kind] = secrets.protect(JSON.stringify(next));
    } catch (e) {
      console.warn(`[Mana] Couldn't encrypt the ${kind} settings (${e.message}); they're saved in plain text.`);
      all[kind] = next;
    }
    writeAll(all);
    return describe();
  }

  function clear(kind) {
    if (!FIELDS[kind]) throw new Error(`unknown account kind: ${kind}`);
    const all = readAll();
    delete all[kind];
    writeAll(all);
    return describe();
  }

  // What Settings shows: never a password or a feed URL (the URL is the
  // secret for a Google/Outlook feed), just which host is set up.
  function describe() {
    const email = stored("email");
    const calendar = stored("calendar");
    const host = (url) => {
      try {
        return new URL(url).host;
      } catch {
        return "";
      }
    };
    return {
      email: email
        ? { host: email.host, port: email.port, user: email.user, mailbox: email.mailbox || "INBOX", passwordSet: Boolean(email.password) }
        : isConfigured("email")
          ? { unreadable: true }
          : null,
      calendar: calendar
        ? { host: host(calendar.url), user: calendar.user || "", readOnly: !calendar.user, passwordSet: Boolean(calendar.password) }
        : isConfigured("calendar")
          ? { unreadable: true }
          : null,
    };
  }

  return { clear, describe, get, isConfigured, set };
}

module.exports = { createMailCalendarSettingsStore };
