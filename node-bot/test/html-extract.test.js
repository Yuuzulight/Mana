const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { browserReason, decodeEntities, extractMainContent } = require("../tools/html-extract");

// #1140: saved pages (test/fixtures/pages) read without a browser.
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "pages", `${name}.html`), "utf8");

test("an article keeps its story and drops the site around it", () => {
  const html = fixture("article");
  const { markdown, h1 } = extractMainContent(html, "https://news.example/2026/race");
  assert.equal(h1, "Chocobo racing returns to Gold Saucer");
  assert.match(markdown, /^# Chocobo racing returns to Gold Saucer\n\nBy Wedge & Biggs, 12 May\n\nAfter a season away/);
  assert.match(markdown, /## What changes this season\n\n- Three new tracks: .*\n- Weekly cups with MGP prizes\./);
  assert.match(markdown, /> "It's the best the tracks have ever been," said one trainer\./);
  // Its own site's image as a path; an outside link whole, parens escaped.
  assert.match(markdown, /!\[Chocobos at the starting line\]\(\/img\/race\.jpg\)/);
  assert.match(markdown, /\[long-time racers\]\(https:\/\/wiki\.example\.org\/Racing_%28sport%29\)/);
  for (const junk of ["cookies", "Opinion", "Share on", "Related", "Sponsored", "Subscribe", "All rights reserved", "TRACKING", "font-family", "pixel.gif"]) {
    assert.doesNotMatch(markdown, new RegExp(junk), junk);
  }
  assert.equal(browserReason(html, markdown), null);
});

test("a wiki page keeps its infobox table, links and lists but not its menus", () => {
  const { markdown } = extractMainContent(fixture("wiki"), "https://en.wikipedia.org/wiki/Tokyo");
  assert.match(markdown, /^# Tokyo\n\n\| Country \| \[Japan\]\(\/wiki\/Japan\) \|\n\| --- \| --- \|\n\| Population \| 14,094,034 \|/);
  assert.match(markdown, /capital of \[Japan\]\(\/wiki\/Japan\)/);
  assert.match(markdown, /\[Edo\]\(\/wiki\/Edo_%28Tokyo%29\)/);
  assert.match(markdown, /## History\n\nTokyo was originally/);
  assert.match(markdown, /- 1868: The city is renamed Tokyo\./);
  for (const junk of ["Main page", "Search Wikipedia", "View history", "free encyclopedia", "Contents", "edit\\]", "Seoul", "Categories", "last edited", "RLQ"]) {
    assert.doesNotMatch(markdown, new RegExp(junk), junk);
  }
});

test("a docs page keeps its steps, code and options table", () => {
  const { markdown } = extractMainContent(fixture("docs"), "https://folio.example/docs/install");
  assert.match(markdown, /^# Installing the CLI\n/);
  assert.match(markdown, /1\. Download the installer from the \[downloads page\]\(\/downloads\)\.\n2\. Run it/);
  assert.match(markdown, /```\nfolio --version\nfolio 0\.1\.0\n```/);
  assert.match(markdown, /\| Flag \| What it does \|\n\| --- \| --- \|\n\| `--quiet` \| Prints only errors \|\n\| `--out <dir>` \| Where files are written \\\| default: \. \|/);
  for (const junk of ["Introduction", "Configuration", "Docs /", "On this page", "helpful", "analytics"]) {
    assert.doesNotMatch(markdown, new RegExp(junk), junk);
  }
});

test("a page that is mostly scripts has nothing to read and needs the browser", () => {
  const html = fixture("scripts");
  const { markdown } = extractMainContent(html, "https://app.example/");
  assert.equal(markdown, "");
  assert.equal(browserReason(html, markdown), "its content is built by scripts");
});

test("a sign-in page needs the browser; a long article with a login box doesn't", () => {
  const login = '<form><h1>Sign in</h1><input name="user"><input type="password" name="pw"></form>';
  assert.equal(browserReason(login, extractMainContent(login, "https://x.example/").markdown), "it asks to sign in");
  const article = `<article><p>${"A long paragraph of real text. ".repeat(80)}</p></article><input type=password>`;
  assert.equal(browserReason(article, extractMainContent(article, "https://x.example/").markdown), null);
});

test("the class rules never drop the whole page, and unsafe links stay text", () => {
  const html = `<body><div class="page-with-sidebar"><p>${"Plain words here. ".repeat(20)}</p>
    <p><a href="javascript:alert(1)">run me</a> and <a href="#top">top</a></p></div></body>`;
  const { markdown } = extractMainContent(html, "https://x.example/");
  assert.match(markdown, /^Plain words here\./);
  assert.match(markdown, /run me and top/);
  assert.doesNotMatch(markdown, /javascript:|\]\(#/);
});

test("entities decode in one pass", () => {
  assert.equal(decodeEntities("&amp;lt;b&amp;gt; &#39;x&#x27; &hellip; &bogus;"), "&lt;b&gt; 'x' … &bogus;");
});

test("thousands of unclosed tags don't overflow the stack", () => {
  const html = `<article><p>${"<span>".repeat(20000)}Deep words, still read.</p></article>`;
  assert.equal(extractMainContent(html, "https://x.example/").markdown, "Deep words, still read.");
});

test("comments and raw-text elements are skipped whole, and table cells escape backslash and pipe", () => {
  const html = String.raw`<article><p>Kept words, before.</p><!-- <p>commented out</p> --><script>var s = "</p><p>not text";</script>
    <table><tr><th>Path</th><th>Pipe</th></tr><tr><td>C:\dir</td><td>a|b</td></tr></table><style>p { x: 1 }`;
  const { markdown } = extractMainContent(html, "https://x.example/");
  assert.equal(markdown, "Kept words, before.\n\n| Path | Pipe |\n| --- | --- |\n" + String.raw`| C:\\dir | a\|b |`);
});
