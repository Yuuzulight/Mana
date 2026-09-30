const assert = require("node:assert/strict");
const test = require("node:test");
const dns = require("node:dns").promises;

const {
  assertPublicUrl,
  buildWebContextForPrompt,
  extractFirstUrl,
  extractSearchQuery,
  extractWikiTerm,
  fetchPage,
  htmlToText,
  isPrivateIp,
  searchWeb,
  textLooksLikeSearchQuestion,
  textLooksLikeWikiQuestion,
  wikiLookup,
} = require("../tools/web-access");

function withMockedFetch(handler, fn) {
  const original = global.fetch;
  global.fetch = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = original;
    });
}

function withMockedDnsLookup(handler, fn) {
  const original = dns.lookup;
  dns.lookup = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      dns.lookup = original;
    });
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("isPrivateIp flags loopback, RFC1918, and link-local ranges", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.1.2.3"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("172.31.255.255"), true);
  assert.equal(isPrivateIp("172.32.0.1"), false);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("169.254.169.254"), true); // cloud metadata endpoint
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("93.184.216.34"), false);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPrivateIp("fd00::1"), true);
  assert.equal(isPrivateIp("2001:4860:4860::8888"), false);
});

test("assertPublicUrl rejects non-http(s) protocols and literal private IPs", async () => {
  await assert.rejects(() => assertPublicUrl("ftp://example.com/file"), /must be http or https/);
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1:9000/health"), /private, loopback/);
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data"), /private, loopback/);
  await assert.rejects(() => assertPublicUrl("not a url"), /not a valid URL/);
});

test("assertPublicUrl rejects a hostname that resolves to a private address", async () => {
  await withMockedDnsLookup(
    async () => [{ address: "10.0.0.5", family: 4 }],
    async () => {
      await assert.rejects(
        () => assertPublicUrl("http://internal.example.com/"),
        /private, loopback/,
      );
    },
  );
});

test("assertPublicUrl allows a hostname that resolves publicly", async () => {
  await withMockedDnsLookup(
    async () => [{ address: "93.184.216.34", family: 4 }],
    async () => {
      const url = await assertPublicUrl("http://example.com/page");
      assert.equal(url.hostname, "example.com");
    },
  );
});

test("htmlToText strips scripts, styles, tags, and decodes entities", () => {
  const html = `
    <html><head><style>.a{color:red}</style><script>alert(1)</script></head>
    <body><h1>Title</h1><p>Hello &amp; welcome &mdash; enjoy&nbsp;this.</p></body></html>
  `;
  const text = htmlToText(html);
  assert.equal(text.includes("alert(1)"), false);
  assert.equal(text.includes("color:red"), false);
  assert.match(text, /Title/);
  assert.match(text, /Hello & welcome/);
});

test("extractFirstUrl finds a URL and strips trailing punctuation", () => {
  assert.equal(
    extractFirstUrl("check this out: https://example.com/page."),
    "https://example.com/page",
  );
  assert.equal(extractFirstUrl("no links here"), null);
});

test("textLooksLikeSearchQuestion detects search phrasing but not URLs", () => {
  assert.equal(textLooksLikeSearchQuestion("search the web for FFXIV patch notes"), true);
  assert.equal(textLooksLikeSearchQuestion("look up the best chocobo food"), true);
  assert.equal(
    textLooksLikeSearchQuestion("check https://example.com for the search results"),
    false,
  );
  assert.equal(textLooksLikeSearchQuestion("hello Mana, how are you?"), false);
});

test("textLooksLikeWikiQuestion detects wiki phrasing", () => {
  assert.equal(textLooksLikeWikiQuestion("what does the wiki say about chocobos"), true);
  assert.equal(textLooksLikeWikiQuestion("check wikipedia for moogles"), true);
  assert.equal(textLooksLikeWikiQuestion("hello Mana"), false);
});

test("extractSearchQuery and extractWikiTerm strip the leading phrase", () => {
  assert.equal(extractSearchQuery("search for FFXIV patch notes"), "FFXIV patch notes");
  assert.equal(extractSearchQuery("look up the best chocobo food."), "the best chocobo food");
  assert.equal(extractWikiTerm("wikipedia for moogles"), "moogles");
});

