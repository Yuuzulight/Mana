# API Request Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight local validation so malformed Mana API requests return stable 400 JSON responses before deeper route logic runs.

**Architecture:** Create a dependency-free `node-bot/request-validation.js` helper module and adopt it in the existing core and mobile route modules. Keep validation at route boundaries, preserve existing valid requests, and avoid logging sensitive request values.

**Tech Stack:** Node.js CommonJS, Express, Multer, Node built-in test runner.

---

## File Structure

- Create `node-bot/request-validation.js`: validation helpers and stable validation-error formatting.
- Create `node-bot/test/request-validation.test.js`: unit tests for helper normalization and errors.
- Create `node-bot/test/server-routes.test.js`: route tests for `/reply`, `/ffxiv/market`, and `/ffxiv/crafting/profit`.
- Modify `node-bot/server-routes.js`: use helpers in core route handlers.
- Modify `node-bot/mobile-routes.js`: use helpers in mobile route handlers.
- Modify `node-bot/test/mobile-routes.test.js`: add invalid-input tests for authenticated mobile routes.
- Modify `docs/roadmap/issue-11-api-validation.md`: record implementation progress and verification.

---

### Task 1: Request Validation Helper

**Files:**
- Create: `node-bot/request-validation.js`
- Create: `node-bot/test/request-validation.test.js`

- [ ] **Step 1: Write failing helper tests**

Create `node-bot/test/request-validation.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ValidationError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireFile,
  requireOneOf,
  requireString,
} = require("../request-validation");

test("requireString returns trimmed text and rejects missing values", () => {
  assert.equal(requireString(" hello ", "text"), "hello");
  assert.throws(() => requireString("", "text"), ValidationError);
  assert.throws(() => requireString("   ", "text"), /text is required/);
  assert.throws(() => requireString(null, "text"), /text is required/);
});

test("optionalString trims strings and returns default for missing values", () => {
  assert.equal(optionalString(" Kujata ", "world", "Adamantoise"), "Kujata");
  assert.equal(optionalString(undefined, "world", "Adamantoise"), "Adamantoise");
  assert.throws(() => optionalString(123, "world"), /world must be a string/);
});

test("optionalInteger enforces integer bounds", () => {
  assert.equal(optionalInteger("10", "limit", { min: 1, max: 25, defaultValue: 5 }), 10);
  assert.equal(optionalInteger(undefined, "limit", { min: 1, max: 25, defaultValue: 5 }), 5);
  assert.throws(() => optionalInteger("0", "limit", { min: 1, max: 25 }), /limit must be between 1 and 25/);
  assert.throws(() => optionalInteger("abc", "limit", { min: 1, max: 25 }), /limit must be an integer/);
});

test("optionalBoolean accepts local API boolean forms", () => {
  assert.equal(optionalBoolean("1", "useSalesHistory", false), true);
  assert.equal(optionalBoolean("true", "useSalesHistory", false), true);
  assert.equal(optionalBoolean("0", "useSalesHistory", true), false);
  assert.equal(optionalBoolean("false", "useSalesHistory", true), false);
  assert.equal(optionalBoolean(undefined, "useSalesHistory", true), true);
  assert.throws(() => optionalBoolean("yes", "useSalesHistory"), /useSalesHistory must be true or false/);
});

test("requireFile rejects missing multipart files", () => {
  const file = { path: "tmp/upload.wav" };
  assert.equal(requireFile(file, "file"), file);
  assert.throws(() => requireFile(null, "file"), /file is required/);
});

test("requireOneOf returns first non-empty value or throws", () => {
  assert.equal(
    requireOneOf([
      { value: "", label: "itemId" },
      { value: "Potion", label: "itemName" },
    ]),
    "Potion",
  );
  assert.throws(
    () => requireOneOf([
      { value: "", label: "itemId" },
      { value: "", label: "itemName" },
    ]),
    /itemId or itemName is required/,
  );
});
```

- [ ] **Step 2: Run helper tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation\node-bot
node --test test\request-validation.test.js
```

Expected: FAIL because `../request-validation` does not exist.

- [ ] **Step 3: Implement `node-bot/request-validation.js`**

Create `node-bot/request-validation.js`:

```js
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

function isMissing(value) {
  return value === undefined || value === null || value === "";
}

function cleanLabel(label) {
  return String(label || "value").trim() || "value";
}

