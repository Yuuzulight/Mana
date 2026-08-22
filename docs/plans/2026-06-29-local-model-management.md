# Local Model Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local model profile listing, missing-file status, and runtime profile switching for Mana's local AI stack.

**Architecture:** Extend the existing local AI profile helpers with profile metadata and a `fast` profile, then add a focused `node-bot/model-management.js` runtime manager. Register model-management routes in `server.js`, inject the manager into `server-routes.js`, and let `/reply` use the active profile only when the request does not include an explicit profile.

**Tech Stack:** Node.js CommonJS, Express, built-in `node:test`, local filesystem scanning, existing llama.cpp runtime helpers.

---

## File Structure

- Modify `node-bot/ai/local-ai.js`: add profile labels, `fast` profile, valid-profile helpers, and status-building support primitives.
- Create `node-bot/model-management.js`: own runtime active-profile state and build `/models/status` payloads.
- Modify `node-bot/server.js`: create one model manager per app, register `/models/*` routes, pass active profile helpers to core routes, export only what tests need.
- Modify `node-bot/server-routes.js`: distinguish omitted `modelProfile` from explicit `modelProfile` and use the active profile fallback.
- Modify tests:
  - `node-bot/test/local-ai.test.js`
  - `node-bot/test/llama-model-selection.test.js`
  - create `node-bot/test/model-management.test.js`
  - extend `node-bot/test/server-routes.test.js`
- Modify `node-bot/README.md` and `docs/roadmap/issue-12-local-model-management.md`: document endpoints and implementation status.

## Task 1: Add `fast` Profile And Profile Metadata

**Files:**
- Modify: `node-bot/ai/local-ai.js`
- Modify: `node-bot/test/local-ai.test.js`
- Modify: `node-bot/test/llama-model-selection.test.js`

- [ ] **Step 1: Write failing tests for the `fast` profile and known profile list**

In `node-bot/test/local-ai.test.js`, update the import:

```js
const {
  findPreferredLlamaModel,
  getKnownLlamaModelProfiles,
  normalizeLlamaModelProfile,
  pickPreferredLlamaModel,
  selectLlamaModelProfileForPrompt,
  shouldUseRemoteAi,
} = require("../ai/local-ai");
```

Add this test:

```js
test("local AI module exposes known profiles including fast fallback", () => {
  assert.deepEqual(getKnownLlamaModelProfiles(), [
    "default",
    "fast",
    "quality",
    "coding",
  ]);
  assert.equal(normalizeLlamaModelProfile("FAST"), "fast");
});
```

In `node-bot/test/llama-model-selection.test.js`, add:

```js
test("findPreferredLlamaModel uses 1.5B first for fast profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-models-"));
  const onePointFiveB = path.join(root, "qwen2.5-1.5b-instruct-q4_k_m.gguf");
  const fourB = path.join(root, "Qwen3-4B-Q4_K_M.gguf");
  const eightB = path.join(root, "Qwen3-8B-Q4_K_M.gguf");

  try {
    touch(fourB);
    touch(eightB);
    touch(onePointFiveB);

    assert.equal(
      pickPreferredLlamaModel({
        explicitModel: "",
        localGgufs: [fourB, eightB, onePointFiveB],
        profile: "fast",
      }),
      onePointFiveB,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management\node-bot
node --test test\local-ai.test.js test\llama-model-selection.test.js
```

Expected: FAIL because `getKnownLlamaModelProfiles` is not exported and `fast` is not a known profile.

- [ ] **Step 3: Add minimal profile metadata and `fast` profile**

In `node-bot/ai/local-ai.js`, replace `LLAMA_MODEL_PROFILES` with:

```js
const LLAMA_MODEL_PROFILES = {
  default: {
    label: "Default chat",
    names: [
      "Qwen3-4B-Q4_K_M.gguf",
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "Qwen3-8B-Q4_K_M.gguf",
    ],
  },
  fast: {
    label: "Fast fallback",
    names: [
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "Qwen3-4B-Q4_K_M.gguf",
      "Qwen3-8B-Q4_K_M.gguf",
    ],
  },
  quality: {
    label: "Quality fallback",
    names: [
      "Qwen3-8B-Q4_K_M.gguf",
      "Qwen3-4B-Q4_K_M.gguf",
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    ],
  },
  coding: {
    label: "Coding",
    names: [
      "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
      "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
      "Qwen3-4B-Q4_K_M.gguf",
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "Qwen3-8B-Q4_K_M.gguf",
    ],
  },
};
```

