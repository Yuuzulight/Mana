// Local-first web access for Mana: search via a local SearXNG instance,
// Wikipedia lookups (Wikipedia's own free REST API, no local service needed),
// and reading a specific page the user points her at. Nothing here calls a
// paid API; SearXNG is the only piece that needs a local service running
// (see docs/web_access_setup.md).
const dns = require("node:dns").promises;
const net = require("node:net");
const { URL } = require("node:url");
const { ValidationError } = require("../request-validation");

const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8890";
const FETCH_TIMEOUT_MS = 15000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024; // stop reading a page past this size
const MAX_PAGE_TEXT_CHARS = 6000; // how much page text we hand to the prompt
const MAX_REDIRECTS = 5;

function isWebAccessEnabled(env = process.env) {
  return env.MANA_WEB_ACCESS_ENABLED !== "0";
}

function getSearxngUrl(env = process.env) {
  return (env.SEARXNG_URL || DEFAULT_SEARXNG_URL).replace(/\/+$/, "");
}

// --- SSRF guard --------------------------------------------------------
// The user points Mana at a URL, but that page (or a redirect from it)
// could still target an internal service, so every hop is re-validated
// before it is followed.

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    return false;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
    return false;
  }
  return true; // not a recognizable IP -> fail closed
}

async function isPrivateOrUnresolvableHost(hostname) {
  if (net.isIP(hostname)) {
    return isPrivateIp(hostname);
  }
  try {
    const records = await dns.lookup(hostname, { all: true });
    return records.length === 0 || records.some((r) => isPrivateIp(r.address));
  } catch (e) {
    return true; // DNS failure -> fail closed
  }
}

