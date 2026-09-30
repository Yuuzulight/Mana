// #1140: the readable part of a web page as compact Markdown, with no
// browser and no HTML parser dependency. A small forgiving tree builder,
// then Readability-style: drop the junk (scripts, styles, nav, footers,
// ads, forms' controls, hidden things), pick the main content (<main>, a
// single <article>, else the block with the most paragraph text and the
// fewest links), and write it as headings, paragraphs, lists, tables,
// links and images. Links and images on the page's own site are written
// as paths ("/wiki/Tokyo") to spare the model's budget; they resolve
// against the page's URL.

const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const MAX_DEPTH = 400;
// Dropped with everything inside them.
const DROP_TAGS = new Set("head nav footer aside button select dialog svg math iframe object embed canvas video audio".split(" "));
const DROP_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "dialog", "alert", "menu", "menubar"]);
// A class or id word that marks page furniture, not content.
const JUNK_WORD = /^(nav|navbar|navigation|navbox|menu|menubar|footer|sidebar|breadcrumbs?|cookies?|consent|banner|ads?|advert|advertisement|adsbygoogle|promo|sponsored|share|sharing|social|related|comments?|popup|modal|newsletter|subscribe|editsection|catlinks|toc|noprint|skip)$/;
const BLOCK = new Set("address article aside blockquote caption center dd details div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody thead tfoot tr td th ul".split(" "));
// Opening one of these closes an open <p> (the parser's implied end tag).
const CLOSES_P = new Set("address article aside blockquote div dl fieldset figure footer form h1 h2 h3 h4 h5 h6 header hr main nav ol p pre section table ul".split(" "));
// Opening the key closes an open sibling of these, unless a scope comes first.
const IMPLIED = {
  li: [["li"], ["ul", "ol"]],
  dt: [["dt", "dd"], ["dl"]],
  dd: [["dt", "dd"], ["dl"]],
  tr: [["tr", "td", "th"], ["table", "thead", "tbody", "tfoot"]],
  td: [["td", "th"], ["tr", "table"]],
  th: [["td", "th"], ["tr", "table"]],
  option: [["option"], ["select"]],
};

const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®",
  trade: "™", middot: "·", bull: "•", times: "×", deg: "°", shy: "",
};

// One pass, so "&amp;lt;" stays "&lt;" (no double unescaping).
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

// --- Tree -----------------------------------------------------------------

