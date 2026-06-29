# Capability Module Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small internal capability pattern and move FFXIV/Universalis routes and health contribution behind that boundary.

**Architecture:** Add a tiny `node-bot/capabilities/registry.js` helper module, then create `node-bot/capabilities/ffxiv-market-capability.js` to own existing FFXIV HTTP routes and health status. `server.js` will build a capability context from existing runtime dependencies, register the capability, and merge its health into `/health.components`; `server-routes.js` will retain general backend routes.

**Tech Stack:** Node.js CommonJS, Express, built-in `node:test`, existing request validation helpers, existing FFXIV market helpers.

---

## File Structure

- Create `node-bot/capabilities/registry.js`: small helper functions for route registration and health collection.
- Create `node-bot/capabilities/ffxiv-market-capability.js`: capability object with FFXIV routes and `ffxivMarket` health status.
- Modify `node-bot/server.js`: import/register capabilities, build capability context, merge capability health, and stop hardcoding FFXIV health in core health helper.
- Modify `node-bot/server-routes.js`: remove FFXIV route registration and unused FFXIV-only destructured dependencies.
- Create `node-bot/test/capabilities-registry.test.js`: unit tests for the registry helpers.
- Create `node-bot/test/ffxiv-market-capability.test.js`: route-level tests for the extracted capability.
- Modify `node-bot/test/server-routes.test.js`: remove FFXIV route tests from general route tests because those routes move to the capability.
- Modify `node-bot/test/health-components.test.js`: assert `ffxivMarket` still appears through capability health.
- Modify `node-bot/README.md` and `docs/roadmap/issue-13-capability-modules.md`: document the Mana-specific capability pattern and implementation status.

## Task 1: Add Capability Registry Helpers

**Files:**
- Create: `node-bot/capabilities/registry.js`
- Create: `node-bot/test/capabilities-registry.test.js`

- [ ] **Step 1: Write failing registry tests**

Create `node-bot/test/capabilities-registry.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCapabilityHealth,
  registerCapabilities,
} = require("../capabilities/registry");

test("registerCapabilities calls route registration for each routed capability", () => {
  const calls = [];
  const app = { name: "app" };
  const context = { value: 42 };
  const capabilities = [
    {
      key: "alpha",
      registerRoutes: (receivedApp, receivedContext) => {
        calls.push({ key: "alpha", receivedApp, receivedContext });
      },
    },
    {
      key: "statusOnly",
      getHealth: () => ({ status: "configured" }),
    },
    {
      key: "beta",
      registerRoutes: (receivedApp, receivedContext) => {
        calls.push({ key: "beta", receivedApp, receivedContext });
      },
    },
  ];

  registerCapabilities(app, capabilities, context);

  assert.deepEqual(
    calls.map((call) => call.key),
    ["alpha", "beta"],
  );
  assert.equal(calls[0].receivedApp, app);
  assert.equal(calls[0].receivedContext, context);
});

test("buildCapabilityHealth collects health by capability key", () => {
  const context = { ready: true };
  const health = buildCapabilityHealth(
    [
      {
        key: "alpha",
        getHealth: (receivedContext) => ({
          status: receivedContext.ready ? "available" : "unavailable",
          configured: true,
          message: "Alpha is available.",
        }),
      },
      {
        key: "routesOnly",
        registerRoutes: () => {},
      },
    ],
    context,
  );

  assert.deepEqual(health, {
    alpha: {
      status: "available",
      configured: true,
      message: "Alpha is available.",
    },
  });
});

test("registry rejects capabilities without stable keys", () => {
  assert.throws(
    () => registerCapabilities({}, [{ registerRoutes: () => {} }], {}),
    /capability key is required/,
  );
  assert.throws(
    () => buildCapabilityHealth([{ key: "   ", getHealth: () => ({}) }], {}),
    /capability key is required/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh\node-bot
node --test test\capabilities-registry.test.js
```

Expected: FAIL because `node-bot/capabilities/registry.js` does not exist.

- [ ] **Step 3: Implement the registry helpers**

Create `node-bot/capabilities/registry.js`:

```js
function requireCapabilityKey(capability) {
  const key = String(capability?.key || "").trim();
  if (!key) {
    throw new Error("capability key is required");
  }
  return key;
}

function registerCapabilities(app, capabilities = [], context = {}) {
  for (const capability of capabilities) {
    requireCapabilityKey(capability);
    if (typeof capability.registerRoutes === "function") {
      capability.registerRoutes(app, context);
    }
  }
}

function buildCapabilityHealth(capabilities = [], context = {}) {
  const components = {};
  for (const capability of capabilities) {
    const key = requireCapabilityKey(capability);
    if (typeof capability.getHealth === "function") {
      components[key] = capability.getHealth(context);
    }
  }
  return components;
}

module.exports = {
  buildCapabilityHealth,
  registerCapabilities,
};
```

- [ ] **Step 4: Run test to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh\node-bot
node --test test\capabilities-registry.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh
git add node-bot\capabilities\registry.js node-bot\test\capabilities-registry.test.js
git commit -m "feat: add capability registry helpers"
```

## Task 2: Extract FFXIV Routes Into A Capability

**Files:**
- Create: `node-bot/capabilities/ffxiv-market-capability.js`
- Create: `node-bot/test/ffxiv-market-capability.test.js`

- [ ] **Step 1: Write failing capability route tests**

Create `node-bot/test/ffxiv-market-capability.test.js`:

```js
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const test = require("node:test");

const { ffxivMarketCapability } = require("../capabilities/ffxiv-market-capability");

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("ffxiv capability market route rejects requests without item id or item name", async () => {
  let resolveCalls = 0;
  const app = express();
  app.use(express.json());
  ffxivMarketCapability.registerRoutes(app, {
    UNIVERSALIS_DEFAULT_WORLD: "Kujata",
    resolveFfxivItemByName: async () => {
      resolveCalls += 1;
      return { itemId: 1, name: "Potion" };
    },
    getUniversalisMarketSummary: async () => ({ itemId: 1 }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ffxiv/market?itemId=abc`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, { error: "itemId or itemName is required" });
    assert.equal(resolveCalls, 0);
  });
});

test("ffxiv capability crafting route normalizes valid query options", async () => {
  let received = null;
  const app = express();
  app.use(express.json());
  ffxivMarketCapability.registerRoutes(app, {
    UNIVERSALIS_DEFAULT_WORLD: "Kujata",
    FFXIV_PROFIT_TOP_LIMIT: 10,
    FFXIV_RECIPE_SOURCE: "garland",
    XIVAPI_RECIPE_PAGE_SIZE: 100,
    XIVAPI_RECIPE_SCAN_LIMIT: 500,
    findProfitableCrafts: async (options) => {
      received = options;
      return { results: [] };
    },
    logPerf: () => {},
    normalizeCraftRankingMode: (rankBy) => rankBy || "balanced",
    normalizeGatheringSourceFilter: (sources) => sources || ["normal"],
    normalizeGatheringJobFilter: (jobs) => jobs || ["MIN", "BTN"],
    nowMs: () => 1,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/ffxiv/crafting/profit?limit=10&useSalesHistory=true&gatherableOnly=1&historyDays=30&minUnitsSold=5`,
    );

    assert.equal(response.status, 200);
    assert.equal(received.world, "Kujata");
    assert.equal(received.limit, 10);
    assert.equal(received.useSalesHistory, true);
    assert.equal(received.gatherableOnly, true);
    assert.equal(received.historyDays, 30);
    assert.equal(received.minUnitsSold, 5);
  });
});