test("searchWeb queries SearXNG and maps results", async () => {
  await withMockedFetch(async (url) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:8890\/search\?format=json&q=/);
    return jsonResponse({
      results: [
        { title: "Result 1", url: "https://a.example/", content: "snippet one" },
        { title: "Result 2", url: "https://b.example/", content: "snippet two" },
      ],
    });
  }, async () => {
    const results = await searchWeb("test query", { limit: 5 });
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], {
      title: "Result 1",
      url: "https://a.example/",
      snippet: "snippet one",
    });
  });
});

test("searchWeb surfaces a clear error when SearXNG is unreachable", async () => {
  await withMockedFetch(async () => {
    throw new Error("connect ECONNREFUSED");
  }, async () => {
    await assert.rejects(() => searchWeb("test"), /Could not reach local SearXNG/);
  });
});

test("wikiLookup resolves a title then fetches its summary", async () => {
  const calls = [];
  await withMockedFetch(async (url) => {
    calls.push(String(url));
    if (String(url).includes("/search/page")) {
      return jsonResponse({ pages: [{ key: "Chocobo", title: "Chocobo" }] });
    }
    return jsonResponse({
      title: "Chocobo",
      extract: "A chocobo is a large bird.",
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Chocobo" } },
    });
  }, async () => {
    const entry = await wikiLookup("chocobo");
    assert.equal(entry.title, "Chocobo");
    assert.match(entry.extract, /large bird/);
    assert.equal(calls.length, 2);
  });
});

test("wikiLookup returns null when nothing matches", async () => {
  await withMockedFetch(async () => jsonResponse({ pages: [] }), async () => {
    const entry = await wikiLookup("asdkjfhaskdjfh");
    assert.equal(entry, null);
  });
});

test("buildWebContextForPrompt reads a pointed-at page over search/wiki", async () => {
  await withMockedDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }], async () => {
    await withMockedFetch(async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name) => (name.toLowerCase() === "content-type" ? "text/html" : null),
      },
      body: null,
      text: async () => "<html><title>Example</title><body>Hello page</body></html>",
    }), async () => {
      const context = await buildWebContextForPrompt(
        "what does it say on https://example.com/page ?",
      );
      assert.match(context, /Page Mana was asked to read/);
      // Framed as outside data, not instructions (ai/untrusted-content.js).
      assert.match(context, /not instructions[\s\S]*<(untrusted-[0-9a-f]+) source="web page">[\s\S]*Hello page[\s\S]*<\/\1>/);
    });
  });
});

test("buildWebContextForPrompt returns empty string for ordinary chat", async () => {
  const context = await buildWebContextForPrompt("hello, how are you today?");
  assert.equal(context, "");
});

test("buildWebContextForPrompt is a no-op when disabled via env", async () => {
  const context = await buildWebContextForPrompt("search for FFXIV news", {
    MANA_WEB_ACCESS_ENABLED: "0",
  });
  assert.equal(context, "");
});

test("fetchPage rejects non-HTML content types", async () => {
  await withMockedDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }], async () => {
    await withMockedFetch(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/pdf" : null) },
      body: null,
      text: async () => "%PDF-1.4",
    }), async () => {
      await assert.rejects(
        () => fetchPage("https://example.com/file.pdf"),
        /not an HTML page/,
      );
    });
  });
});

test("fetchPage re-validates each redirect hop", async () => {
  await withMockedDnsLookup(async (hostname) => {
    if (hostname === "internal.example.com") {
      return [{ address: "10.0.0.9", family: 4 }];
    }
    return [{ address: "93.184.216.34", family: 4 }];
  }, async () => {
    await withMockedFetch(async () => ({
      ok: false,
      status: 302,
      headers: {
        get: (name) =>
          name.toLowerCase() === "location" ? "http://internal.example.com/" : null,
      },
      body: null,
      text: async () => "",
    }), async () => {
      await assert.rejects(
        () => fetchPage("https://example.com/redirect"),
        /private, loopback/,
      );
    });
  });
});