function requireString(value, label) {
  const field = cleanLabel(label);
  if (typeof value !== "string") {
    throw new ValidationError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError(`${field} is required`);
  }
  return trimmed;
}

function optionalString(value, label, defaultValue = "") {
  const field = cleanLabel(label);
  if (isMissing(value)) {
    return defaultValue;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }
  return value.trim();
}

function optionalInteger(value, label, options = {}) {
  const field = cleanLabel(label);
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  if (isMissing(value)) {
    return options.defaultValue;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new ValidationError(`${field} must be an integer`);
  }
  if (number < min || number > max) {
    throw new ValidationError(`${field} must be between ${min} and ${max}`);
  }
  return number;
}

function optionalBoolean(value, label, defaultValue = false) {
  const field = cleanLabel(label);
  if (isMissing(value)) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  throw new ValidationError(`${field} must be true or false`);
}

function requireFile(file, label = "file") {
  const field = cleanLabel(label);
  if (!file) {
    throw new ValidationError(`${field} is required`);
  }
  return file;
}

function requireOneOf(fields) {
  const found = fields.find((field) => !isMissing(field.value));
  if (found) {
    return found.value;
  }
  const labels = fields.map((field) => cleanLabel(field.label));
  const joined = labels.length === 2 ? labels.join(" or ") : labels.join(", ");
  throw new ValidationError(`${joined} is required`);
}

function sendValidationError(res, error, fallbackMessage = "invalid request") {
  const statusCode = error instanceof ValidationError ? error.statusCode : 400;
  const message = error instanceof Error && error.message ? error.message : fallbackMessage;
  return res.status(statusCode).json({ error: message });
}

module.exports = {
  ValidationError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireFile,
  requireOneOf,
  requireString,
  sendValidationError,
};
```

- [ ] **Step 4: Run helper tests to verify they pass**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation\node-bot
node --test test\request-validation.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit helper slice**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation
git add node-bot\request-validation.js node-bot\test\request-validation.test.js
git commit -m "feat: add API request validation helpers"
```

---

### Task 2: Core Route Validation

**Files:**
- Create: `node-bot/test/server-routes.test.js`
- Modify: `node-bot/server-routes.js`

- [ ] **Step 1: Write failing core route tests**

Create `node-bot/test/server-routes.test.js`:

```js
const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../server");

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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

test("reply rejects missing text with a stable validation error", async () => {
  let replyCalls = 0;
  const app = createApp({
    buildAssistantReply: async () => {
      replyCalls += 1;
      return "should not run";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, { text: "   " });

    assert.equal(response.status, 400);
    assert.deepEqual(payload, { error: "text is required" });
    assert.equal(replyCalls, 0);
  });
});

test("ffxiv market rejects requests without item id or item name", async () => {
  let resolveCalls = 0;
  const app = createApp({
    resolveFfxivItemByName: async () => {
      resolveCalls += 1;
      return { itemId: 1, name: "Potion" };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ffxiv/market?itemId=abc`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, { error: "itemId or itemName is required" });
    assert.equal(resolveCalls, 0);
  });
});

test("ffxiv crafting profit rejects out of range limit", async () => {
  let searchCalls = 0;
  const app = createApp({
    findProfitableCrafts: async () => {
      searchCalls += 1;
      return { results: [] };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ffxiv/crafting/profit?limit=100`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(payload, { error: "limit must be between 1 and 25" });
    assert.equal(searchCalls, 0);
  });
});

test("ffxiv crafting profit accepts valid query normalization", async () => {
  let received = null;
  const app = createApp({
    findProfitableCrafts: async (options) => {
      received = options;
      return { results: [] };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/ffxiv/crafting/profit?limit=10&useSalesHistory=true&gatherableOnly=1&historyDays=30&minUnitsSold=5`,
    );

    assert.equal(response.status, 200);
    assert.equal(received.limit, 10);
    assert.equal(received.useSalesHistory, true);
    assert.equal(received.gatherableOnly, true);
    assert.equal(received.historyDays, 30);
    assert.equal(received.minUnitsSold, 5);
  });
});
```

- [ ] **Step 2: Run core route tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation\node-bot
node --test test\server-routes.test.js
```

Expected: FAIL because `/reply` returns `no text`, `/ffxiv/market` reaches deeper resolution, or invalid craft limits are clamped instead of rejected.

- [ ] **Step 3: Import validation helpers in `server-routes.js`**

At the top of `node-bot/server-routes.js`, add:

