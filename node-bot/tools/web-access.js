// Local-first web access for Mana: search via a local SearXNG instance,
// Wikipedia lookups (Wikipedia's own free REST API, no local service needed),
// and reading a specific page the user points her at. Nothing here calls a
// paid API; SearXNG is the only piece that needs a local service running
// (see docs/web_access_setup.md).
const dns = require("node:dns").promises;
const net = require("node:net");
const { URL } = require("node:url");
const { ValidationError } = require("../request-validation");
const { isLocalOnly, refuseIfLocalOnly } = require("../local-only");
const { GAME_WIKI_SOURCE, wrapUntrusted } = require("../ai/untrusted-content");
const { browserReason, extractMainContent } = require("./html-extract");

const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8890";
const FETCH_TIMEOUT_MS = 15000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024; // stop reading a page past this size
// #1140: how much page Markdown we hand to the prompt: about 2-2.5k tokens,
// a sixth of a 9B model's 16k context.
const MAX_PAGE_TEXT_CHARS = 8000;
const READER_TEXT_CHARS = 60000; // the reader view shows the whole article
const READER_MAX_IMAGES = 12;
const READER_IMAGE_BYTES = 512 * 1024;
const READER_IMAGE_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 5;
const GAME_WIKI_PAGE_CHARS = 2000; // #908: a voice answer mid-game needs little
const GAME_WIKI_BUDGET_MS = 5000; // #945: the whole mid-game lookup; past it she answers without the wiki
const GAME_WIKI_TYPED_BUDGET_MS = FETCH_TIMEOUT_MS; // #963: a typed question can wait longer

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

const HTML_ENTITY_DECODE = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
};

function htmlToText(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|li|tr|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    // Decoding entities in one pass (instead of chained replaces, where an
    // earlier rule's output like "&amp;" -> "&" can feed a later rule like
    // "&lt;" -> "<") avoids double-unescaping "&amp;lt;" into a literal "<".
    .replace(/&(nbsp|amp|lt|gt|quot|#0?39);/gi, (match, entity) => {
      const key = entity.toLowerCase();
      return key in HTML_ENTITY_DECODE ? HTML_ENTITY_DECODE[key] : "'";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).slice(0, 200) : "";
}

// --- Page fetch (manual redirect handling for the SSRF guard above) ----

// Every hop is re-checked by assertPublicUrl. The last response, and the
// URL it came from.
async function guardedFetch(rawUrl, accept, timeoutMs) {
  let target = await assertPublicUrl(rawUrl);
  let response = null;
  // #945: a caller's timeoutMs covers every redirect hop together.
  const budget = timeoutMs ? AbortSignal.timeout(timeoutMs) : null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    response = await fetch(target.href, {
      redirect: "manual",
      headers: { "User-Agent": "Mana-local-assistant/1.0", Accept: accept },
      signal: budget || AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) break;
      target = await assertPublicUrl(new URL(location, target).href);
      continue;
    }
    break;
  }
  return { response, url: target.href };
}

// The body's bytes, reading no further than maxBytes past (over: it was cut).
async function readBody(response, maxBytes) {
  if (!response.body) {
    const bytes = Buffer.from(typeof response.arrayBuffer === "function" ? await response.arrayBuffer() : await response.text());
    return { bytes, over: bytes.length > maxBytes };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytesRead += value.length;
    if (bytesRead > maxBytes) {
      try {
        await reader.cancel();
      } catch (e) {}
      return { bytes: Buffer.concat(chunks), over: true };
    }
  }
  return { bytes: Buffer.concat(chunks), over: false };
}

// At a paragraph break when there's one in the budget's last 30%.
function cutText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const at = text.lastIndexOf("\n\n", maxChars);
  return text.slice(0, at > maxChars * 0.7 ? at : maxChars).trimEnd();
}

