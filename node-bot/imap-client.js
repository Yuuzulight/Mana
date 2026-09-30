// #906: a small read-only IMAP client for Mana's email tools -- no npm
// dependency. One TLS connection per question (connect, LOGIN, EXAMINE,
// SEARCH/FETCH, LOGOUT), so nothing stays resident between asks. EXAMINE
// opens the mailbox read-only and every fetch is BODY.PEEK, so reading
// never marks a message as read.
//
// Works with any server that takes an app password over implicit TLS (993):
// Gmail, iCloud, Fastmail, Yahoo, most hosts. Outlook.com/Microsoft 365
// dropped password logins for IMAP; they need OAuth (not built yet).
const tls = require("node:tls");

const TIMEOUT_MS = 20000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A quoted IMAP string. Non-ASCII goes as a literal instead (see command()).
function quote(value) {
  const s = String(value);
  if (/[\r\n\0]/.test(s)) throw new Error("line breaks aren't allowed here");
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

// Opens a session, runs fn(session), always logs out. connect is swappable
// so tests can point it at a plain local socket.
async function withImap(account, fn, { connect = tls.connect } = {}) {
  const { host, port = 993, user, password } = account;
  if (!host || !user || !password) throw new Error("email isn't set up (Settings > Calendar & email)");
  const socket = connect({ host, port: Number(port) || 993, servername: host });
  let buffer = Buffer.alloc(0);
  let waiter = null;
  let failure = null;
  const fail = (e) => {
    failure = failure || e;
    if (waiter) waiter();
  };
  socket.setTimeout(TIMEOUT_MS, () => {
    fail(new Error("the mail server stopped answering"));
    socket.destroy();
  });
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (waiter) waiter();
  });
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("the mail server closed the connection")));

  // One response: its text with each literal swapped for \0<index>\0, and
  // the literals' raw bytes. null until a whole response has arrived.
  function takeResponse() {
    let text = "";
    const literals = [];
    let pos = 0;
    for (;;) {
      const eol = buffer.indexOf("\r\n", pos);
      if (eol < 0) return null;
      const line = buffer.toString("latin1", pos, eol);
      const lit = /\{(\d+)\+?\}$/.exec(line);
      if (!lit) {
        buffer = buffer.subarray(eol + 2);
        return { text: text + line, literals };
      }
      const size = Number(lit[1]);
      if (buffer.length < eol + 2 + size) return null;
      literals.push(buffer.subarray(eol + 2, eol + 2 + size));
      text += `${line.slice(0, lit.index)}\0${literals.length - 1}\0`;
      pos = eol + 2 + size;
    }
  }

  async function next() {
    for (;;) {
      if (failure) throw failure;
      const response = takeResponse();
      if (response) return response;
      await new Promise((resolve) => (waiter = resolve));
      waiter = null;
    }
  }

  let tagCount = 0;
  // parts: strings joined with spaces; a { literal } part is sent as a
  // synchronizing literal (waits for the server's "+" first).
  async function command(...parts) {
    const tag = `A${++tagCount}`;
    let line = tag;
    for (const part of parts) {
      if (typeof part === "string") {
        line += ` ${part}`;
        continue;
      }
      const bytes = Buffer.from(part.literal, "utf8");
      socket.write(`${line} {${bytes.length}}\r\n`);
      const cont = await next();
      if (!cont.text.startsWith("+")) throw new Error(`mail server refused: ${cont.text.slice(0, 200)}`);
      socket.write(bytes);
      line = "";
    }
    socket.write(`${line}\r\n`);
    const untagged = [];
    for (;;) {
      const response = await next();
      if (response.text.startsWith(`${tag} `)) {
        const status = response.text.slice(tag.length + 1);
        if (!/^OK\b/i.test(status)) throw new Error(`mail server said: ${status.slice(0, 200)}`);
        return untagged;
      }
      untagged.push(response);
    }
  }

  try {
    const greeting = await next();
    if (!/^\* (OK|PREAUTH)\b/i.test(greeting.text)) throw new Error(`mail server said: ${greeting.text.slice(0, 200)}`);
    if (!/^\* PREAUTH/i.test(greeting.text)) {
      await command("LOGIN", quote(user), quote(password)).catch((e) => {
        throw new Error(`email login failed -- check the server, username and app password (${e.message})`);
      });
    }
    await command("EXAMINE", quote(account.mailbox || "INBOX"));
    return await fn({ command });
  } finally {
    // Best effort: the answer is already in hand. end() still flushes it.
    if (failure) socket.destroy();
    else socket.end(`A${++tagCount} LOGOUT\r\n`);
  }
}