```js
const {
  ValidationError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireFile,
  requireOneOf,
  requireString,
  sendValidationError,
} = require("./request-validation");
```

- [ ] **Step 4: Validate `/transcribe-only` file**

Change:

```js
if (!req.file) return res.status(400).json({ error: "no file" });
```

to:

```js
requireFile(req.file, "file");
```

In the catch block, before the `console.error`, add:

```js
if (e instanceof ValidationError) {
  return sendValidationError(res, e);
}
```

- [ ] **Step 5: Validate `/ffxiv/market` query**

Replace the initial query parsing in `/ffxiv/market` with:

```js
const world = optionalString(req.query.world, "world", UNIVERSALIS_DEFAULT_WORLD);
let itemName = optionalString(req.query.itemName, "itemName", "");
const rawItemId = req.query.itemId || req.query.itemID || req.query.id;
let itemId = optionalInteger(rawItemId, "itemId", {
  min: 1,
  max: 99999999,
  defaultValue: null,
});
requireOneOf([
  { value: itemId, label: "itemId" },
  { value: itemName, label: "itemName" },
]);
```

In the catch block, return validation errors before logging:

```js
if (e instanceof ValidationError) {
  return sendValidationError(res, e);
}
```

- [ ] **Step 6: Validate `/ffxiv/crafting/profit` query**

Replace route query parsing with:

```js
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
```

In the catch block, return validation errors before logging:

```js
if (e instanceof ValidationError) {
  return sendValidationError(res, e);
}
```

- [ ] **Step 7: Validate `/reply`, `/transcribe`, and `/synthesize`**

For `/reply`, replace text parsing with:

```js
const transcript = requireString(req.body?.text, "text");
```

Use:

```js
const screenText = clampText(
  optionalString(req.body?.screenText, "screenText", ""),
  SCREEN_CONTEXT_MAX_CHARS,
);
const world = optionalString(req.body?.ffxivWorld, "ffxivWorld", UNIVERSALIS_DEFAULT_WORLD);
```

For `/transcribe`, replace missing file check with:

```js
requireFile(req.file, "file");
```

For `/synthesize`, replace text parsing with:

```js
const text = requireString(req.body?.text, "text");
```

For each catch block, return validation errors before logging:

```js
if (e instanceof ValidationError) {
  return sendValidationError(res, e);
}
```

- [ ] **Step 8: Run core route tests to verify they pass**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation\node-bot
node --test test\server-routes.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit core route validation**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation
git add node-bot\server-routes.js node-bot\test\server-routes.test.js
git commit -m "feat: validate core API route inputs"
```

---

### Task 3: Mobile Route Validation

**Files:**
- Modify: `node-bot/mobile-routes.js`
- Modify: `node-bot/test/mobile-routes.test.js`

- [ ] **Step 1: Add failing mobile route tests**

Append these tests to `node-bot/test/mobile-routes.test.js`:

```js
test("mobile unlock rejects missing passcode with validation error", async () => {
  const app = createApp(makeMobileDeps());

  await withServer(app, async (baseUrl) => {
    const { response, body } = await postJson(`${baseUrl}/mobile/auth/unlock`, {});

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "passcode is required" });
  });
});

test("mobile text chat rejects missing text after auth succeeds", async () => {
  let replyCalls = 0;
  const app = createApp(
    makeMobileDeps({
      buildAssistantReply: async () => {
        replyCalls += 1;
        return "should not run";
      },
    }),
  );

  await withServer(app, async (baseUrl) => {
    const token = await unlock(baseUrl);
    const result = await postJson(
      `${baseUrl}/mobile/chat/text`,
      { text: "   " },
      { Authorization: `Bearer ${token}` },
    );

    assert.equal(result.response.status, 400);
    assert.deepEqual(result.body, { error: "text is required" });
    assert.equal(replyCalls, 0);
  });
});

test("mobile summaries reject missing summary after auth succeeds", async () => {
  const app = createApp(makeMobileDeps());

  await withServer(app, async (baseUrl) => {
    const token = await unlock(baseUrl);
    const result = await postJson(
      `${baseUrl}/mobile/summaries`,
      { id: "summary-1" },
      { Authorization: `Bearer ${token}` },
    );

    assert.equal(result.response.status, 400);
    assert.deepEqual(result.body, { error: "summary is required" });
  });
});