// #1140: a page as Markdown. Markdown first (some sites serve it when
// asked); otherwise the page's main content, extracted Readability-style
// (tools/html-extract.js), not its menus. needsBrowser says why the
// browser has to open it instead (little to read without its scripts, or
// a sign-in), else null. reader: the Browser tool's reader view -- the
// whole article, with its images fetched here as data: URLs.
async function fetchPage(rawUrl, options = {}) {
  const { response, url } = await guardedFetch(rawUrl, "text/markdown, text/html;q=0.9", options.timeoutMs);
  if (!response || !response.ok) {
    throw new Error(`Failed to fetch page (${response ? response.status : "no response"})`);
  }

  const contentType = response.headers.get("content-type") || "";
  const markdownServed = /text\/(x-)?markdown/i.test(contentType);
  if (!markdownServed && !/text\/html|application\/xhtml/i.test(contentType)) {
    throw new ValidationError(`url is not an HTML page (content-type: ${contentType || "unknown"})`);
  }

  const body = (await readBody(response, MAX_PAGE_BYTES)).bytes.toString("utf8");
  let title;
  let text;
  let needsBrowser = null;
  if (markdownServed) {
    text = body.replace(/\r\n/g, "\n").trim();
    title = (text.match(/^#\s+(.+)$/m) || [])[1] || "";
  } else {
    const page = extractMainContent(body, url);
    text = page.markdown;
    title = extractTitle(body) || page.h1;
    needsBrowser = browserReason(body, text);
  }

  const maxChars = Number(options.maxChars || (options.reader ? READER_TEXT_CHARS : MAX_PAGE_TEXT_CHARS));
  const page = {
    url,
    title: title.trim().slice(0, 200),
    text: cutText(text, maxChars),
    truncated: text.length > maxChars,
    needsBrowser,
  };
  if (options.reader) {
    page.images = await fetchImages(page.text, url);
  }
  return page;
}

// #1140: the reader view's images, fetched here behind the same SSRF guard
// so Folio never touches the network: data: URLs keyed by the src as the
// Markdown writes it. One that fails, is too big or isn't a plain image
// is left out (the reader shows its alt text).
async function fetchImages(markdown, pageUrl) {
  const srcs = [...new Set([...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]))].slice(0, READER_MAX_IMAGES);
  const images = {};
  await Promise.all(
    srcs.map(async (src) => {
      try {
        const { response } = await guardedFetch(new URL(src, pageUrl).href, "image/png, image/jpeg, image/gif, image/webp", READER_IMAGE_TIMEOUT_MS);
        const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!response.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return;
        const { bytes, over } = await readBody(response, READER_IMAGE_BYTES);
        if (!over) images[src] = `data:${type};base64,${bytes.toString("base64")}`;
      } catch (e) {} // left out: its alt text shows
    }),
  );
  return images;
}

// --- Web search via local SearXNG --------------------------------------

async function searchWeb(query, options = {}) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    throw new ValidationError("query is required");
  }
  // #670: SearXNG is local, but it searches the internet.
  refuseIfLocalOnly("web search", options.env);
  const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 10);
  const base = getSearxngUrl(options.env);
  // #907: timeRange "day"/"week" keeps a news search to recent results.
  const timeRange = ["day", "week"].includes(options.timeRange) ? `&time_range=${options.timeRange}` : "";
  const url = `${base}/search?format=json&q=${encodeURIComponent(cleanQuery)}${timeRange}`;

  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs || FETCH_TIMEOUT_MS) });
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

// #908: a question while a game with a known wiki is up (game-wikis.js).
// ponytail: shape rule, so "what do you think?" mid-game searches the wiki
// too; the prompt says to use it only when it helps.
function textLooksLikeGameQuestion(text) {
  const clean = String(text || "").trim();
  if (/\bwikipedia\b/i.test(clean) || clean.split(/\s+/).length < 3) return false;
  return (
    /\?$/.test(clean) ||
    /^(?:(?:hey|ok|okay)\s+)?(?:mana\W+)?(?:how|where|what|which|when|who|why|is there|can i|do i|should i)\b/i.test(clean) ||
    /\bwiki\b/i.test(clean) ||
    textLooksLikeSearchQuestion(clean)
  );
}