async function assertPublicUrl(rawUrl, label = "url") {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    throw new ValidationError(`${label} is not a valid URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ValidationError(`${label} must be http or https`);
  }
  if (await isPrivateOrUnresolvableHost(parsed.hostname)) {
    throw new ValidationError(
      `${label} resolves to a private, loopback, or link-local address and cannot be fetched`,
    );
  }
  return parsed;
}

// --- HTML -> text (no HTML parser dependency in this project) ----------

function htmlToText(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|li|tr|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).slice(0, 200) : "";
}

// --- Page fetch (manual redirect handling for the SSRF guard above) ----

async function fetchPage(rawUrl, options = {}) {
  let target = await assertPublicUrl(rawUrl);
  let lastResponse = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    lastResponse = await fetch(target.href, {
      redirect: "manual",
      headers: { "User-Agent": "Mana-local-assistant/1.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if ([301, 302, 303, 307, 308].includes(lastResponse.status)) {
      const location = lastResponse.headers.get("location");
      if (!location) break;
      target = await assertPublicUrl(new URL(location, target).href);
      continue;
    }
    break;
  }

  if (!lastResponse || !lastResponse.ok) {
    throw new Error(
      `Failed to fetch page (${lastResponse ? lastResponse.status : "no response"})`,
    );
  }

  const contentType = lastResponse.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    throw new ValidationError(`url is not an HTML page (content-type: ${contentType || "unknown"})`);
  }

  const reader = lastResponse.body ? lastResponse.body.getReader() : null;
  let html = "";
  if (reader) {
    const decoder = new TextDecoder("utf-8");
    let bytesRead = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.length;
      html += decoder.decode(value, { stream: true });
      if (bytesRead > MAX_PAGE_BYTES) {
        try {
          await reader.cancel();
        } catch (e) {}
        break;
      }
    }
  } else {
    html = await lastResponse.text();
  }

  const maxChars = Number(options.maxChars || MAX_PAGE_TEXT_CHARS);
  const text = htmlToText(html).slice(0, maxChars);
  return {
    url: target.href,
    title: extractTitle(html),
    text,
    truncated: htmlToText(html).length > maxChars,
  };
}

// --- Web search via local SearXNG --------------------------------------

async function searchWeb(query, options = {}) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    throw new ValidationError("query is required");
  }
  const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 10);
  const base = getSearxngUrl(options.env);
  const url = `${base}/search?format=json&q=${encodeURIComponent(cleanQuery)}`;

  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(
      `Could not reach local SearXNG at ${base} (${e.message}). See docs/web_access_setup.md.`,
    );
  }
  if (!resp.ok) {
    throw new Error(`SearXNG search failed (${resp.status})`);
  }
  const data = await resp.json();
  const results = Array.isArray(data.results) ? data.results : [];
  return results.slice(0, limit).map((r) => ({
    title: String(r.title || "").trim(),
    url: String(r.url || "").trim(),
    snippet: String(r.content || "").trim(),
  }));
}

// --- Wikipedia lookup (Wikipedia's own free public API) ----------------

async function wikiLookup(term, options = {}) {
  const cleanTerm = String(term || "").trim();
  if (!cleanTerm) {
    throw new ValidationError("term is required");
  }
  const searchUrl = `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(cleanTerm)}&limit=1`;
  const searchResp = await fetch(searchUrl, {
    headers: { "User-Agent": "Mana-local-assistant/1.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!searchResp.ok) {
    throw new Error(`Wikipedia search failed (${searchResp.status})`);
  }
  const searchData = await searchResp.json();
  const hit = (searchData.pages || [])[0];
  if (!hit) {
    return null;
  }

  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.key)}`;
  const summaryResp = await fetch(summaryUrl, {
    headers: { "User-Agent": "Mana-local-assistant/1.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!summaryResp.ok) {
    throw new Error(`Wikipedia summary failed (${summaryResp.status})`);
  }
  const summary = await summaryResp.json();
  const maxChars = Number(options.maxChars || 1500);
  return {
    title: summary.title || hit.title,
    extract: String(summary.extract || "").slice(0, maxChars),
    url:
      (summary.content_urls && summary.content_urls.desktop && summary.content_urls.desktop.page) ||
      `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.key)}`,
  };
}

// --- Intent detection + prompt context builders -------------------------

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')]+/i;

function extractFirstUrl(text) {
  const match = String(text || "").match(URL_PATTERN);
  return match ? match[0].replace(/[.,!?;:]+$/, "") : null;
}

function textLooksLikeWikiQuestion(text) {
  return /\b(wiki|wikipedia)\b/i.test(String(text || ""));
}

function textLooksLikeSearchQuestion(text) {
  const clean = String(text || "");
  if (extractFirstUrl(clean)) return false; // handled as a page-read instead
  return /\b(search (the )?(web|internet|online) for|search for|google|look up|look that up|find (me )?(information|info) (on|about)|what'?s (the latest|new|going on) with|latest news (on|about))\b/i.test(
    clean,
  );
}

function extractSearchQuery(text) {
  const clean = String(text || "").trim();
  const match = clean.match(
    /\b(?:search (?:the )?(?:web|internet|online) for|search for|google|look up|look that up|find (?:me )?(?:information|info) (?:on|about)|latest news (?:on|about))\s+(.+)$/i,
  );
  const query = (match ? match[1] : clean).replace(/[?.!]+$/, "").trim();
  return query || clean;
}

function extractWikiTerm(text) {
  const clean = String(text || "").trim();
  const match = clean.match(
    /\b(?:wiki(?:pedia)?(?: page| article)? (?:for|on|about)?|look up)\s+(.+)$/i,
  );
  const term = (match ? match[1] : clean).replace(/[?.!]+$/, "").trim();
  return term || clean;
}

async function buildWebContextForPrompt(text, env = process.env) {
  if (!isWebAccessEnabled(env)) {
    return "";
  }
  const clean = String(text || "");

  const url = extractFirstUrl(clean);
  if (url) {
    try {
      const page = await fetchPage(url);
      const lines = [
        "Page Mana was asked to read:",
        `URL: ${page.url}`,
        page.title ? `Title: ${page.title}` : null,
        "",
        page.text,
        page.truncated ? "\n[page content truncated]" : null,
      ].filter(Boolean);
      return lines.join("\n") + "\n\n";
    } catch (e) {
      return `[Mana tried to open ${url} but it failed: ${e.message}]\n\n`;
    }
  }

  if (textLooksLikeWikiQuestion(clean)) {
    try {
      const entry = await wikiLookup(extractWikiTerm(clean));
      if (!entry) {
        return "";
      }
      return [
        "Wikipedia lookup:",
        `Title: ${entry.title}`,
        `URL: ${entry.url}`,
        "",
        entry.extract,
      ].join("\n") + "\n\n";
    } catch (e) {
      return `[Mana tried a Wikipedia lookup but it failed: ${e.message}]\n\n`;
    }
  }

  if (textLooksLikeSearchQuestion(clean)) {
    try {
      const results = await searchWeb(extractSearchQuery(clean));
      if (!results.length) {
        return "";
      }
      const lines = results.map(
        (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
      );
      return ["Web search results:", ...lines].join("\n") + "\n\n";
    } catch (e) {
      return `[Mana tried a web search but it failed: ${e.message}]\n\n`;
    }
  }

  return "";
}

module.exports = {
  MAX_PAGE_TEXT_CHARS,
  assertPublicUrl,
  buildWebContextForPrompt,
  extractFirstUrl,
  extractSearchQuery,
  extractWikiTerm,
  fetchPage,
  getSearxngUrl,
  htmlToText,
  isPrivateIp,
  isWebAccessEnabled,
  searchWeb,
  textLooksLikeSearchQuestion,
  textLooksLikeWikiQuestion,
  wikiLookup,
};