Add:

```js
function getKnownLlamaModelProfiles() {
  return Object.keys(LLAMA_MODEL_PROFILES);
}

function isKnownLlamaModelProfile(profile) {
  if (typeof profile !== "string") {
    return false;
  }
  return Boolean(LLAMA_MODEL_PROFILES[profile.trim().toLowerCase()]);
}
```

Export both functions from `module.exports`.

- [ ] **Step 4: Run tests to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management\node-bot
node --test test\local-ai.test.js test\llama-model-selection.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management
git add node-bot\ai\local-ai.js node-bot\test\local-ai.test.js node-bot\test\llama-model-selection.test.js
git commit -m "feat: add fast local model profile"
```

## Task 2: Add Model Management Runtime

**Files:**
- Create: `node-bot/model-management.js`
- Create: `node-bot/test/model-management.test.js`

- [ ] **Step 1: Write failing tests for model status and active profile state**

Create `node-bot/test/model-management.test.js`:

```js
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createModelManagement } = require("../model-management");

test("model management reports available and missing profile candidates", () => {
  const root = path.join("C:", "ManaAI", "Mana", "tools", "llama", "gguf-models");
  const fourB = path.join(root, "Qwen3-4B-Q4_K_M.gguf");
  const onePointFiveB = path.join(root, "qwen2.5-1.5b-instruct-q4_k_m.gguf");
  const manager = createModelManagement({
    env: {},
    localGgufs: [fourB, onePointFiveB],
  });

  const status = manager.getModelStatus();

  assert.equal(status.activeProfile, "default");
  assert.equal(status.remoteAiEnabled, false);
  assert.equal(status.remoteAiWarning, null);
  assert.equal(status.profiles.default.label, "Default chat");
  assert.equal(status.profiles.default.available, true);
  assert.equal(status.profiles.default.selectedModel, fourB);
  assert.equal(status.profiles.fast.selectedModel, onePointFiveB);
  assert.equal(
    status.profiles.quality.missing.includes("Qwen3-8B-Q4_K_M.gguf"),
    true,
  );
  assert.deepEqual(
    status.profiles.default.candidates.map((candidate) => candidate.name),
    [
      "Qwen3-4B-Q4_K_M.gguf",
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "Qwen3-8B-Q4_K_M.gguf",
    ],
  );
});

test("model management switches active profile and rejects unknown profiles", () => {
  const manager = createModelManagement({ env: {}, localGgufs: [] });

  assert.equal(manager.getActiveProfile(), "default");
  assert.equal(manager.setActiveProfile("coding").activeProfile, "coding");
  assert.equal(manager.getActiveProfile(), "coding");
  assert.throws(
    () => manager.setActiveProfile("unknown"),
    /profile must be one of: default, fast, quality, coding/,
  );
  assert.equal(manager.getActiveProfile(), "coding");
});