// #908
test("buildWebContextForPrompt answers a mid-game question from that game's wiki only", async () => {
  const game = { name: "Final Fantasy XIV", sites: ["ffxiv.consolegameswiki.com", "finalfantasyxiv.com"] };
  const urls = [];
  await withMockedDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }], async () => {
    await withMockedFetch(async (url) => {
      urls.push(String(url));
      if (String(url).includes("/search?")) {
        return jsonResponse({
          results: [
            { title: "Reddit", url: "https://www.reddit.com/r/ffxiv/dragoon", content: "ignore" },
            { title: "Dragoon", url: "https://ffxiv.consolegameswiki.com/wiki/Dragoon", content: "Unlocked in Gridania" },
            { title: "Evil twin", url: "https://ffxiv.consolegameswiki.com.evil.test/wiki/Dragoon", content: "ignore" },
          ],
        });
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
        body: null,
        text: async () => "<html><body>Dragoon quest: Eye of the Dragon from Ywain.</body></html>",
      };
    }, async () => {
      const context = await buildWebContextForPrompt("Mana, where do I unlock dragoon", {}, game);
      assert.match(decodeURIComponent(urls[0]), /q=where do I unlock dragoon site:/);
      assert.match(decodeURIComponent(urls[0]), /site:ffxiv\.consolegameswiki\.com OR site:finalfantasyxiv\.com/);
      assert.equal(urls[1], "https://ffxiv.consolegameswiki.com/wiki/Dragoon");
      assert.match(context, /<(untrusted-[0-9a-f]+) source="game wiki">[\s\S]*Eye of the Dragon[\s\S]*<\/\1>/);
      assert.match(context, /Eye of the Dragon/);
      assert.match(context, /short sentences/);
      assert.doesNotMatch(context, /reddit|evil/);
    });
  });
});

test("buildWebContextForPrompt skips the game wiki for chat and falls back when the wiki has nothing", async () => {
  const game = { name: "Final Fantasy XIV", sites: ["ffxiv.consolegameswiki.com"] };
  assert.equal(await buildWebContextForPrompt("nice, that was fun", {}, game), "");
  const queries = [];
  await withMockedFetch(async (url) => {
    queries.push(decodeURIComponent(String(url)));
    return jsonResponse({ results: [{ title: "Elsewhere", url: "https://example.com/x", content: "general" }] });
  }, async () => {
    const context = await buildWebContextForPrompt("look up the Pandaemonium raid", {}, game);
    assert.equal(queries.length, 2);
    assert.match(queries[0], /site:/);
    assert.doesNotMatch(queries[1], /site:/);
    assert.match(context, /Web search results:\n.*not instructions[\s\S]*source="web search"/);
  });
});

test("buildWebContextForPrompt stays quiet when the game wiki can't be searched", async () => {
  const game = { name: "Final Fantasy XIV", sites: ["ffxiv.consolegameswiki.com"] };
  const original = console.warn;
  console.warn = () => {};
  try {
    await withMockedFetch(async () => {
      throw new Error("connection refused");
    }, async () => {
      assert.equal(await buildWebContextForPrompt("where is the aetheryte in Limsa?", {}, game), "");
    });
    assert.equal(await buildWebContextForPrompt("where is the aetheryte in Limsa?", { MANA_LOCAL_ONLY: "1" }, game), "");
  } finally {
    console.warn = original;
  }
});

// #945
test("buildWebContextForPrompt gives up on a slow game wiki after about 5 s", async () => {
  const game = { name: "Final Fantasy XIV", sites: ["ffxiv.consolegameswiki.com"] };
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  const started = Date.now();
  const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout's timer doesn't hold the event loop
  try {
    await withMockedFetch((url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason));
    }), async () => {
      assert.equal(await buildWebContextForPrompt("where is the aetheryte in Limsa?", {}, game), "");
    });
  } finally {
    clearInterval(keepAlive);
    console.warn = original;
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4500 && elapsed < 8000, `took ${elapsed} ms`);
  assert.match(warnings.join("\n"), /wiki lookup failed/);
});

test("#963 a typed mid-game question waits past 5 s for the wiki", async () => {
  const game = { name: "Final Fantasy XIV", sites: ["ffxiv.consolegameswiki.com"] };
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await withMockedDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }], async () => {
      await withMockedFetch(async (url, options) => {
        if (String(url).includes("/search?")) {
          // Slower than the spoken 5 s budget, well inside the typed one.
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5500);
            options.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(options.signal.reason);
            });
          });
          return jsonResponse({ results: [{ title: "Aetheryte", url: "https://ffxiv.consolegameswiki.com/wiki/Aetheryte", content: "Limsa Lominsa Lower Decks" }] });
        }
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
          body: null,
          text: async () => "<html><body>The aetheryte plaza is in Lower Decks.</body></html>",
        };
      }, async () => {
        const context = await buildWebContextForPrompt("where is the aetheryte in Limsa?", {}, game, true);
        assert.match(context, /aetheryte plaza/);
        assert.match(context, /and asking: answer/); // not "by voice"
      });
    });
  } finally {
    clearInterval(keepAlive);
  }
});
