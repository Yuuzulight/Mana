// The jobs behind tools/arcana-gate.js. Each is [site, job, covers, steps, options?]:
//   covers  the browser actions the job exercises, so the gate can show any action no job reaches
//   steps   [name, act(browser, state), check(state, result), { wait: true }?]
//   options { tracked: "why" } runs and reports the job but keeps it out of the pass/fail count: for a
//           site that stops Edge too, or a gap in the engine already written up (shown, never hidden)
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const refOf = (line) => (line ? /\[ref=([^\]]+)\]/.exec(line)?.[1] : null);
const find = (re) => (s) => s.elements.find((line) => re.test(line));
const hasElements = (n) => (s) => s.elements.length >= n;
const textHas = (re) => (s) => re.test(`${s.text || ""}\n${s.elements.join("\n")}`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const js = async (b, code) => (await b.devtools({ do: "run_js", code })).devtools[0];

const UPLOAD = path.join(os.tmpdir(), "arcana-gate-upload.txt");
fs.writeFileSync(UPLOAD, "uploaded by the Arcana gate\n");
// The local fixture site (tools/arcana-fixture-site.js); the gate starts it and sets `base`.
const site = { base: null, url: (path) => `${site.base}${path}` };
const downloads = [];
let before = 0;
const TI = "https://the-internet.herokuapp.com";
const ATTACHMENT = "https://httpbin.org/response-headers?Content-Disposition=attachment%3B%20filename%3Dgate.txt";

// A small page built on example.com with JavaScript, for things no public site offers reliably.
const fixture = (b, html, script = "") => js(b, `document.body.innerHTML=${JSON.stringify(html)};${script};'ok'`);

const JOBS = [
  // --- reading, searching, following links on real sites ---
  ["example.com", "open a page and follow its link", "navigate click", [
    ["open", (b) => b.navigate("https://example.com/"), (s) => /Example Domain/.test(s.title)],
    ["follow the link", (b, s) => b.click(refOf(find(/link/)(s))), (s) => /iana\.org/.test(s.url)],
  ]],
  ["Hacker News", "open a story's comments", "navigate click", [
    ["open the front page", (b) => b.navigate("https://news.ycombinator.com/"), (s) => /Hacker News/.test(s.title) && hasElements(40)(s)],
    ["open comments", (b, s) => b.click(refOf(find(/link "\d+\s*comments?"/)(s))), (s) => /item\?id=/.test(s.url)],
  ]],
  ["Hacker News", "page through the list", "navigate scroll click find", [
    ["open the front page", (b) => b.navigate("https://news.ycombinator.com/"), hasElements(40)],
    ["scroll down", (b) => b.scroll("down"), hasElements(40)],
    ["go to the next page", async (b) => { const r = await b.find("More"); return b.click(refOf(r.matches.find((l) => /^link "More"/.test(l)))); }, (s) => /[?&]p=2/.test(s.url)],
  ]],
  ["Wikipedia", "search by typing", "navigate type", [
    ["open the main page", (b) => b.navigate("https://en.wikipedia.org/wiki/Main_Page"), (s) => /Wikipedia/.test(s.title)],
    ["search", (b, s) => b.type(refOf(s.elements.find((l) => /^(searchbox|textbox|combobox)/.test(l) && /search/i.test(l))), "Alan Turing", true), (s) => /Turing/.test(s.title)],
  ]],
  ["Wikipedia", "read an article with tables", "navigate snapshot", [
    ["open the article", (b) => b.navigate("https://en.wikipedia.org/wiki/Alan_Turing"), (s) => /Alan Turing/.test(s.title) && hasElements(60)(s)],
  ]],
  ["Wikipedia", "follow a link inside an article", "navigate click", [
    ["open the article", (b) => b.navigate("https://en.wikipedia.org/wiki/Alan_Turing"), hasElements(60)],
    ["follow a link", (b, s) => b.click(refOf(find(/link "Turing machine"/i)(s))), (s) => /Turing_machine/.test(s.url)],
  ]],
  ["Wikipedia", "find the search box by description", "navigate find", [
    ["open the main page", (b) => b.navigate("https://en.wikipedia.org/wiki/Main_Page"), hasElements(10)],
    ["find it", (b) => b.find("the search box"), (s, r) => r.matches.length > 0],
  ]],
  ["Wikipedia (Japanese)", "read a page in another language", "navigate", [
    ["open the page", (b) => b.navigate("https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC"), (s) => /日本/.test(s.title) && hasElements(40)(s)],
  ]],
  ["Wikipedia", "scroll a very long page", "navigate scroll", [
    ["open the list", (b) => b.navigate("https://en.wikipedia.org/wiki/List_of_Roman_emperors"), hasElements(100)],
    ["scroll down", (b) => b.scroll("down"), hasElements(100)],
    ["scroll down again", (b) => b.scroll("down"), hasElements(100)],
    ["scroll back up", (b) => b.scroll("up"), hasElements(100)],
  ]],
  ["MDN", "follow a docs link", "navigate click", [
    ["open the docs", (b) => b.navigate("https://developer.mozilla.org/en-US/docs/Web/JavaScript"), (s) => /JavaScript/.test(s.title)],
    ["follow a link", (b, s) => b.click(refOf(find(/link "(Array|Promise|Reference)/)(s))), (s) => /developer\.mozilla\.org/.test(s.url) && !/\/Web\/JavaScript$/.test(s.url)],
  ]],
  ["Python docs", "open a library page and follow a link", "navigate click", [
    ["open the page", (b) => b.navigate("https://docs.python.org/3/library/json.html"), (s) => /json/.test(s.title) && hasElements(40)(s)],
    ["follow a link", (b, s) => b.click(refOf(find(/link "The Python standard library"/)(s))), (s) => /docs\.python\.org\/3\/library\/(index\.html)?$/.test(s.url)],
  ]],
  ["BBC News", "scroll and open a story", "navigate scroll click", [
    ["open the news page", (b) => b.navigate("https://www.bbc.com/news"), (s) => /BBC/.test(s.title) && hasElements(30)(s)],
    ["scroll down", (b) => b.scroll("down"), hasElements(30)],
    ["open a story", (b, s) => b.click(refOf(s.elements.find((l) => /^link ".{25,}"/.test(l) && !/Skip/.test(l)))), (s) => /\/news\//.test(s.url)],
  ]],
  ["GitHub", "open a repository's Issues tab", "navigate click", [
    ["open the repository", (b) => b.navigate("https://github.com/nodejs/node"), (s) => /nodejs\/node/.test(s.title)],
    ["open Issues", (b, s) => b.click(refOf(find(/link "Issues/)(s))), (s) => /\/issues/.test(s.url)],
  ]],
  ["Lobsters", "hover a story and follow a tag", "navigate hover click", [
    ["open the front page", (b) => b.navigate("https://lobste.rs/"), hasElements(30)],
    ["hover a story", (b, s) => b.hover(refOf(s.elements.find((l) => /^link ".{20,}"/.test(l)))), hasElements(30)],
    ["follow a tag", (b, s) => b.click(refOf(find(/^link "Tag /)(s))), (s) => /lobste\.rs\/t\//.test(s.url)],
  ]],
  ["arXiv", "open a paper from the new list", "navigate click", [
    ["open the list", (b) => b.navigate("https://arxiv.org/list/cs.AI/recent"), hasElements(30)],
    ["open an abstract", (b, s) => b.click(refOf(find(/link "arXiv:\d{4}\.\d+/)(s))), (s) => /arxiv\.org\/abs\//.test(s.url)],
  ]],
  ["Project Gutenberg", "search for a book", "navigate type", [
    ["open the site", (b) => b.navigate("https://www.gutenberg.org/"), (s) => /Gutenberg/.test(s.title)],
    ["search", (b, s) => b.type(refOf(s.elements.find((l) => /^(searchbox|textbox|combobox)/.test(l))), "Pride and Prejudice", true), (s) => /search|ebooks/.test(s.url)],
  ]],
  ["Open Library", "open a book from search results", "navigate click", [
    ["search", (b) => b.navigate("https://openlibrary.org/search?q=dune"), (s) => /dune/i.test(s.title + s.url) && hasElements(20)(s)],
    ["open a book", (b, s) => b.click(refOf(find(/^link "Dune/)(s))), (s) => /openlibrary\.org\/(works|books|series)\//.test(s.url)],
  ]],
  ["NPR (text edition)", "open a story", "navigate click", [
    ["open the front page", (b) => b.navigate("https://text.npr.org/"), hasElements(10)],
    ["open a story", (b, s) => b.click(refOf(s.elements.find((l) => /^link ".{25,}"/.test(l)))), (s) => /text\.npr\.org\/.+/.test(s.url) && s.url !== "https://text.npr.org/"],
  ]],
  ["Go", "open the docs and follow a link", "navigate click", [
    ["open the docs", (b) => b.navigate("https://go.dev/doc/"), (s) => /Go/.test(s.title) && hasElements(20)(s)],
    ["follow a link", (b, s) => b.click(refOf(find(/link "(Tutorials?|Effective Go|Getting started|Download)/i)(s))), (s) => /go\.dev/.test(s.url) && !/\/doc\/?$/.test(s.url)],
  ]],
  ["kernel.org", "read the releases table", "navigate snapshot", [
    ["open the site", (b) => b.navigate("https://www.kernel.org/"), (s) => /Linux Kernel/.test(s.title) && /stable|mainline/i.test(s.text || "")],
  ]],

  // --- pages that run JavaScript to build themselves ---
  ["TodoMVC (React)", "add a to-do in a JavaScript app", "navigate type", [
    ["open the app", (b) => b.navigate("https://todomvc.com/examples/react/dist/"), (s) => s.elements.some((l) => /^textbox/.test(l))],
    ["add a task", (b, s) => b.type(refOf(s.elements.find((l) => /^textbox/.test(l))), "Buy milk", true), textHas(/Buy milk/), { wait: true }],
  ]],
  ["Quotes to Scrape (JS)", "read quotes the page builds with a script, then page on", "navigate click", [
    ["open the page", (b) => b.navigate("https://quotes.toscrape.com/js/"), textHas(/Einstein/), { wait: true }],
    ["go to the next page", (b, s) => b.click(refOf(find(/link "Next/)(s))), (s) => /\/js\/page\/2/.test(s.url)],
  ]],
  ["Practice Software Testing", "browse a shop and add to the cart", "navigate click", [
    ["open the shop", (b) => b.navigate("https://practicesoftwaretesting.com/"), (s) => s.elements.some((l) => /^link "Compare .+\$\d/.test(l)), { wait: true }],
    ["open a product", (b, s) => b.click(refOf(find(/^link "Compare .+\$\d/)(s))), (s) => /\/product\//.test(s.url) && s.elements.some((l) => /Add to cart/i.test(l)), { wait: true }],
    ["add it to the cart", (b, s) => b.click(refOf(find(/Add to cart/i)(s))), textHas(/added to shopping cart|cart/i), { wait: true }],
  ]],
  ["Books to Scrape", "browse a category and open a book", "navigate click", [
    ["open the shop", (b) => b.navigate("https://books.toscrape.com/"), (s) => /Books to Scrape/.test(s.title)],
    ["open a category", (b, s) => b.click(refOf(find(/link "Travel"/)(s))), (s) => /travel/.test(s.url)],
    ["open a book", (b, s) => b.click(refOf(s.elements.find((l) => /^link ".{6,}"/.test(l) && !/Travel|Books|Home/.test(l)))), (s) => /£/.test(s.text || "")],
  ]],

  // --- forms and controls ---
  ["the-internet (checkboxes)", "tick a checkbox", "navigate click", [
    ["open the page", (b) => b.navigate(`${TI}/checkboxes`), (s) => s.elements.filter((l) => /^checkbox/.test(l)).length === 2],
    ["tick the first box", (b, s) => b.click(refOf(s.elements.find((l) => /^checkbox/.test(l)))), (s) => /checked/.test(s.elements.find((l) => /^checkbox/.test(l)))],
  ]],
  ["the-internet (dropdown)", "choose from a dropdown", "navigate select", [
    ["open the page", (b) => b.navigate(`${TI}/dropdown`), (s) => s.elements.some((l) => /^combobox/.test(l)) && s.elements.some((l) => /^option "Option 2"/.test(l))],
    ["choose Option 2", (b, s) => b.select(refOf(s.elements.find((l) => /^combobox/.test(l))), "Option 2"), (s) => s.elements.some((l) => /^option "Option 2" \[selected\]/.test(l))],
  ]],
  ["the-internet (number input)", "type a number and step it with the keyboard", "navigate type press", [
    ["open the page", (b) => b.navigate(`${TI}/inputs`), (s) => s.elements.some((l) => /^spinbutton/.test(l))],
    ["type 5", (b, s) => b.type(refOf(s.elements.find((l) => /^spinbutton/.test(l))), "5", false), hasElements(1)],
    ["press ArrowUp", (b, s) => b.press("ArrowUp", refOf(s.elements.find((l) => /^spinbutton/.test(l)))), (s) => /: "?6"?$/.test(s.elements.find((l) => /^spinbutton/.test(l)))],
  ]],
  ["the-internet (key presses)", "press a key", "navigate press", [
    ["open the page", (b) => b.navigate(`${TI}/key_presses`), (s) => s.elements.some((l) => /^textbox/.test(l))],
    ["press A", (b, s) => b.press("a", refOf(s.elements.find((l) => /^textbox/.test(l)))), textHas(/You entered: A/i)],
  ]],
  ["the-internet (slider)", "move a slider with the arrow keys", "navigate press", [
    ["open the page", (b) => b.navigate(`${TI}/horizontal_slider`), (s) => s.elements.some((l) => /^slider/.test(l))],
    ["press ArrowRight", (b, s) => b.press("ArrowRight", refOf(s.elements.find((l) => /^slider/.test(l)))), (s) => /: "?0\.5"?$/.test(s.elements.find((l) => /^slider/.test(l)))],
  ]],
  ["the-internet (hover menu)", "hover to open a menu", "navigate hover", [
    ["open the page", (b) => b.navigate(`${TI}/jqueryui/menu`), (s) => s.elements.some((l) => /Enabled/.test(l))],
    ["hover Enabled", (b, s) => b.hover(refOf(find(/Enabled/)(s))), (s) => s.elements.some((l) => /Downloads/.test(l)), { wait: true }],
  ]],
  ["the-internet (JS dialogs)", "answer an alert and a confirm", "navigate click", [
    ["open the page", (b) => b.navigate(`${TI}/javascript_alerts`), hasElements(3)],
    ["click for an alert", (b, s) => b.click(refOf(find(/button "Click for JS Alert"/)(s))), textHas(/successfully clicked an alert/i)],
    ["click for a confirm", (b, s) => b.click(refOf(find(/button "Click for JS Confirm"/)(s))), textHas(/You clicked: (Ok|Cancel)/i)],
  ]],
  ["the-internet (dynamic loading)", "wait for content that loads after a click", "navigate click", [
    ["open the page", (b) => b.navigate(`${TI}/dynamic_loading/2`), (s) => s.elements.some((l) => /button "Start"/.test(l))],
    ["click Start and wait for the result", (b, s) => b.click(refOf(find(/button "Start"/)(s))), textHas(/Hello World!/), { wait: true }],
  ]],
  ["the-internet (table)", "read a table and follow a link in it", "navigate click snapshot", [
    ["open the page", (b) => b.navigate(`${TI}/tables`), textHas(/Smith/)],
    ["follow an edit link", (b, s) => b.click(refOf(find(/link "edit"/)(s))), (s) => /#edit$/.test(s.url)],
  ]],
  ["the-internet (add and remove)", "add an element and remove it", "navigate click", [
    ["open the page", (b) => b.navigate(`${TI}/add_remove_elements/`), (s) => s.elements.some((l) => /Add Element/.test(l))],
    ["add one", (b, s) => b.click(refOf(find(/Add Element/)(s))), (s) => s.elements.some((l) => /Delete/.test(l))],
    ["remove it", (b, s) => b.click(refOf(find(/Delete/)(s))), (s) => !s.elements.some((l) => /Delete/.test(l))],
  ]],
  ["the-internet (infinite scroll)", "scroll a page that loads more as you go", "navigate scroll", [
    ["open the page", (b) => b.navigate(`${TI}/infinite_scroll`), (s) => { before = (s.text || "").length; return before > 0; }],
    ["scroll down three times", async (b) => { await b.scroll("down"); await b.scroll("down"); return b.scroll("down"); }, (s) => (s.text || "").length > before + 500, { wait: true }],
  ]],
  ["httpbin", "fill in and send a form", "navigate type click", [
    ["open the form", (b) => b.navigate("https://httpbin.org/forms/post"), (s) => s.elements.some((l) => /^textbox/.test(l))],
    ["fill in the name", (b, s) => b.type(refOf(s.elements.find((l) => /^textbox/.test(l))), "Mana", false), hasElements(5)],
    ["send it", (b, s) => b.click(refOf(s.elements.find((l) => /^button/.test(l) && /submit|order/i.test(l)))), (s) => /\/post/.test(s.url)],
  ]],
  ["httpbin", "follow redirects", "navigate", [
    ["open a three-hop redirect", (b) => b.navigate("https://httpbin.org/redirect/3"), (s) => /httpbin\.org\/get/.test(s.url)],
  ]],
  ["httpbin", "open an error page", "navigate", [
    ["open a 404", (b) => b.navigate("https://httpbin.org/status/404"), (s) => /status\/404/.test(s.url)],
  ]],
  ["httpbin", "keep a cookie the site set", "navigate", [
    ["set and read it back", (b) => b.navigate("https://httpbin.org/cookies/set?mana=hello"), (s) => /cookies/.test(s.url) && /hello/.test(s.text || "")],
  ]],

  // --- downloads, drag and drop, tabs, and the safety stop ---
  ["httpbin", "start a download by opening a file link", "navigate click download", [
    ["open a page with a file link", (b) => b.navigate("https://example.com/").then(() => fixture(b, `<a href="${ATTACHMENT}">get the file</a>`)), hasElements(1)],
    ["click the link", (b, s) => b.click(refOf(find(/get the file/)(s))), () => downloads.includes("gate.txt"), { wait: true }],
  ]],
  ["httpbin", "start a download by going to the address", "navigate download", [
    ["open the file address", (b) => b.navigate("https://example.com/").then(() => b.navigate(ATTACHMENT).catch(() => null)), () => downloads.includes("gate.txt"), { wait: true }],
  ]],
  ["Local site", "drag one thing onto another", "navigate drag", [
    ["open the page", (b) => b.navigate(site.url("/drag.html")), (s) => s.elements.some((l) => /Drag me/.test(l)) && s.elements.some((l) => /Drop here/.test(l))],
    ["drag it", (b, s) => b.drag(refOf(find(/Drag me/)(s)), refOf(find(/Drop here/)(s))), textHas(/dropped a/)],
  ]],
  ["example.com", "work in two tabs", "navigate tab", [
    ["open the first page", (b) => b.navigate("https://example.com/"), (s) => /Example Domain/.test(s.title)],
    ["open a second tab", (b) => b.tab({ do: "open", url: "https://news.ycombinator.com/" }), (s) => /Hacker News/.test(s.title)],
    ["switch back to the first", (b) => b.tab({ do: "switch", number: 1 }), (s) => /Example Domain/.test(s.title)],
    ["close the second", (b) => b.tab({ do: "close", number: 2 }), (s) => /Example Domain/.test(s.title)],
  ]],
  ["the-internet (login page)", "refuse to type on a password page", "navigate sensitive", [
    ["open the page", (b) => b.navigate(`${TI}/login`), (s) => Boolean(s.sensitive)],
    ["try to type into it", async (b, s) => b.type(refOf(s.elements.find((l) => /^textbox/.test(l))), "x", false).then(() => "typed", (e) => e.message), (s, r) => /password|payment|sign|login|never|sensitive/i.test(String(r)) && r !== "typed"],
  ]],

  // --- the other tools Mana has ---
  ["example.com", "go back after following a link", "navigate click back", [
    ["open", (b) => b.navigate("https://example.com/"), (s) => /Example Domain/.test(s.title)],
    ["follow the link", (b, s) => b.click(refOf(find(/link/)(s))), (s) => /iana\.org/.test(s.url)],
    ["go back", (b) => b.back(), (s) => /example\.com/.test(s.url)],
  ]],
  ["example.com", "take a screenshot", "navigate screenshot", [
    ["open", (b) => b.navigate("https://example.com/"), (s) => /Example Domain/.test(s.title)],
    ["screenshot", (b) => b.screenshot(), (s, r) => typeof r === "string" && r.length > 2000],
  ]],
  ["example.com", "read the console and the network", "navigate devtools", [
    ["open", (b) => b.navigate("https://example.com/"), (s) => /Example Domain/.test(s.title)],
    ["network", (b) => b.devtools({ do: "network" }), (s, r) => /Network \(\d+ requests/.test(r.what) && !/Network \(0 /.test(r.what)],
    ["console", (b) => b.devtools({ do: "console" }), (s, r) => /Console/.test(r.what)],
  ]],
  ["the-internet (script error)", "see a page's JavaScript error in the console", "navigate devtools", [
    ["open the page", (b) => b.navigate(`${TI}/javascript_error`), textHas(/JavaScript error/i)],
    ["console", async (b) => { await pause(1000); return b.devtools({ do: "console" }); }, (s, r) => r.devtools.some((l) => /error/i.test(l))],
  ]],
  ["example.com", "run JavaScript on the page", "navigate devtools", [
    ["open", (b) => b.navigate("https://example.com/"), (s) => /Example Domain/.test(s.title)],
    ["run it", (b) => b.devtools({ do: "run_js", code: "document.title" }), (s, r) => /Example Domain/.test(r.devtools[0])],
  ]],
  ["example.com", "test the page at phone and desktop sizes", "navigate devtools testPage", [
    ["test", (b) => b.testPage("https://example.com/", ["phone", "desktop"]), (s, r) => r.sizes.length === 2],
    ["switch to phone size", (b) => b.devtools({ do: "viewport", size: "phone" }), (s) => /Example Domain/.test(s.title)],
    ["switch to dark mode", (b) => b.devtools({ do: "color_scheme", scheme: "dark" }), (s) => /Example Domain/.test(s.title)],
  ]],
  ["the-internet (add and remove)", "click by screen position, as the vision tool does", "navigate lookAndClick", [
    ["open the page", (b) => b.navigate(`${TI}/add_remove_elements/`), (s) => s.elements.some((l) => /Add Element/.test(l))],
    ["find where the button is", async (b) => {
      const r = await b.devtools({ do: "run_js", code: "(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width}})()" });
      JOBS.point = JSON.parse(r.devtools[0]);
      return r;
    }, () => JOBS.point && JOBS.point.w > 0],
    ["click that spot", (b) => b.lookAndClick("the Add Element button", async () => ({ x: JOBS.point.x, y: JOBS.point.y })), (s) => s.elements.some((l) => /Delete/.test(l))],
  ]],

  // --- frames and uploads, on a local site so they do not depend on anyone else's page ---
  ["Local site", "read inside an iframe and click a button in it", "navigate click", [
    ["open the page", (b) => b.navigate(site.url("/frames.html")), (s) => s.elements.some((l) => /Frame button/.test(l)), { wait: true }],
    ["click the button inside the frame", (b, s) => b.click(refOf(find(/Frame button/)(s))), () => true],
    ["see what the frame did", (b) => js(b, "document.getElementById('f').contentDocument.getElementById('said').textContent"), (s, r) => /frame button clicked/.test(String(r))],
  ]],
  ["Local site", "read frames nested in frames", "navigate", [
    ["open the page", (b) => b.navigate(site.url("/nested.html")), (s) => s.elements.some((l) => /Frame button.*ref=f[0-9]+e/.test(l)), { wait: true }],
  ]],
  ["Local site", "read an iframe built from inline HTML (srcdoc)", "navigate click", [
    ["open the page", (b) => b.navigate(site.url("/srcdoc.html")), (s) => s.elements.some((l) => /Srcdoc button/.test(l)), { wait: true }],
    ["click it", (b, s) => b.click(refOf(find(/Srcdoc button/)(s))), () => true],
    ["see what it did", (b) => js(b, "document.querySelector('iframe').contentDocument.body.innerText"), (s, r) => /srcdoc clicked/.test(String(r))],
  ]],
  ["Local site", "read an old-style frameset page", "navigate click", [
    ["open the page", (b) => b.navigate(site.url("/frameset.html")), (s) => s.elements.some((l) => /Frame button/.test(l)) && s.elements.some((l) => /Go to child/.test(l)), { wait: true }],
    ["follow a link in the second frame", (b, s) => b.click(refOf(find(/Go to child/)(s))), () => true],
    ["see where that frame went", (b) => js(b, "document.querySelectorAll('iframe')[1].contentDocument.title"), (s, r) => /Child/.test(String(r)), { wait: true }],
  ]],
  ["Local site", "send a file through a form", "navigate upload click", [
    ["open the form", (b) => b.navigate(site.url("/upload.html")), (s) => s.elements.some((l) => /file|Choose/i.test(l))],
    ["choose the file", (b, s) => b.upload(refOf(s.elements.find((l) => /file|Choose/i.test(l))), UPLOAD), hasElements(2)],
    ["send it", (b, s) => b.click(refOf(find(/button "Send"/)(s))), textHas(/File Uploaded!.*arcana-gate-upload\.txt/), { wait: true }],
  ]],
  ["the-internet (file upload)", "send a file", "navigate upload click", [
    ["open the page", (b) => b.navigate(`${TI}/upload`), (s) => s.elements.some((l) => /file|Choose/i.test(l))],
    ["choose the file", (b, s) => b.upload(refOf(s.elements.find((l) => /file|Choose/i.test(l))), UPLOAD), hasElements(2)],
    ["send it", (b, s) => b.click(refOf(find(/button "Upload"|Upload/)(s))), textHas(/File Uploaded/i), { wait: true }],
  ]],
  ["Amazon", "open the home page", "navigate", [
    ["open", (b) => b.navigate("https://www.amazon.com/"), (s) => /Amazon/.test(s.title) && hasElements(10)(s), { wait: true }],
  ]],

  // --- tracked: kept out of the count, shown every run ---
  ["YouTube", "open the home page", "navigate", [
    ["open", (b) => b.navigate("https://www.youtube.com/"), (s) => /YouTube/.test(s.title) && hasElements(20)(s), { wait: true }],
  ], { tracked: "Arcana#7: the page's app element is created but never finishes starting" }],
];

module.exports = { JOBS, downloads, UPLOAD, site };