test("model management warns when remote AI is enabled", () => {
  const manager = createModelManagement({
    env: {
      OPENAI_API_KEY: "present",
      MANA_ALLOW_REMOTE_AI: "1",
    },
    localGgufs: [],
  });

  const status = manager.getModelStatus();

  assert.equal(status.remoteAiEnabled, true);
  assert.match(status.remoteAiWarning, /Remote AI is enabled/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management\node-bot
node --test test\model-management.test.js
```

Expected: FAIL because `node-bot/model-management.js` does not exist.

- [ ] **Step 3: Implement the model manager**

Create `node-bot/model-management.js`:

```js
const path = require("node:path");
const {
  DEFAULT_LLAMA_MODEL,
  LLAMA_MODEL_PROFILES,
  collectFilesRecursively,
  getKnownLlamaModelProfiles,
  isKnownLlamaModelProfile,
  normalizeLlamaModelProfile,
  pickPreferredLlamaModel,
  shouldUseRemoteAi,
} = require("./ai/local-ai");

function createModelManagement(options = {}) {
  const env = options.env || process.env;
  const searchDir =
    options.searchDir || path.join(__dirname, "..", "tools", "llama");
  const collectLocalGgufs =
    options.collectLocalGgufs ||
    (() =>
      options.localGgufs ||
      collectFilesRecursively(searchDir, (fullPath) =>
        fullPath.toLowerCase().endsWith(".gguf"),
      ));
  let activeProfile = normalizeLlamaModelProfile(options.activeProfile || "default");

  function getActiveProfile() {
    return activeProfile;
  }

  function buildProfileStatus(profile, localGgufs) {
    const definition = LLAMA_MODEL_PROFILES[profile];
    const selectedModel = pickPreferredLlamaModel({
      explicitModel: env.LLAMA_MODEL || "",
      localGgufs,
      profile,
      defaultModel: DEFAULT_LLAMA_MODEL,
    });
    const candidates = definition.names.map((name) => {
      const match = localGgufs.find(
        (fullPath) => path.basename(fullPath).toLowerCase() === name.toLowerCase(),
      );
      return {
        name,
        path: match || null,
        exists: Boolean(match),
      };
    });

    return {
      key: profile,
      label: definition.label,
      selectedModel,
      available: candidates.some((candidate) => candidate.exists),
      candidates,
      missing: candidates
        .filter((candidate) => !candidate.exists)
        .map((candidate) => candidate.name),
    };
  }

  function getModelStatus() {
    const localGgufs = collectLocalGgufs();
    const profiles = {};
    for (const profile of getKnownLlamaModelProfiles()) {
      profiles[profile] = buildProfileStatus(profile, localGgufs);
    }

    const remoteAiEnabled = shouldUseRemoteAi({
      apiKey: env.OPENAI_API_KEY || null,
      allowRemoteAi: env.MANA_ALLOW_REMOTE_AI || "",
    });

    return {
      activeProfile,
      remoteAiEnabled,
      remoteAiWarning: remoteAiEnabled
        ? "Remote AI is enabled. Mana may use paid or proxy chat replies."
        : null,
      profiles,
    };
  }

  function setActiveProfile(profile) {
    if (!isKnownLlamaModelProfile(profile)) {
      throw new Error(
        `profile must be one of: ${getKnownLlamaModelProfiles().join(", ")}`,
      );
    }
    activeProfile = normalizeLlamaModelProfile(profile);
    return getModelStatus();
  }

  return {
    getActiveProfile,
    getModelStatus,
    setActiveProfile,
  };
}

module.exports = {
  createModelManagement,
};
```

- [ ] **Step 4: Run test to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management\node-bot
node --test test\model-management.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management
git add node-bot\model-management.js node-bot\test\model-management.test.js
git commit -m "feat: add local model management runtime"
```

## Task 3: Add Model Management Backend Routes

**Files:**
- Modify: `node-bot/server.js`
- Modify: `node-bot/test/server-routes.test.js`

- [ ] **Step 1: Write failing route tests**

In `node-bot/test/server-routes.test.js`, add:

```js
test("model status route reports active profile and configured profiles", async () => {
  const app = createApp({
    modelManagement: {
      getModelStatus: () => ({
        activeProfile: "default",
        remoteAiEnabled: false,
        remoteAiWarning: null,
        profiles: {
          default: { key: "default", label: "Default chat", candidates: [] },
          fast: { key: "fast", label: "Fast fallback", candidates: [] },
        },
      }),
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/models/status`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.activeProfile, "default");
    assert.equal(payload.profiles.fast.label, "Fast fallback");
  });
});

