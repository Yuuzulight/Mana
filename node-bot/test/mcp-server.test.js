const assert = require("node:assert/strict");
const test = require("node:test");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const {
  createMcpServer,
  isMcpServerEnabled,
  startMcpServerStdio,
} = require("../mcp-server");

async function withConnectedClient(deps, fn) {
  const server = createMcpServer(deps);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("isMcpServerEnabled defaults to disabled", () => {
  assert.equal(isMcpServerEnabled({}), false);
  assert.equal(isMcpServerEnabled({ MANA_MCP_SERVER_ENABLED: "0" }), false);
  assert.equal(isMcpServerEnabled({ MANA_MCP_SERVER_ENABLED: "1" }), true);
});

test("startMcpServerStdio refuses to start when disabled", async () => {
  await assert.rejects(
    () => startMcpServerStdio({ env: {} }),
    /MANA_MCP_SERVER_ENABLED/,
  );
});

test("mcp server lists ffxiv_market_lookup, web_search, web_read, and wiki_lookup tools", async () => {
  await withConnectedClient({}, async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "ffxiv_market_lookup",
      "web_read",
      "web_search",
      "wiki_lookup",
    ]);
  });
});

test("ffxiv_market_lookup tool resolves item names and reuses injected market summary fn", async () => {
  const calls = [];
  const deps = {
    UNIVERSALIS_DEFAULT_WORLD: "Kujata",
    resolveFfxivItemByName: async (name) => {
      calls.push(["resolve", name]);
      return { itemId: 5114, name: "Iron Ore" };
    },
    getUniversalisMarketSummary: async (world, itemId, itemName) => {
      calls.push(["summary", world, itemId, itemName]);
      return { world, itemId, itemName, minPrice: 100 };
    },
  };

  await withConnectedClient(deps, async (client) => {
    const result = await client.callTool({
      name: "ffxiv_market_lookup",
      arguments: { itemName: "Iron Ore" },
    });

    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.itemId, 5114);
    assert.equal(payload.minPrice, 100);
    assert.deepEqual(calls, [
      ["resolve", "Iron Ore"],
      ["summary", "Kujata", 5114, "Iron Ore"],
    ]);
  });
});

test("ffxiv_market_lookup tool returns an error result when neither itemId nor itemName is given", async () => {
  await withConnectedClient({}, async (client) => {
    const result = await client.callTool({
      name: "ffxiv_market_lookup",
      arguments: {},
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /itemId or itemName is required/);
  });
});

test("web_search tool passes query and limit through to the injected searchWeb fn", async () => {
  const deps = {
    searchWeb: async (query, options) => {
      assert.equal(query, "ffxiv housing lottery");
      assert.equal(options.limit, 3);
      return [{ title: "Result", url: "https://example.com" }];
    },
  };

  await withConnectedClient(deps, async (client) => {
    const result = await client.callTool({
      name: "web_search",
      arguments: { query: "ffxiv housing lottery", limit: 3 },
    });

    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.query, "ffxiv housing lottery");
    assert.equal(payload.results.length, 1);
  });
});

test("web_read tool returns an error result when fetchPage rejects", async () => {
  const deps = {
    fetchPage: async () => {
      throw new Error("refused to fetch private address");
    },
  };

  await withConnectedClient(deps, async (client) => {
    const result = await client.callTool({
      name: "web_read",
      arguments: { url: "http://127.0.0.1/secret" },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /refused to fetch private address/);
  });
});

test("wiki_lookup tool reports no match without throwing", async () => {
  const deps = {
    wikiLookup: async () => null,
  };

  await withConnectedClient(deps, async (client) => {
    const result = await client.callTool({
      name: "wiki_lookup",
      arguments: { term: "definitely not a real page" },
    });

    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.error, "no matching Wikipedia page");
  });
});