test("mobile audio chat rejects missing file after auth succeeds", async () => {
  let normalizeCalls = 0;
  const app = createApp(
    makeMobileDeps({
      normalizeUploadedAudio: () => {
        normalizeCalls += 1;
        throw new Error("should not run");
      },
    }),
  );

  await withServer(app, async (baseUrl) => {
    const token = await unlock(baseUrl);
    const response = await fetch(`${baseUrl}/mobile/chat/audio`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: new FormData(),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "file is required" });
    assert.equal(normalizeCalls, 0);
  });
});
```

- [ ] **Step 2: Run mobile route tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation\node-bot
node --test test\mobile-routes.test.js
```

Expected: FAIL because current mobile routes return older messages or rely on memory-store validation.

- [ ] **Step 3: Import validation helpers in `mobile-routes.js`**

Add near the existing imports:

```js
const {
  ValidationError,
  optionalString,
  requireFile,
  requireString,
  sendValidationError,
} = require("./request-validation");
```

- [ ] **Step 4: Validate `/mobile/auth/unlock`**

Replace:

```js
const passcode = cleanText(req.body?.passcode);
```

with:

```js
let passcode;
try {
  passcode = requireString(req.body?.passcode, "passcode");
} catch (error) {
  if (error instanceof ValidationError) {
    return sendValidationError(res, error);
  }
  throw error;
}
```

- [ ] **Step 5: Validate text and audio mobile routes**

In `/chat/text`, replace `cleanText` parsing and `no text` check with:

```js
const text = requireString(req.body?.text, "text");
```

In `/chat/audio`, replace missing file check with:

```js
requireFile(req.file, "file");
```

In `/synthesize`, replace `cleanText` parsing and `no text` check with:

```js
const text = requireString(req.body?.text, "text");
```

For these catch blocks, return validation errors before logging:

```js
if (error instanceof ValidationError) {
  return sendValidationError(res, error);
}
```

- [ ] **Step 6: Validate `/mobile/summaries`**

Build the summary payload with validated values:

```js
const summary = mobileMemoryStore.saveSummary({
  id: optionalString(req.body?.id, "id", ""),
  source: optionalString(req.body?.source, "source", "phone") || "phone",
  direction: "phone-to-pc",
  chatId: optionalString(req.body?.chatId, "chatId", ""),
  title: optionalString(req.body?.title, "title", ""),
  summary: requireString(req.body?.summary, "summary"),
});
```

If the catch receives a validation error, return `sendValidationError(res, error)`; otherwise preserve the existing `400` memory-store error behavior.

- [ ] **Step 7: Run mobile route tests to verify they pass**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation\node-bot
node --test test\mobile-routes.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit mobile validation**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation
git add node-bot\mobile-routes.js node-bot\test\mobile-routes.test.js
git commit -m "feat: validate mobile API route inputs"
```

---

### Task 4: Documentation And Final Verification

**Files:**
- Modify: `docs/roadmap/issue-11-api-validation.md`

- [ ] **Step 1: Update issue roadmap note**

Append this progress section to `docs/roadmap/issue-11-api-validation.md`:

```md
## Progress

- Added lightweight dependency-free request validation helpers.
- Added stable 400 responses for malformed core and mobile API requests.
- Validated local-first routes without logging sensitive request values.

## Verification

- `node --test test\request-validation.test.js test\server-routes.test.js test\mobile-routes.test.js`
- `node --check request-validation.js`
- `node --check server-routes.js`
- `node --check mobile-routes.js`
- `npm test`
```

- [ ] **Step 2: Run focused validation tests**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation\node-bot
node --test test\request-validation.test.js test\server-routes.test.js test\mobile-routes.test.js
```

Expected: PASS.

- [ ] **Step 3: Run syntax checks**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation\node-bot
node --check request-validation.js
node --check server-routes.js
node --check mobile-routes.js
```

Expected: each exits 0 with no syntax errors.

- [ ] **Step 4: Run full test suite**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation\node-bot
npm test
```

Expected: PASS.

- [ ] **Step 5: Run final repo checks**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation
git status --short --branch
```

Expected: only intended docs changes before the final commit.

- [ ] **Step 6: Commit verification docs**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation
git add docs\roadmap\issue-11-api-validation.md
git commit -m "docs: update API validation roadmap"
```

- [ ] **Step 7: Push branch and update PR**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-11-api-validation
git push
gh pr ready 18
gh pr edit 18 --body-file docs\roadmap\issue-11-api-validation.md
```

Expected: PR #18 is no longer draft and includes the updated implementation notes.