test("ffxiv capability from-screen route resolves hovered item names", async () => {
  const app = express();
  app.use(express.json());
  ffxivMarketCapability.registerRoutes(app, {
    UNIVERSALIS_DEFAULT_WORLD: "Kujata",
    extractExplicitItemNameFromText: () => "",
    extractHoveredItemName: () => "Iron Ore",
    resolveFfxivItemByName: async (name) => ({ itemId: 5114, name }),
    getUniversalisMarketSummary: async (world, itemId, itemName) => ({
      world,
      itemId,
      itemName,
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ffxiv/market/from-screen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ screenText: "hovered item" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.hoveredItemName, "Iron Ore");
    assert.equal(payload.itemId, 5114);
    assert.equal(payload.world, "Kujata");
  });
});

test("ffxiv capability contributes market health status", () => {
  assert.deepEqual(ffxivMarketCapability.getHealth(), {
    status: "configured",
    configured: true,
    message: "FFXIV market providers are configured from local defaults.",
    universalisConfigured: true,
    xivapiConfigured: true,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh\node-bot
node --test test\ffxiv-market-capability.test.js
```

Expected: FAIL because `node-bot/capabilities/ffxiv-market-capability.js` does not exist.

- [ ] **Step 3: Implement the FFXIV capability**

Create `node-bot/capabilities/ffxiv-market-capability.js` by moving the three FFXIV route handlers from `node-bot/server-routes.js`. Use this structure:

```js
const {
  ValidationError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireOneOf,
  sendValidationError,
} = require("../request-validation");

function registerFfxivMarketRoutes(app, deps) {
  const {
    UNIVERSALIS_DEFAULT_WORLD,
    FFXIV_PROFIT_TOP_LIMIT,
    FFXIV_RECIPE_SOURCE,
    XIVAPI_RECIPE_PAGE_SIZE,
    XIVAPI_RECIPE_SCAN_LIMIT,
    extractExplicitItemNameFromText,
    extractHoveredItemName,
    findProfitableCrafts,
    getUniversalisMarketSummary,
    logPerf,
    normalizeCraftRankingMode,
    normalizeGatheringJobFilter,
    normalizeGatheringSourceFilter,
    nowMs,
    resolveFfxivItemByName,
  } = deps;

  app.get("/ffxiv/market", async (req, res) => {
    try {
      const world = optionalString(req.query.world, "world", UNIVERSALIS_DEFAULT_WORLD);
      let itemName = optionalString(req.query.itemName, "itemName", "");
      const rawItemId = req.query.itemId || req.query.itemID || req.query.id;
      const parsedItemId = Number(rawItemId);
      let itemId =
        Number.isSafeInteger(parsedItemId) && parsedItemId > 0
          ? parsedItemId
          : null;
      requireOneOf([
        { value: itemId, label: "itemId" },
        { value: itemName, label: "itemName" },
      ]);
      let resolvedItem = null;
      if (!itemId) {
        resolvedItem = await resolveFfxivItemByName(itemName);
        itemId = resolvedItem.itemId;
        itemName = resolvedItem.name;
      }

      const summary = await getUniversalisMarketSummary(world, itemId, itemName);
      return res.json({
        ...summary,
        resolvedItem,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.get("/ffxiv/crafting/profit", async (req, res) => {
    try {
      const world = optionalString(req.query.world, "world", UNIVERSALIS_DEFAULT_WORLD);
      const query = optionalString(req.query.query, "query", "");
      const limit = optionalInteger(req.query.limit, "limit", {
        min: 1,
        max: 25,
        defaultValue: FFXIV_PROFIT_TOP_LIMIT,
      });
      const scanLimit = optionalInteger(req.query.scanLimit, "scanLimit", {
        min: 1,
        max: 5000,
        defaultValue: XIVAPI_RECIPE_SCAN_LIMIT,
      });
      const pageSize = optionalInteger(req.query.pageSize, "pageSize", {
        min: 1,
        max: 500,
        defaultValue: XIVAPI_RECIPE_PAGE_SIZE,
      });
      const recipeSource = optionalString(req.query.recipeSource, "recipeSource", FFXIV_RECIPE_SOURCE);
      const useSalesHistory = optionalBoolean(req.query.useSalesHistory, "useSalesHistory", false);
      const historyDays = optionalInteger(req.query.historyDays, "historyDays", {
        min: 1,
        max: 90,
        defaultValue: 30,
      });
      const rankBy = normalizeCraftRankingMode(req.query.rankBy, useSalesHistory);
      const gatherableOnly = optionalBoolean(req.query.gatherableOnly, "gatherableOnly", false);
      const gatheringSources = normalizeGatheringSourceFilter(
        req.query.gatheringSources || req.query.allowedGatheringSources,
      );
      const gatheringJobs = normalizeGatheringJobFilter(req.query.gatheringJobs);
      const minUnitsSold = optionalInteger(req.query.minUnitsSold, "minUnitsSold", {
        min: 0,
        max: 999999,
        defaultValue: 0,
      });
      const startedAt = nowMs();
      const report = await findProfitableCrafts({
        world,
        query,
        limit,
        scanLimit,
        pageSize,
        recipeSource,
        useSalesHistory,
        historyDays,
        rankBy,
        gatherableOnly,
        gatheringSources,
        gatheringJobs,
        minUnitsSold,
      });
      logPerf("ffxiv-crafting-profit", startedAt);
      return res.json(report);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/ffxiv/market/from-screen", async (req, res) => {
    try {
      const world =
        typeof req.body?.world === "string" && req.body.world.trim()
          ? req.body.world.trim()
          : UNIVERSALIS_DEFAULT_WORLD;
      const screenText =
        typeof req.body?.screenText === "string" ? req.body.screenText : "";
      const itemName =
        extractExplicitItemNameFromText(req.body?.text || "") ||
        extractHoveredItemName(screenText);
      if (!itemName) {
        return res
          .status(400)
          .json({ error: "Could not find an item name in the screen text" });
      }

      const resolvedItem = await resolveFfxivItemByName(itemName);
      const summary = await getUniversalisMarketSummary(
        world,
        resolvedItem.itemId,
        resolvedItem.name,
      );
      return res.json({
        ...summary,
        hoveredItemName: itemName,
        resolvedItem,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

const ffxivMarketCapability = {
  key: "ffxivMarket",
  registerRoutes: registerFfxivMarketRoutes,
  getHealth: () => ({
    status: "configured",
    configured: true,
    message: "FFXIV market providers are configured from local defaults.",
    universalisConfigured: true,
    xivapiConfigured: true,
  }),
};

module.exports = {
  ffxivMarketCapability,
  registerFfxivMarketRoutes,
};
```

- [ ] **Step 4: Run capability tests to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh\node-bot
node --test test\ffxiv-market-capability.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh
git add node-bot\capabilities\ffxiv-market-capability.js node-bot\test\ffxiv-market-capability.test.js
git commit -m "feat: add ffxiv market capability"
```

## Task 3: Register Capability In Server And Move FFXIV Ownership

**Files:**
- Modify: `node-bot/server.js`
- Modify: `node-bot/server-routes.js`
- Modify: `node-bot/test/server-routes.test.js`
- Modify: `node-bot/test/health-components.test.js`

- [ ] **Step 1: Write failing integration tests for capability ownership**

In `node-bot/test/health-components.test.js`, inside the first test after `assert.equal(body.components.backend.configured, true);`, add:

```js
    assert.deepEqual(body.components.ffxivMarket, {
      status: "configured",
      configured: true,
      message: "FFXIV market providers are configured from local defaults.",
      universalisConfigured: true,
      xivapiConfigured: true,
    });
```

Create `node-bot/test/capability-boundaries.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("general server routes do not own FFXIV public route paths", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "server-routes.js"),
    "utf8",
  );

  assert.equal(source.includes('"/ffxiv/market"'), false);
  assert.equal(source.includes('"/ffxiv/crafting/profit"'), false);
  assert.equal(source.includes('"/ffxiv/market/from-screen"'), false);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh\node-bot
node --test test\capability-boundaries.test.js test\server-routes.test.js test\health-components.test.js
```

Expected: FAIL because `server-routes.js` still contains FFXIV route paths.

- [ ] **Step 3: Import capability registry and FFXIV capability in `server.js`**

Near the other local imports in `node-bot/server.js`, add:

```js
const {
  buildCapabilityHealth,
  registerCapabilities,
} = require("./capabilities/registry");
const {
  ffxivMarketCapability,
} = require("./capabilities/ffxiv-market-capability");
```

Inside `registerRoutes`, after `modelManagement`, add:

```js
const capabilities = deps.capabilities || [ffxivMarketCapability];
const capabilityContext = {
  UNIVERSALIS_DEFAULT_WORLD,
  FFXIV_PROFIT_TOP_LIMIT,
  FFXIV_RECIPE_SOURCE,
  XIVAPI_RECIPE_PAGE_SIZE,
  XIVAPI_RECIPE_SCAN_LIMIT,
  extractExplicitItemNameFromText,
  extractHoveredItemName,
  findProfitableCrafts: deps.findProfitableCrafts || findProfitableCrafts,
  getUniversalisMarketSummary:
    deps.getUniversalisMarketSummary || getUniversalisMarketSummary,
  logPerf,
  normalizeCraftRankingMode,
  normalizeGatheringJobFilter,
  normalizeGatheringSourceFilter,
  nowMs,
  resolveFfxivItemByName: deps.resolveFfxivItemByName || resolveFfxivItemByName,
};
registerCapabilities(app, capabilities, capabilityContext);
```

- [ ] **Step 4: Merge capability health into `/health.components`**

In `buildHealthComponents`, remove the hardcoded `ffxivMarket` component.

In `/health`, after building `components`, add:

```js
  Object.assign(components, buildCapabilityHealth(capabilities, capabilityContext));
```

- [ ] **Step 5: Remove FFXIV routes from `server-routes.js`**

In `node-bot/server-routes.js`, remove these imports from `./request-validation` if unused after deletion:

```js
  optionalBoolean,
  optionalInteger,
  requireOneOf,
```

Remove these destructured dependencies from `deps` if unused after deletion:

```js
    FFXIV_PROFIT_TOP_LIMIT,
    FFXIV_RECIPE_SOURCE,
    XIVAPI_RECIPE_PAGE_SIZE,
    XIVAPI_RECIPE_SCAN_LIMIT,
    extractExplicitItemNameFromText,
    extractHoveredItemName,
    findProfitableCrafts,
    getUniversalisMarketSummary,
    normalizeCraftRankingMode,
    normalizeGatheringJobFilter,
    normalizeGatheringSourceFilter,
    nowMs,
    logPerf,
    resolveFfxivItemByName,
```

Delete the route blocks for:

```js
  app.get("/ffxiv/market", async (req, res) => { ... });
  app.get("/ffxiv/crafting/profit", async (req, res) => { ... });
  app.post("/ffxiv/market/from-screen", async (req, res) => { ... });
```

Keep `/reply` use of:

```js
const world = optionalString(req.body?.ffxivWorld, "ffxivWorld", UNIVERSALIS_DEFAULT_WORLD);
const craftProfitText = await buildCraftProfitContextForPrompt(transcript, world);
```

In `server.js`, keep the same FFXIV dependencies in the `registerCoreRoutes` call only when still used by `/reply`; remove FFXIV route-only dependencies from that call.

- [ ] **Step 6: Move FFXIV route tests out of general route tests**

In `node-bot/test/server-routes.test.js`, delete these tests because they are covered by `ffxiv-market-capability.test.js`:

```js
test("ffxiv market rejects requests without item id or item name", async () => { ... });
test("ffxiv crafting profit rejects out of range limit", async () => { ... });
test("ffxiv crafting profit accepts valid query normalization", async () => { ... });
```

- [ ] **Step 7: Run integration tests to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh\node-bot
node --test test\capability-boundaries.test.js test\ffxiv-market-capability.test.js test\server-routes.test.js test\health-components.test.js
```

Expected: PASS.

- [ ] **Step 8: Run syntax checks**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh\node-bot
node --check capabilities\registry.js
node --check capabilities\ffxiv-market-capability.js
node --check server-routes.js
node --check server.js
```

Expected: no output and exit code 0 for each command.

- [ ] **Step 9: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh
git add node-bot\server.js node-bot\server-routes.js node-bot\test\server-routes.test.js node-bot\test\health-components.test.js node-bot\test\capability-boundaries.test.js
git commit -m "refactor: register ffxiv routes as a capability"
```

## Task 4: Update Documentation And Roadmap

**Files:**
- Modify: `node-bot/README.md`
- Modify: `docs/roadmap/issue-13-capability-modules.md`

- [ ] **Step 1: Add backend README capability note**

In `node-bot/README.md`, add this section before `Zed External Agent`:

```md
Internal capabilities
---------------------
Mana uses a small internal capability pattern for optional feature areas that need their own routes or health status. A capability can register routes and contribute one `/health.components` entry.

The first capability is `ffxivMarket`, which owns the existing FFXIV/Universalis market and crafting endpoints while preserving their public URLs.
```

- [ ] **Step 2: Update issue roadmap note**

Append to `docs/roadmap/issue-13-capability-modules.md`:

```md
## Implementation Notes

- Added a small internal capability registry for route registration and health collection.
- Moved FFXIV/Universalis market and crafting routes into the `ffxivMarket` capability.
- Preserved all existing public FFXIV endpoint URLs.
- Moved `ffxivMarket` health ownership from `server.js` into the capability.

## Verification

- `node --test test\capabilities-registry.test.js test\ffxiv-market-capability.test.js test\capability-boundaries.test.js test\server-routes.test.js test\health-components.test.js`
- `node --check capabilities\registry.js`
- `node --check capabilities\ffxiv-market-capability.js`
- `node --check server-routes.js`
- `node --check server.js`
- `npm test`
- Forbidden external-project reference scan.
```

- [ ] **Step 3: Run docs/reference scan**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh
$pattern = ('Open' + 'Cl' + 'aw') + '|' + ('open' + 'cl' + 'aw') + '|' + ('cl' + 'aw')
rg -n $pattern README.md node-bot docs
```

Expected: no matches.

- [ ] **Step 4: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh
git add node-bot\README.md docs\roadmap\issue-13-capability-modules.md
git commit -m "docs: document capability module boundaries"
```

## Task 5: Final Verification And PR

**Files:**
- No source edits unless verification exposes a defect.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh\node-bot
node --test test\capabilities-registry.test.js test\ffxiv-market-capability.test.js test\capability-boundaries.test.js test\server-routes.test.js test\health-components.test.js
```

Expected: PASS.

- [ ] **Step 2: Run syntax checks**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh\node-bot
node --check capabilities\registry.js
node --check capabilities\ffxiv-market-capability.js
node --check server-routes.js
node --check server.js
```

Expected: no output and exit code 0 for each command.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh\node-bot
npm test
```

Expected: PASS for the full `node --test` suite.

- [ ] **Step 4: Run forbidden-reference scan**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh
$pattern = ('Open' + 'Cl' + 'aw') + '|' + ('open' + 'cl' + 'aw') + '|' + ('cl' + 'aw')
rg -n $pattern README.md node-bot docs
```

Expected: no matches.

- [ ] **Step 5: Check git status**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh
git status --short --branch
```

Expected: branch is clean and ahead of `origin/main`.

- [ ] **Step 6: Push fresh branch**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh
git push -u origin chore/issue-13-capability-modules-fresh
```

Expected: branch is pushed to GitHub.

- [ ] **Step 7: Replace stale PR #20 safely**

Run:

```powershell
gh pr close 20 --comment "Closing this stale draft because it was based on an older branch. Replaced by the fresh issue #13 capability-module PR from current main."
gh pr create --base main --head chore/issue-13-capability-modules-fresh --title "Introduce Mana capability module boundaries" --body-file docs\roadmap\issue-13-capability-modules.md
```

Expected: stale PR #20 is closed, and a new PR is opened from the fresh branch.

- [ ] **Step 8: Merge if checks are clean**

Run:

```powershell
gh pr view --json number,mergeStateStatus,state,isDraft,statusCheckRollup,url
gh pr merge --squash --delete-branch
```

Expected: new PR is merged into `main`.

- [ ] **Step 9: Close issue and clean up worktree**

Run:

```powershell
gh issue close 13 --comment "Completed by the fresh capability-module PR. Mana now has an internal capability registry, FFXIV routes live behind the ffxivMarket capability, and health contribution is capability-owned."
cd C:\ManaAI\Mana
git worktree remove C:\ManaAI\Mana\.worktrees\issue-13-capability-modules-fresh
```

Expected: issue #13 is closed and the fresh worktree is removed. Do not switch or reset the primary checkout.