// Searches only the game's wiki sites and reads the top hit, kept short for
// a voice answer mid-game. Null when the wiki has nothing, so the turn falls
// back to the normal paths.
async function buildGameWikiContext(text, game, env, typed, sourcesOut = null) {
  if (isLocalOnly(env)) return null; // implicit lookup: stay quiet, not a failure note every turn
  const onWiki = (url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return game.sites.some((site) => host === site || host.endsWith(`.${site}`));
    } catch (e) {
      return false;
    }
  };
  const question = extractSearchQuery(text).replace(/^(?:(?:hey|ok|okay)\s+)?mana\W+/i, "");
  const query = `${question} ${game.sites.map((site) => `site:${site}`).join(" OR ")}`;
  const budgetMs = typed ? GAME_WIKI_TYPED_BUDGET_MS : GAME_WIKI_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const hits = (await searchWeb(query, { env, limit: 10, timeoutMs: budgetMs })).filter((r) => onWiki(r.url)).slice(0, 3);
  if (!hits.length) return null;
  // Out of time: the snippets alone.
  const page = await fetchPage(hits[0].url, { maxChars: GAME_WIKI_PAGE_CHARS, timeoutMs: Math.max(1, deadline - Date.now()) }).catch((e) => {
    console.warn(`${game.name} wiki page skipped:`, e.message);
    return null;
  });
  if (Array.isArray(sourcesOut)) {
    hits.forEach((r, i) => {
      sourcesOut.push({
        index: i + 1,
        title: r.title,
        url: r.url,
        text: (r.snippet || "") + (i === 0 && page?.text ? "\n" + page.text : ""),
      });
    });
  }
  return [
    `I'm playing ${game.name} and asking${typed ? "" : " by voice"}: answer in one or two short sentences from the wiki results below, citing claims with numbered markers like [1], and say so if they don't cover it. If the answer depends on what's on my screen and you have vision__look, look first.`,
    "",
    wrapUntrusted(
      GAME_WIKI_SOURCE,
      [
        ...hits.map((r, i) => `[${i + 1}] ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`),
        page ? `\nTop result page text:\n${page.text}` : null,
      ].filter((line) => line !== null).join("\n"),
    ),
  ].join("\n") + "\n\n";
}

// game: { name, sites } for the game I'm playing (#908), or null. typed:
// the turn was typed, not spoken (#963). sourcesOut: array to collect
// cited web sources for inline verification (#1329).
async function buildWebContextForPrompt(text, env = process.env, game = null, typed = false, sourcesOut = null) {
  if (!isWebAccessEnabled(env)) {
    return "";
  }
  const clean = String(text || "");

  const url = extractFirstUrl(clean);
  if (url) {
    try {
      const page = await fetchPage(url);
      if (Array.isArray(sourcesOut)) {
        sourcesOut.push({
          index: 1,
          title: page.title || url,
          url: page.url,
          text: page.text,
        });
      }
      const lines = [
        `URL: ${page.url}`,
        page.title ? `Title: ${page.title}` : null,
        "",
        page.text,
        page.truncated ? "\n[page content truncated]" : null,
      ].filter(Boolean);
      // #1140: the escalation to the browser, in Mana's own words outside the frame.
      const escalate = page.needsBrowser
        ? `[This page needs a browser (${page.needsBrowser}). If you have browser_automation__navigate, open it there instead.]\n\n`
        : "";
      const instruction = page.needsBrowser
        ? ""
        : "When answering from the web page above, cite claims with numbered markers like [1]. Only cite facts directly supported by the text.\n\n";
      return `Page Mana was asked to read:\n${wrapUntrusted("web page", lines.join("\n"))}\n\n${escalate}${instruction}`;
    } catch (e) {
      return `[Mana tried to open ${url} but it failed: ${e.message}]\n\n`;
    }
  }

  if (game && textLooksLikeGameQuestion(clean)) {
    try {
      const context = await buildGameWikiContext(clean, game, env, typed, sourcesOut);
      if (context) return context;
    } catch (e) {
      // Not a note on every mid-game question: an explicit search below reports its own failure.
      console.warn(`${game.name} wiki lookup failed:`, e.message);
    }
  }

  if (textLooksLikeWikiQuestion(clean)) {
    try {
      const entry = await wikiLookup(extractWikiTerm(clean));
      if (!entry) {
        return "";
      }
      if (Array.isArray(sourcesOut)) {
        sourcesOut.push({
          index: 1,
          title: entry.title,
          url: entry.url,
          text: entry.extract,
        });
      }
      const lookup = [`[1] ${entry.title}`, `URL: ${entry.url}`, "", entry.extract].join("\n");
      return `Wikipedia lookup:\n${wrapUntrusted("Wikipedia", lookup)}\n\nWhen answering from Wikipedia, cite claims with numbered markers like [1]. Only cite facts directly supported by the text.\n\n`;
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
      if (Array.isArray(sourcesOut)) {
        results.forEach((r, i) => {
          sourcesOut.push({
            index: i + 1,
            title: r.title,
            url: r.url,
            text: r.snippet || "",
          });
        });
      }
      const lines = results.map(
        (r, i) => `[${i + 1}] ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`,
      );
      return `Web search results:\n${wrapUntrusted("web search", lines.join("\n"))}\n\nWhen answering from the web search results, cite claims with numbered markers like [1], matching the source number. Only cite facts directly supported by the source text.\n\n`;
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