function imapDate(ms) {
  const d = new Date(ms);
  return `${d.getDate()}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

function searchUids(untagged) {
  const line = untagged.find((r) => /^\* SEARCH\b/i.test(r.text));
  return line ? line.text.slice(8).trim().split(/\s+/).filter(Boolean).map(Number) : [];
}

// ---- MIME: just enough to pull readable text out of a message ----

function decodeBytes(bytes, charset) {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// RFC 2047 encoded words: =?utf-8?B?...?= / =?iso-8859-1?Q?...?=
function decodeHeader(value) {
  return String(value || "")
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
      const bytes =
        enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))),
              "latin1",
            );
      return decodeBytes(bytes, charset);
    })
    .trim();
}

// Raw header block (latin1 string of bytes) -> { lowercased name: value }.
function parseHeaders(raw) {
  const headers = {};
  for (const line of raw.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([^:\s]+):\s*(.*)$/.exec(line);
    if (m && !(m[1].toLowerCase() in headers)) headers[m[1].toLowerCase()] = m[2];
  }
  return headers;
}

function param(headerValue, name) {
  const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(headerValue || "");
  return m ? m[1] ?? m[2] : "";
}

function htmlToText(html) {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, "&");
}

// headers + body (latin1 string of the raw bytes) -> { plain, html } text.
// Attachments are skipped; a body cut short by the fetch limit still
// decodes as far as it goes.
function mimeText(headers, body, depth = 0) {
  const type = (headers["content-type"] || "text/plain").toLowerCase();
  if (type.startsWith("multipart/") && depth < 5) {
    const boundary = param(headers["content-type"], "boundary");
    if (!boundary) return {};
    const found = {};
    for (const part of body.split(`--${boundary}`).slice(1)) {
      const split = part.search(/\r?\n\r?\n/);
      if (split < 0) continue;
      const sub = mimeText(parseHeaders(part.slice(0, split)), part.slice(split).replace(/^\r?\n\r?\n/, ""), depth + 1);
      found.plain = found.plain || sub.plain;
      found.html = found.html || sub.html;
    }
    return found;
  }
  const isHtml = type.startsWith("text/html");
  if (!type.startsWith("text/plain") && !isHtml) return {};
  if (/attachment/i.test(headers["content-disposition"] || "")) return {};
  const encoding = (headers["content-transfer-encoding"] || "").trim().toLowerCase();
  let bytes;
  if (encoding === "base64") bytes = Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  else if (encoding === "quoted-printable") {
    bytes = Buffer.from(
      body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))),
      "latin1",
    );
  } else bytes = Buffer.from(body, "latin1");
  const text = decodeBytes(bytes, param(headers["content-type"], "charset"));
  return isHtml ? { html: htmlToText(text) } : { plain: text };
}

function tidy(text, max) {
  const s = String(text || "")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

// A FETCH item's value (latin1 string of its bytes): a literal, a quoted
// string, or null (NIL). nameRe matches the item name the server echoes.
function fetchItem(response, nameRe) {
  const at = new RegExp(`${nameRe.source} `, "i").exec(response.text);
  if (!at) return null;
  const rest = response.text.slice(at.index + at[0].length);
  const lit = /^\0(\d+)\0/.exec(rest);
  if (lit) return response.literals[Number(lit[1])].toString("latin1");
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
  return quoted ? quoted[1].replace(/\\(.)/g, "$1") : null;
}

const HEADER_FIELDS = "FROM TO SUBJECT DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING";

async function fetchMessages({ command }, uids, bodyBytes, textChars) {
  if (!uids.length) return [];
  const untagged = await command(
    "UID FETCH",
    uids.join(","),
    `(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})] BODY.PEEK[TEXT]<0.${bodyBytes}>)`,
  );
  const messages = [];
  for (const response of untagged) {
    if (!/^\* \d+ FETCH\b/i.test(response.text)) continue;
    const uid = Number(/\bUID (\d+)/i.exec(response.text)?.[1]);
    if (!uids.includes(uid)) continue;
    // Raw UTF-8 headers (SMTPUTF8) decode as such; RFC 2047 words later.
    const headers = parseHeaders(Buffer.from(fetchItem(response, /BODY\[HEADER[^\]]*\]/) || "", "latin1").toString("utf8"));
    const body = fetchItem(response, /BODY\[TEXT\](?:<0>)?/) || "";
    const text = mimeText(headers, body);
    const received = Date.parse(/INTERNALDATE "([^"]+)"/i.exec(response.text)?.[1] || headers.date || "");
    messages.push({
      id: uid,
      from: decodeHeader(headers.from),
      to: decodeHeader(headers.to),
      subject: decodeHeader(headers.subject),
      receivedAt: Number.isNaN(received) ? null : received,
      unread: !/\\Seen\b/i.test(/FLAGS \(([^)]*)\)/i.exec(response.text)?.[1] || ""),
      text: tidy(text.plain || text.html, textChars),
    });
  }
  return messages.sort((a, b) => b.id - a.id);
}

// Newest first. sinceMs is day-granular on the server (IMAP SINCE), then
// trimmed to the hour here.
async function recentMail(account, { sinceMs, limit = 15, unreadOnly = false, snippetChars = 300 }, options) {
  return withImap(
    account,
    async (session) => {
      const criteria = [`SINCE ${imapDate(sinceMs)}`, ...(unreadOnly ? ["UNSEEN"] : [])];
      const uids = searchUids(await session.command("UID SEARCH", ...criteria)).slice(-limit);
      const messages = await fetchMessages(session, uids, 4000, snippetChars);
      return messages.filter((m) => m.receivedAt === null || m.receivedAt >= sinceMs);
    },
    options,
  );
}

// IMAP TEXT search: headers and body, server-side. Newest first.
async function searchMail(account, { query, limit = 10, snippetChars = 300 }, options) {
  const words = String(query || "").trim();
  if (!words) throw new Error("query is required");
  return withImap(
    account,
    async (session) => {
      const ascii = /^[\x20-\x7e]*$/.test(words);
      const untagged = ascii
        ? await session.command("UID SEARCH TEXT", quote(words))
        : await session.command("UID SEARCH CHARSET UTF-8 TEXT", { literal: words });
      const uids = searchUids(untagged).slice(-limit);
      return fetchMessages(session, uids, 4000, snippetChars);
    },
    options,
  );
}

async function readMail(account, { id, textChars = 4000 }, options) {
  const uid = Number(id);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error("id must be a message id from email__recent or email__search");
  return withImap(
    account,
    async (session) => (await fetchMessages(session, [uid], 16000, textChars))[0] || null,
    options,
  );
}

// Settings' Test button: log in and open the mailbox, nothing else.
async function checkMail(account, options) {
  return withImap(account, async () => true, options);
}

module.exports = { checkMail, readMail, recentMail, searchMail };