test("active profile route switches profile and rejects invalid profiles", async () => {
  let activeProfile = "default";
  const app = createApp({
    modelManagement: {
      getModelStatus: () => ({ activeProfile, profiles: {} }),
      setActiveProfile: (profile) => {
        if (profile !== "coding") {
          throw new Error("profile must be one of: default, fast, quality, coding");
        }
        activeProfile = profile;
        return { activeProfile, profiles: {} };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const accepted = await postJson(`${baseUrl}/models/active-profile`, {
      profile: "coding",
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.payload.activeProfile, "coding");

    const rejected = await postJson(`${baseUrl}/models/active-profile`, {
      profile: "unknown",
    });
    assert.equal(rejected.response.status, 400);
    assert.deepEqual(rejected.payload, {
      error: "profile must be one of: default, fast, quality, coding",
    });
    assert.equal(activeProfile, "coding");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management\node-bot
node --test test\server-routes.test.js
```

Expected: FAIL because `/models/status` and `/models/active-profile` are not registered.

- [ ] **Step 3: Register model management routes**

In `node-bot/server.js`, add the import:

```js
const { createModelManagement } = require("./model-management");
```

Inside `registerRoutes`, after `getEditorIntegrations`, add:

```js
const modelManagement =
  deps.modelManagement ||
  createModelManagement({
    env: deps.env || process.env,
  });
```

Before `/health`, add:

```js
app.get("/models/status", (req, res) => {
  return res.json(modelManagement.getModelStatus());
});

app.post("/models/active-profile", (req, res) => {
  try {
    return res.json(modelManagement.setActiveProfile(req.body?.profile));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});
```

- [ ] **Step 4: Run route tests to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management\node-bot
node --test test\server-routes.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management
git add node-bot\server.js node-bot\test\server-routes.test.js
git commit -m "feat: expose local model management routes"
```

## Task 4: Use Active Profile For Default Replies

**Files:**
- Modify: `node-bot/server-routes.js`
- Modify: `node-bot/server.js`
- Modify: `node-bot/test/server-routes.test.js`

- [ ] **Step 1: Write failing tests for `/reply` active-profile fallback**

In `node-bot/test/server-routes.test.js`, add:

```js
test("reply uses active model profile when request omits modelProfile", async () => {
  let receivedProfile = null;
  const app = createApp({
    modelManagement: {
      getActiveProfile: () => "fast",
      getModelStatus: () => ({ activeProfile: "fast", profiles: {} }),
      setActiveProfile: () => ({ activeProfile: "fast", profiles: {} }),
    },
    buildCraftProfitContextForPrompt: async () => "",
    buildUniversalisContextForPrompt: async () => "",
    buildMarketContextForPrompt: async () => "",
    buildAssistantReply: async (transcript, screenText, marketText, modelProfile) => {
      receivedProfile = modelProfile;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "hello",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "ok");
    assert.equal(receivedProfile, "fast");
  });
});

test("reply keeps explicit modelProfile above active profile", async () => {
  let receivedProfile = null;
  const app = createApp({
    modelManagement: {
      getActiveProfile: () => "fast",
      getModelStatus: () => ({ activeProfile: "fast", profiles: {} }),
      setActiveProfile: () => ({ activeProfile: "fast", profiles: {} }),
    },
    buildCraftProfitContextForPrompt: async () => "",
    buildUniversalisContextForPrompt: async () => "",
    buildMarketContextForPrompt: async () => "",
    buildAssistantReply: async (transcript, screenText, marketText, modelProfile) => {
      receivedProfile = modelProfile;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response } = await postJson(`${baseUrl}/reply`, {
      text: "hello",
      modelProfile: "coding",
    });

    assert.equal(response.status, 200);
    assert.equal(receivedProfile, "coding");
  });
});
```

- [ ] **Step 2: Run route tests to verify failure**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management\node-bot
node --test test\server-routes.test.js
```

Expected: FAIL because omitted `modelProfile` still normalizes to `default`.

- [ ] **Step 3: Inject active-profile fallback into core routes**

In `node-bot/server-routes.js`, destructure `getActiveModelProfile` from `deps`:

```js
    getActiveModelProfile,
```

In `/reply`, replace:

```js
const modelProfile = normalizeLlamaModelProfile(req.body?.modelProfile);
```

with:

```js
const hasModelProfile = Object.prototype.hasOwnProperty.call(
  req.body || {},
  "modelProfile",
);
const modelProfile = hasModelProfile
  ? normalizeLlamaModelProfile(req.body?.modelProfile)
  : normalizeLlamaModelProfile(
      typeof getActiveModelProfile === "function"
        ? getActiveModelProfile()
        : "default",
    );
```

In `node-bot/server.js`, when calling `registerCoreRoutes`, add:

```js
  getActiveModelProfile: () => modelManagement.getActiveProfile(),
```

- [ ] **Step 4: Run route tests to verify green**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management\node-bot
node --test test\server-routes.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management
git add node-bot\server.js node-bot\server-routes.js node-bot\test\server-routes.test.js
git commit -m "feat: use active local model profile for replies"
```

## Task 5: Update Docs And Roadmap

**Files:**
- Modify: `node-bot/README.md`
- Modify: `docs/roadmap/issue-12-local-model-management.md`

- [ ] **Step 1: Update backend README model API docs**

In `node-bot/README.md`, update the existing `/reply` model-profile note to include `fast`, then add:

```md
### Local model management

- `GET /models/status`: lists local model profiles, candidate GGUF files, selected models, missing files, active profile, and remote-AI warning state.
- `POST /models/active-profile`: accepts `{ "profile": "default" | "fast" | "quality" | "coding" }` and switches the runtime active local profile.

The active profile is runtime-only and resets when the backend restarts. Mana remains local-first by default; these endpoints do not enable remote AI.
```

- [ ] **Step 2: Update roadmap issue progress**

Append to `docs/roadmap/issue-12-local-model-management.md`:

```md
## Implementation Notes

- Added explicit `default`, `fast`, `quality`, and `coding` local profiles.
- Added runtime local model status and active-profile switching APIs.
- Reported missing configured GGUF files without failing the backend.
- Kept local-only behavior as the default and only reported remote-AI warning state.

## Verification

- `node --test test\local-ai.test.js test\llama-model-selection.test.js test\model-management.test.js test\server-routes.test.js`
- `node --check ai\local-ai.js`
- `node --check model-management.js`
- `node --check server-routes.js`
- `node --check server.js`
- `npm test`
- Forbidden external-project reference scan with the pattern assembled at runtime.
```

- [ ] **Step 3: Run docs/reference scan**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management
$pattern = ('Open' + 'Cl' + 'aw') + '|' + ('open' + 'cl' + 'aw') + '|' + ('cl' + 'aw')
rg -n $pattern README.md node-bot docs
```

Expected: no matches.

- [ ] **Step 4: Commit**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management
git add node-bot\README.md docs\roadmap\issue-12-local-model-management.md
git commit -m "docs: document local model management"
```

## Task 6: Final Verification And PR

**Files:**
- No source edits unless verification exposes a defect.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management\node-bot
node --test test\local-ai.test.js test\llama-model-selection.test.js test\model-management.test.js test\server-routes.test.js test\local-llama-runtime.test.js test\health-components.test.js
```

Expected: PASS.

- [ ] **Step 2: Run syntax checks**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management\node-bot
node --check ai\local-ai.js
node --check model-management.js
node --check server-routes.js
node --check server.js
```

Expected: no output and exit code 0 for each command.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management\node-bot
npm test
```

Expected: PASS for the full `node --test` suite.

- [ ] **Step 4: Run forbidden-reference scan**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management
$pattern = ('Open' + 'Cl' + 'aw') + '|' + ('open' + 'cl' + 'aw') + '|' + ('cl' + 'aw')
rg -n $pattern README.md node-bot docs
```

Expected: no matches.

- [ ] **Step 5: Check git status**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management
git status --short --branch
```

Expected: branch is clean and ahead of origin branch.

- [ ] **Step 6: Push, update PR #19, and mark ready**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\issue-12-local-model-management
git push origin chore/issue-12-local-model-management
gh pr edit 19 --body-file docs\roadmap\issue-12-local-model-management.md
gh pr ready 19
```

Expected: PR #19 is open and ready for review.

- [ ] **Step 7: Merge if checks are clean**

Run:

```powershell
gh pr merge 19 --squash --delete-branch
```

Expected: PR #19 is merged into `main`.

- [ ] **Step 8: Clean up worktree after merge**

Run:

```powershell
cd C:\ManaAI\Mana
git fetch origin
git worktree remove C:\ManaAI\Mana\.worktrees\issue-12-local-model-management
git checkout main
git pull --ff-only origin main
```

Expected: the issue #12 worktree is removed and local `main` is updated.