function parseAttrs(source) {
  const attrs = {};
  for (const m of source.matchAll(/([^\s=/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function parseHtml(html) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const popThrough = (node) => {
    while (stack.length > 1 && stack.pop() !== node);
  };
  const closeOpen = (names, scopes) => {
    for (let i = stack.length - 1; i > 0; i -= 1) {
      if (scopes.includes(stack[i].tag)) return;
      if (names.includes(stack[i].tag)) return popThrough(stack[i]);
    }
  };

  // Skipped whole, to their end or the page's: comments, and raw-text
  // elements (their insides aren't markup, and none of it is content).
  // Then a tag, other <!...>/<?...> (skipped), or text.
  const token = /<!--[\s\S]*?(?:-->|$)|<(script|style|noscript|template|textarea|title)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<(\/?)([a-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<![^>]*>|<\?[^>]*>|([^<]+|<)/gi;
  for (const m of String(html || "").matchAll(token)) {
    if (m[5] !== undefined) {
      top().children.push(decodeEntities(m[5]));
      continue;
    }
    if (!m[3]) continue; // comment, raw text, doctype, CDATA, processing instruction
    const tag = m[3].toLowerCase();
    if (m[2]) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === tag) {
          popThrough(stack[i]);
          break;
        }
      }
      continue;
    }
    if (CLOSES_P.has(tag) && top().tag === "p") stack.pop();
    if (IMPLIED[tag]) closeOpen(...IMPLIED[tag]);
    const node = { tag, attrs: parseAttrs(m[4]), children: [], parent: top() };
    top().children.push(node);
    // Past MAX_DEPTH (thousands of unclosed tags) children go to the parent: the walks below recurse.
    if (!VOID.has(tag) && !/\/\s*$/.test(m[4]) && stack.length < MAX_DEPTH) stack.push(node);
  }
  return root;
}

function* elements(node) {
  for (const child of node.children) {
    if (typeof child !== "string") {
      yield child;
      yield* elements(child);
    }
  }
}

function textOf(node) {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

// strict: also by class/id words. The body, <main> and <article> are never
// junk ("has-sidebar" on <body> mustn't drop the page).
function isJunk(node, strict) {
  const a = node.attrs;
  if (DROP_TAGS.has(node.tag) || DROP_ROLES.has(a.role)) return true;
  if ("hidden" in a || a["aria-hidden"] === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || "")) return true;
  if (!strict || ["html", "body", "main", "article"].includes(node.tag)) return false;
  return `${a.class || ""} ${a.id || ""}`.toLowerCase().split(/[\s_-]+/).some((word) => JUNK_WORD.test(word));
}

function linkDensity(node) {
  const total = oneLine(textOf(node)).length;
  if (!total) return 1;
  let links = 0;
  for (const el of elements(node)) {
    if (el.tag === "a") links += oneLine(textOf(el)).length;
  }
  return Math.min(1, links / total);
}

// ponytail: one best block, not Readability's sibling merging; a page whose
// article is split across sibling containers loses the smaller parts.
function pickMain(root, strict) {
  const kept = [...elements(root)].filter((el) => !hasJunkAncestor(el, strict));
  const main = kept.find((el) => el.tag === "main" || el.attrs.role === "main");
  if (main) return main;
  const articles = kept.filter((el) => el.tag === "article");
  if (articles.length === 1) return articles[0];

  const scores = new Map();
  const add = (node, score) => node && node.tag !== "#root" && scores.set(node, (scores.get(node) || 0) + score);
  for (const el of kept) {
    const paragraph = ["p", "pre", "td", "blockquote"].includes(el.tag) ||
      (el.tag === "div" && !el.children.some((c) => typeof c !== "string" && BLOCK.has(c.tag)));
    if (!paragraph) continue;
    const text = oneLine(textOf(el));
    if (text.length < 25) continue;
    const score = 1 + (text.match(/,/g) || []).length + Math.min(Math.floor(text.length / 100), 3);
    add(el.parent, score);
    add(el.parent && el.parent.parent, score / 2);
  }
  let best = null;
  let bestScore = 0;
  for (const [node, score] of scores) {
    const adjusted = score * (1 - linkDensity(node));
    if (adjusted > bestScore) {
      best = node;
      bestScore = adjusted;
    }
  }
  return best || kept.find((el) => el.tag === "body") || root;
}

function hasJunkAncestor(node, strict) {
  for (let n = node; n && n.tag !== "#root"; n = n.parent) {
    if (isJunk(n, strict)) return true;
  }
  return false;
}

// --- Markdown -------------------------------------------------------------

// An http(s) URL, as a path when it's on the page's own site. Parens are
// escaped so "(...)" in a wiki link doesn't end the Markdown link early.
function linkTarget(raw, base) {
  let url;
  try {
    url = new URL(String(raw || "").trim(), base);
  } catch (e) {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  const sameSite = base && url.origin === base.origin;
  return (sameSite ? url.pathname + url.search + url.hash : url.href).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

const INDENT = "\u0001"; // a list level, turned into spaces after lines are trimmed

function toMarkdown(node, s) {
  if (typeof node === "string") return node.replace(/\s+/g, " ");
  if (isJunk(node, s.strict)) return "";
  const inner = () => node.children.map((child) => toMarkdown(child, s)).join("");
  const tag = node.tag;

  if (/^h[1-6]$/.test(tag)) {
    const text = oneLine(inner());
    return text ? `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n` : "";
  }
  switch (tag) {
    case "br":
      return "\n";
    case "hr":
      return "\n\n";
    case "pre": {
      const text = textOf(node).replace(/^\n+|\s+$/g, "");
      return text ? `\n\n\`\`\`\n${text}\n\`\`\`\n\n` : "";
    }
    case "code": {
      const text = oneLine(textOf(node));
      return text ? `\`${text}\`` : "";
    }
    case "a": {
      if (s.link) return inner();
      s.link = true;
      const hoisted = s.hoisted;
      s.hoisted = [];
      const text = oneLine(inner());
      const images = s.hoisted.join(" ");
      s.link = false;
      s.hoisted = hoisted;
      const href = node.attrs.href && !node.attrs.href.startsWith("#") ? linkTarget(node.attrs.href, s.base) : null;
      const link = !text ? "" : href ? `[${text.replace(/[[\]]/g, "")}](${href})` : text;
      return [images, link].filter(Boolean).join(" ");
    }
    case "img": {
      const { width, height } = node.attrs;
      if (Number(width) <= 2 || Number(height) <= 2) return ""; // tracking pixel (also width="0")
      const raw = node.attrs["data-src"] || node.attrs.src || "";
      const src = raw.startsWith("data:") ? null : linkTarget(raw, s.base);
      if (!src) return "";
      const image = `![${oneLine(node.attrs.alt || "").replace(/[[\]]/g, "") || "image"}](${src})`;
      // An image inside a link is written before it: Markdown's [![..](..)](..) is beyond the reader's parser.
      if (s.link) {
        s.hoisted.push(image);
        return "";
      }
      return ` ${image} `;
    }
    case "ul":
    case "ol": {
      s.depth += 1;
      let n = 0;
      const items = node.children
        .filter((c) => typeof c !== "string" && c.tag === "li" && !isJunk(c, s.strict))
        .map((li) => {
          n += 1;
          const text = li.children.map((c) => toMarkdown(c, s)).join("").replace(/\n{2,}/g, "\n").trim();
          return text ? `\n${INDENT.repeat(s.depth - 1)}${tag === "ol" ? `${n}.` : "-"} ${text}` : "";
        });
      s.depth -= 1;
      return `\n${items.join("")}\n\n`;
    }
    case "table":
      return table(node, s);
    case "blockquote": {
      const text = inner().trim();
      return text ? `\n\n${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : "";
    }
    default:
      return BLOCK.has(tag) ? `\n\n${inner()}\n\n` : inner();
  }
}

// A data table as a Markdown table; a one-column or layout table (tables
// inside it) as plain blocks.
function table(node, s) {
  const rows = [];
  const collect = (n) => {
    for (const child of n.children) {
      if (typeof child === "string" || isJunk(child, s.strict)) continue;
      if (child.tag === "table") return false;
      if (child.tag === "tr") rows.push(child.children.filter((c) => typeof c !== "string" && (c.tag === "td" || c.tag === "th")));
      else if (collect(child) === false) return false;
    }
    return true;
  };
  const cols = collect(node) ? Math.max(0, ...rows.map((r) => r.length)) : 0;
  if (cols < 2) {
    return `\n\n${node.children.map((child) => toMarkdown(child, s)).join("")}\n\n`;
  }
  const cell = (c) => oneLine(c.children.map((child) => toMarkdown(child, s)).join("")).replace(/[\\|]/g, "\\$&");
  const lines = rows.map((r) => {
    const cells = r.map(cell);
    while (cells.length < cols) cells.push("");
    return `| ${cells.join(" | ")} |`;
  });
  lines.splice(1, 0, `|${" --- |".repeat(cols)}`);
  return `\n\n${lines.join("\n")}\n\n`;
}

function tidy(markdown) {
  let fence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.trim().startsWith("```")) {
        fence = !fence;
        return line.trim();
      }
      if (fence) return line;
      return line.replace(/[ \t]+/g, " ").trim().replace(new RegExp(`^${INDENT}+`), (m) => "  ".repeat(m.length));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Under this much text the class/id rules probably ate the page itself
// (a wrapper named "page-with-sidebar"); the tag rules alone go again.
const MIN_STRICT_CHARS = 250;

// The page's main content as Markdown. baseUrl resolves relative links.
function extractMainContent(html, baseUrl) {
  let base = null;
  try {
    base = new URL(baseUrl);
  } catch (e) {}
  const root = parseHtml(html);
  let markdown = "";
  for (const strict of [true, false]) {
    const main = pickMain(root, strict);
    markdown = tidy(toMarkdown(main, { base, strict, link: false, hoisted: [], depth: 0 }));
    if (markdown.length >= MIN_STRICT_CHARS) break;
  }
  const h1 = [...elements(root)].find((el) => el.tag === "h1");
  return { markdown, h1: h1 ? oneLine(textOf(h1)) : "" };
}

// #1140: when there's little to read without the page's scripts, or it
// wants me to sign in, the browser has to open it instead. Null otherwise.
function browserReason(html, markdown) {
  const text = String(markdown || "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  if (/<input\b[^>]*type\s*=\s*["']?password/i.test(html) && text.length < 1500) return "it asks to sign in";
  if (text.length < 200 && /<script\b/i.test(html)) return "its content is built by scripts";
  return null;
}

module.exports = { browserReason, decodeEntities, extractMainContent };
