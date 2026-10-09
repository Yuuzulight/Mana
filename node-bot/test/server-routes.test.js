const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp, formatMemoryMarkdown, buildMemoryNotes, buildVaultViews, buildSkillsIndexBlock } = require("../server");
const { withServer, useTempDir } = require("./helpers");
useTempDir("MANA_UPLOAD_TMP_DIR");

test("buildSkillsIndexBlock returns nothing when there are no skills", () => {
  assert.equal(buildSkillsIndexBlock([]), "");
  assert.equal(buildSkillsIndexBlock(null), "");
});

test("buildSkillsIndexBlock lists every skill's name and description, wrapped in delimiters", () => {
  const block = buildSkillsIndexBlock([
    { name: "Restart SearXNG", description: "web search is down" },
    { name: "Deploy notes", description: "when asked to draft release notes" },
  ]);
  assert.match(block, /^\[AVAILABLE SKILLS\]/);
  assert.match(block, /\[END AVAILABLE SKILLS\]$/);
  assert.match(block, /- Restart SearXNG: web search is down/);
  assert.match(block, /- Deploy notes: when asked to draft release notes/);
  assert.match(block, /skill__view/);
});

test("buildSkillsIndexBlock truncates at a whole-line boundary, never mid-line", () => {
  // Each description is long enough that a handful of skills exceeds the
  // 2000-char budget -- a flat slice() would cut the last kept line
  // mid-sentence with no indication anything was omitted.
  const longDescription = "x".repeat(300);
  const skills = Array.from({ length: 10 }, (_, i) => ({
    name: `Skill ${i}`,
    description: longDescription,
  }));
  const block = buildSkillsIndexBlock(skills);

  const lines = block.split("\n").filter((l) => l.startsWith("- "));
  for (const line of lines) {
    // Every kept entry is either a full "- Skill N: xxx...x" line or the
    // omission marker -- never a description chopped mid-word.
    assert.ok(
      /^- Skill \d+: x+$/.test(line) || /^- \(\d+ more skill\(s\) omitted for length\)$/.test(line),
      `unexpectedly truncated line: ${line.slice(0, 60)}...`,
    );
  }
  assert.match(block, /more skill\(s\) omitted for length/);
});

// Stands in for a real plugin/capability's contributePromptContext (issue
// #108) so /reply's context chain can be tested deterministically -- the
// real ffxivMarket/stockMarket/webAccess capabilities self-guard on text
// detection internally and webAccess can reach real network calls, neither
// of which belongs in a unit test.
function fakeContextCapability(key, contributePromptContext) {
  return { key, contributePromptContext };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, payload };
}

// #670: local admin routes also need an admin key (admin-key.js).
process.env.ADMIN_TOKEN = "routes-test-admin-token";
const ADMIN = { "x-admin-token": "routes-test-admin-token" };
// Every route but a few public ones needs the key, so every request here
// sends it; NO_KEY overrides it for the keyless cases.
const NO_KEY = { "x-admin-token": "" };
const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...ADMIN, ...init.headers } });

test("admin restart accepts loopback requests and schedules restart once", async () => {
  let buildPayloadCalls = 0;
  let scheduleCalls = 0;
  const acceptedPayload = {
    ok: true,
    action: "restart",
    scope: "backend",
    exitCode: 77,
    message: "restart accepted",
  };
  const app = createApp({
    restartController: {
      buildAcceptedPayload: () => {
        buildPayloadCalls += 1;
        return acceptedPayload;
      },
      scheduleRestart: () => {
        scheduleCalls += 1;
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/admin/restart`, {}, ADMIN);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.status, 200);
    assert.deepEqual(payload, acceptedPayload);
    assert.equal(buildPayloadCalls, 1);
    assert.equal(scheduleCalls, 1);
  });
});

test("admin restart refuses a loopback request with no admin key (#670)", async () => {
  let scheduleCalls = 0;
  const app = createApp({
    restartController: { buildAcceptedPayload: () => ({ ok: true }), scheduleRestart: () => { scheduleCalls += 1; } },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/admin/restart`, {}, NO_KEY);
    const wrong = await postJson(`${baseUrl}/admin/restart`, {}, { "x-admin-token": "wrong" });
    await new Promise((resolve) => setImmediate(resolve));

    // The default-deny gate (admin-key.js) answers before the route.
    assert.equal(response.status, 401);
    assert.match(payload.error, /ADMIN_TOKEN/);
    assert.equal(wrong.response.status, 401);
    assert.equal(scheduleCalls, 0);
  });
});

test("skill settings are wired to the admin-key check (#670)", async () => {
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const put = (headers) =>
      fetch(`${baseUrl}/skill-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ importedSkillUse: "not-a-mode" }),
      });
    assert.equal((await put(NO_KEY)).status, 401);
    // Past the gate; the invalid value is refused before anything is saved.
    assert.equal((await put(ADMIN)).status, 400);
  });
});

test("admin restart rejects non-loopback forwarded clients without scheduling restart", async () => {
  let buildPayloadCalls = 0;
  let scheduleCalls = 0;
  const app = createApp({
    restartController: {
      buildAcceptedPayload: () => {
        buildPayloadCalls += 1;
        return { ok: true };
      },
      scheduleRestart: () => {
        scheduleCalls += 1;
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(
      `${baseUrl}/admin/restart`,
      {},
      { "X-Forwarded-For": "192.168.1.50" },
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.status, 403);
    assert.deepEqual(payload, { error: "restart is only available from this PC" });
    assert.equal(buildPayloadCalls, 0);
    assert.equal(scheduleCalls, 0);
  });
});

test("reply restart command acknowledges restart without model inference", async () => {
  let buildAssistantReplyCalls = 0;
  let scheduleCalls = 0;
  const acceptedPayload = {
    ok: true,
    action: "restart",
    scope: "backend",
    exitCode: 77,
    message: "restart accepted",
  };
  const app = createApp({
    buildAssistantReply: async () => {
      buildAssistantReplyCalls += 1;
      return "should not run";
    },
    restartController: {
      buildAcceptedPayload: () => acceptedPayload,
      scheduleRestart: () => {
        scheduleCalls += 1;
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "/restart",
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      reply: acceptedPayload.message,
      restart: acceptedPayload,
      ttsConfigured: false,
    });
    assert.equal(scheduleCalls, 1);
    assert.equal(buildAssistantReplyCalls, 0);
  });
});

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

test("cloud fallback route persists fallback settings through model management", async () => {
  const calls = [];
  const app = createApp({
    modelManagement: {
      getModelStatus: () => ({ ok: true }),
      setFallbackSettings: (settings) => {
        calls.push(settings);
        return { fallback: { ...settings, hasApiKey: Boolean(settings.apiKey), apiKey: undefined } };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/models/cloud-fallback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "gpt-test",
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], {
      enabled: true,
      timeoutSeconds: undefined,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-test",
      providerId: undefined,
    });
    assert.equal(payload.fallback.hasApiKey, true);
    assert.equal(payload.fallback.apiKey, undefined);
  });
});
test("project routes list, upsert, assign, and clear session projects", async () => {
  const projects = new Map();
  const sessions = new Map();
  const projectStore = {
    listProjects: () => [...projects.values()],
    upsertProject: (input) => {
      const project = { id: input.id || "mana-core", name: input.name, instructions: input.instructions || "", references: input.references || [] };
      projects.set(project.id, project);
      return project;
    },
    deleteProject: (id) => projects.delete(id),
    assignSession: (sessionId, projectId) => {
      if (!projectId) {
        sessions.delete(sessionId);
        return null;
      }
      const project = projects.get(projectId);
      if (!project) throw new Error("project not found");
      sessions.set(sessionId, projectId);
      return project;
    },
    projectForSession: (sessionId) => projects.get(sessions.get(sessionId)) || null,
    promptBlockForSession: () => "",
  };
  const app = createApp({ projectsStore: projectStore });

  await withServer(app, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "mana-core", name: "Mana Core", instructions: "Use repo rules." }),
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).id, "mana-core");

    const listed = await (await fetch(`${baseUrl}/projects`)).json();
    assert.equal(listed.projects.length, 1);

    const assigned = await fetch(`${baseUrl}/sessions/chat-1/project`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "mana-core" }),
    });
    assert.equal(assigned.status, 200);
    assert.equal((await assigned.json()).project.name, "Mana Core");

    const readBack = await (await fetch(`${baseUrl}/sessions/chat-1/project`)).json();
    assert.equal(readBack.project.id, "mana-core");

    const cleared = await fetch(`${baseUrl}/sessions/chat-1/project`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: null }),
    });
    assert.equal((await cleared.json()).project, null);
  });
});

test("gguf-metadata route rejects a missing or invalid path before ever parsing", async () => {
  const app = createApp({
    modelManagement: { isValidGgufFile: () => false },
  });

  await withServer(app, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/models/gguf-metadata`);
    assert.equal(missing.status, 400);

    const invalid = await fetch(
      `${baseUrl}/models/gguf-metadata?path=${encodeURIComponent("C:\\fake\\not-real.gguf")}`,
    );
    assert.equal(invalid.status, 400);
  });
});

test("gguf-metadata route returns parsed metadata for a valid GGUF path", async () => {
  const app = createApp({
    modelManagement: { isValidGgufFile: () => true },
    readGgufMetadata: async (filePath) => ({
      architecture: "llama",
      name: "Test Model",
      quantization: "MOSTLY_Q4_K_M",
      contextLength: 4096,
      parameterCount: "7000000000",
      tensorCount: 291,
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/models/gguf-metadata?path=${encodeURIComponent("C:\\models\\test.gguf")}`,
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.architecture, "llama");
    assert.equal(payload.quantization, "MOSTLY_Q4_K_M");
    assert.equal(payload.contextLength, 4096);
  });
});

test("gguf-metadata route returns 422 when parsing fails for an otherwise-valid-looking file", async () => {
  const app = createApp({
    modelManagement: { isValidGgufFile: () => true },
    readGgufMetadata: async () => null,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/models/gguf-metadata?path=${encodeURIComponent("C:\\models\\corrupt.gguf")}`,
    );
    assert.equal(response.status, 422);
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

test("models scan route returns the scanner's result and validation errors", async () => {
  let receivedRoots = "not-called";
  const app = createApp({
    modelManagement: {
      scanForModels: (roots) => {
        receivedRoots = roots;
        if (roots) throw new Error("boom");
        return { found: [{ path: "C:\\models\\a.gguf", name: "a.gguf", sizeBytes: 10 }], truncated: false, dirsVisited: 3 };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const ok = await postJson(`${baseUrl}/models/scan`, {});
    assert.equal(ok.response.status, 200);
    assert.equal(ok.payload.found.length, 1);
    assert.equal(receivedRoots, undefined);

    const failed = await postJson(`${baseUrl}/models/scan`, { roots: ["D:\\"] });
    assert.equal(failed.response.status, 400);
    assert.deepEqual(failed.payload, { error: "boom" });
  });
});

test("models path route sets the explicit model path and surfaces validation errors", async () => {
  let storedPath = null;
  const app = createApp({
    modelManagement: {
      setModelPath: (modelPath) => {
        if (modelPath && !String(modelPath).endsWith(".gguf")) {
          throw new Error("Model path must point to a .gguf file");
        }
        storedPath = modelPath || null;
        return { activeProfile: "default", profiles: {}, selectedModelPath: storedPath };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const ok = await postJson(`${baseUrl}/models/path`, { modelPath: "C:\\models\\a.gguf" });
    assert.equal(ok.response.status, 200);
    assert.equal(ok.payload.selectedModelPath, "C:\\models\\a.gguf");
    assert.equal(storedPath, "C:\\models\\a.gguf");

    const rejected = await postJson(`${baseUrl}/models/path`, { modelPath: "C:\\models\\a.txt" });
    assert.equal(rejected.response.status, 400);
    assert.deepEqual(rejected.payload, { error: "Model path must point to a .gguf file" });
  });
});

test("brain provider route persists the openai_compatible switch and surfaces validation errors", async () => {
  let received = null;
  const app = createApp({
    modelManagement: {
      setBrainSettings: (partial) => {
        if (partial.type && !["local", "openai_compatible"].includes(partial.type)) {
          throw new Error('type must be "local" or "openai_compatible"');
        }
        received = partial;
        return {
          activeProfile: "default",
          profiles: {},
          brain: { type: partial.type || "local", baseUrl: partial.baseUrl || "", model: partial.model || "", hasApiKey: Boolean(partial.apiKey) },
        };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const ok = await postJson(`${baseUrl}/models/brain-provider`, {
      type: "openai_compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-local",
      model: "llama3",
    });
    assert.equal(ok.response.status, 200);
    assert.equal(ok.payload.brain.type, "openai_compatible");
    assert.equal(ok.payload.brain.hasApiKey, true);
    // apiKey must never round-trip in the response.
    assert.equal(ok.payload.brain.apiKey, undefined);
    assert.equal(received.apiKey, "sk-local");

    const rejected = await postJson(`${baseUrl}/models/brain-provider`, {
      type: "not-a-real-type",
    });
    assert.equal(rejected.response.status, 400);
    assert.deepEqual(rejected.payload, {
      error: 'type must be "local" or "openai_compatible"',
    });
  });
});

test("vision path route persists the model/mmproj override and surfaces validation errors", async () => {
  const app = createApp({
    modelManagement: {
      setVisionSettings: (partial) => {
        if (partial.modelPath && !String(partial.modelPath).endsWith(".gguf")) {
          throw new Error("modelPath must point to a .gguf file");
        }
        return {
          activeProfile: "default",
          profiles: {},
          vision: { modelPath: partial.modelPath || "", mmprojPath: partial.mmprojPath || "" },
        };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const ok = await postJson(`${baseUrl}/models/vision-path`, {
      modelPath: "C:\\models\\vision.gguf",
      mmprojPath: "C:\\models\\vision-mmproj.gguf",
    });
    assert.equal(ok.response.status, 200);
    assert.equal(ok.payload.vision.modelPath, "C:\\models\\vision.gguf");

    const rejected = await postJson(`${baseUrl}/models/vision-path`, {
      modelPath: "C:\\models\\vision.txt",
    });
    assert.equal(rejected.response.status, 400);
    assert.deepEqual(rejected.payload, {
      error: "modelPath must point to a .gguf file",
    });
  });
});

test("load-into-vram route is admin-gated and passes the boolean through", async () => {
  const calls = [];
  const app = createApp({
    env: { MANA_ADMIN_SECRET: "topsecret" },
    modelManagement: {
      setLoadIntoVram: (value) => {
        calls.push(value);
        if (typeof value !== "boolean") throw new Error("loadIntoVram must be true or false");
        return { loadIntoVram: value };
      },
    },
  });
  const auth = { Authorization: "Bearer topsecret" };

  await withServer(app, async (baseUrl) => {
    const unauthorized = await postJson(`${baseUrl}/models/load-into-vram`, { loadIntoVram: false });
    assert.equal(unauthorized.response.status, 401);
    assert.equal(calls.length, 0);

    const ok = await postJson(`${baseUrl}/models/load-into-vram`, { loadIntoVram: false }, auth);
    assert.equal(ok.response.status, 200);
    assert.equal(ok.payload.loadIntoVram, false);

    const rejected = await postJson(`${baseUrl}/models/load-into-vram`, { loadIntoVram: "no" }, auth);
    assert.equal(rejected.response.status, 400);
    assert.deepEqual(calls, [false, "no"]);
  });
});

test("brain-providers route lists presets from model-management", async () => {
  const app = createApp({
    modelManagement: {
      getKnownBrainProviders: () => [
        { id: "ollama", label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false },
        { id: "custom", label: "Custom", baseUrl: "", needsKey: false },
      ],
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/models/brain-providers`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.length, 2);
    assert.equal(payload[0].id, "ollama");
  });
});

test("brain-provider test route surfaces the connection result", async () => {
  let received = null;
  const app = createApp({
    modelManagement: {
      testBrainConnection: async (args) => {
        received = args;
        return { ok: true, status: 200, modelCount: 3 };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const noKey = await postJson(`${baseUrl}/models/brain-provider/test`, { baseUrl: "http://127.0.0.1:11434/v1" }, NO_KEY);
    assert.equal(noKey.response.status, 401);
    assert.equal(received, null);

    const result = await postJson(`${baseUrl}/models/brain-provider/test`, {
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "sk-local",
    }, ADMIN);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload, { ok: true, status: 200, modelCount: 3 });
    assert.deepEqual(received, { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "sk-local" });
  });
});

test("brain-provider test route rejects non-loopback forwarded clients without calling testBrainConnection", async () => {
  // node-bot listens on all interfaces with CORS wide open, and this is the
  // one /models/* route that makes it issue an outbound request to a
  // user-supplied URL -- local-only (same isLocalRestartRequest check as
  // /admin/restart) so a remote visitor can't use it as an SSRF probe
  // against arbitrary hosts.
  let testCalls = 0;
  const app = createApp({
    modelManagement: {
      testBrainConnection: async () => {
        testCalls += 1;
        return { ok: true };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(
      `${baseUrl}/models/brain-provider/test`,
      { baseUrl: "http://127.0.0.1:11434/v1" },
      { "X-Forwarded-For": "192.168.1.50" },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(payload, { error: "this endpoint is only available from this PC" });
    assert.equal(testCalls, 0);
  });
});

test("llama-build routes are admin-gated and local-only, and map a missing digest to 409", async () => {
  // #693: check/update make outbound requests and update runs what it
  // downloaded, so these get both checkAdminAuth and the this-PC check.
  const updateCalls = [];
  const llamaBuilds = {
    getStatus: () => ({ current: { build: 100 } }),
    startUpdate: async (options) => {
      updateCalls.push(options);
      if (!options.allowMissingDigest) {
        throw Object.assign(new Error("no digest"), { code: "digest_missing" });
      }
      return { started: true, tag: "b200" };
    },
  };
  const app = createApp({ llamaBuilds, env: { MANA_ADMIN_SECRET: "topsecret" } });
  const auth = { Authorization: "Bearer topsecret", ...ADMIN };

  await withServer(app, async (baseUrl) => {
    const unauthorized = await postJson(`${baseUrl}/models/llama-build/update`, {}, NO_KEY);
    assert.equal(unauthorized.response.status, 401);

    const noAdminKey = await postJson(`${baseUrl}/models/llama-build/update`, {}, { ...NO_KEY, Authorization: "Bearer topsecret" });
    assert.equal(noAdminKey.response.status, 403);

    const remote = await postJson(`${baseUrl}/models/llama-build/update`, {}, { ...auth, "X-Forwarded-For": "192.168.1.50" });
    assert.equal(remote.response.status, 403);
    assert.equal(updateCalls.length, 0);

    const refused = await postJson(`${baseUrl}/models/llama-build/update`, {}, auth);
    assert.equal(refused.response.status, 409);
    assert.deepEqual(refused.payload, { error: "no digest", code: "digest_missing" });

    const confirmed = await postJson(`${baseUrl}/models/llama-build/update`, { allowMissingDigest: true }, auth);
    assert.equal(confirmed.response.status, 202);
    assert.deepEqual(updateCalls, [{ allowMissingDigest: false }, { allowMissingDigest: true }]);

    const status = await fetch(`${baseUrl}/models/llama-build`, { headers: auth });
    assert.deepEqual(await status.json(), { current: { build: 100 } });
  });
});

test("reply uses active model profile when request omits modelProfile", async () => {
  let receivedProfile = null;
  const app = createApp({
    modelManagement: {
      getActiveProfile: () => "fast",
      getModelStatus: () => ({ activeProfile: "fast", profiles: {} }),
      setActiveProfile: () => ({ activeProfile: "fast", profiles: {} }),
    },
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

test("reply passes presetId through to buildAssistantReply", async () => {
  let receivedPresetId = "not-set";
  const app = createApp({
    buildAssistantReply: async (
      transcript,
      screenText,
      marketText,
      modelProfile,
      sessionId,
      assistantMode,
      presetId,
    ) => {
      receivedPresetId = presetId;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response } = await postJson(`${baseUrl}/reply`, {
      text: "hello",
      presetId: "preset-123",
    });

    assert.equal(response.status, 200);
    assert.equal(receivedPresetId, "preset-123");
  });
});

test("reply omits presetId as null when the request doesn't select one", async () => {
  let receivedPresetId = "not-set";
  const app = createApp({
    buildAssistantReply: async (
      transcript,
      screenText,
      marketText,
      modelProfile,
      sessionId,
      assistantMode,
      presetId,
    ) => {
      receivedPresetId = presetId;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    await postJson(`${baseUrl}/reply`, { text: "hello" });
    assert.equal(receivedPresetId, null);
  });
});

test("a turn without a sessionId warns once that it isn't saved to memory", async () => {
  const app = createApp({ buildAssistantReply: async () => "ok" });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await withServer(app, async (baseUrl) => {
      await postJson(`${baseUrl}/reply`, { text: "hello", sessionId: "s1" });
      await postJson(`${baseUrl}/reply`, { text: "hello" });
      await postJson(`${baseUrl}/reply`, { text: "hello again" });
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.filter((w) => w.includes("without a sessionId")).length, 1);
});

test("transcribe passes presetId through to buildAssistantReply", async () => {
  let receivedPresetId = "not-set";
  const app = createApp({
    normalizeUploadedAudio: (file) => ({ tmpPath: file.path, audioPath: file.path }),
    runWhisper: () => "hello",
    cleanupUploadedAudio: () => {},
    buildAssistantReply: async (
      transcript,
      screenText,
      marketText,
      modelProfile,
      sessionId,
      assistantMode,
      presetId,
    ) => {
      receivedPresetId = presetId;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const form = new FormData();
    form.append("file", new Blob(["fake audio"], { type: "audio/wav" }), "voice.wav");
    form.append("presetId", "preset-123");
    const response = await fetch(`${baseUrl}/transcribe`, { method: "POST", body: form });

    assert.equal(response.status, 200);
    assert.equal(receivedPresetId, "preset-123");
  });
});

test("transcribe omits presetId as null when the request doesn't select one", async () => {
  let receivedPresetId = "not-set";
  const app = createApp({
    normalizeUploadedAudio: (file) => ({ tmpPath: file.path, audioPath: file.path }),
    runWhisper: () => "hello",
    cleanupUploadedAudio: () => {},
    buildAssistantReply: async (
      transcript,
      screenText,
      marketText,
      modelProfile,
      sessionId,
      assistantMode,
      presetId,
    ) => {
      receivedPresetId = presetId;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const form = new FormData();
    form.append("file", new Blob(["fake audio"], { type: "audio/wav" }), "voice.wav");
    const response = await fetch(`${baseUrl}/transcribe`, { method: "POST", body: form });

    assert.equal(response.status, 200);
    assert.equal(receivedPresetId, null);
  });
});

// Regression test for a real bug this feature surfaced: buildAssistantReply
// computes a mode/preset-aware system prompt (selectedSystemPrompt), but the
// local-inference call site never forwarded it, so presets (and the
// pre-existing casual/everyday/coding modes) had zero effect on local
// replies -- only the opt-in remote/OpenAI path ever received it. This
// exercises the REAL buildAssistantReply (not mocked) end to end and checks
// what actually reaches the model call.
test("a selected preset's instructions reach the local model's system prompt", async () => {
  let capturedSystemPrompt = null;
  const presetsStore = {
    getPreset: (id) =>
      id === "preset-1"
        ? { id: "preset-1", name: "Concise", instructions: "Keep every reply under two sentences." }
        : null,
  };
  const app = createApp({
    presetsStore,
    runLocalAssistantReply: async (prompt, maxTokens, profile, overrideSystemPrompt) => {
      capturedSystemPrompt = overrideSystemPrompt;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "hello",
      presetId: "preset-1",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "ok");
    assert.match(capturedSystemPrompt, /Keep every reply under two sentences\./);
  });
});

test("an assigned project's standing instructions reach the local model's system prompt", async () => {
  let capturedSystemPrompt = null;
  const project = {
    id: "mana-core",
    name: "Mana Core",
    instructions: "Use the Mana repo testing notes before changing code.",
    references: [],
  };
  const projectsStore = {
    promptBlockForSession: (sessionId) =>
      sessionId === "chat-project" ? `Project: ${project.name}\n\nStanding instructions:\n${project.instructions}` : "",
    projectForSession: (sessionId) => (sessionId === "chat-project" ? project : null),
    listProjects: () => [project],
    upsertProject: () => project,
    deleteProject: () => true,
    assignSession: () => project,
  };
  const app = createApp({
    projectsStore,
    runLocalAssistantReply: async (prompt, maxTokens, profile, overrideSystemPrompt) => {
      capturedSystemPrompt = overrideSystemPrompt;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "hello",
      sessionId: "chat-project",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "ok");
    assert.match(capturedSystemPrompt, /Project: Mana Core/);
    assert.match(capturedSystemPrompt, /Use the Mana repo testing notes before changing code\./);
  });
});

test("no preset selected leaves the local model's system prompt unchanged", async () => {
  let capturedSystemPrompt = null;
  const app = createApp({
    runLocalAssistantReply: async (prompt, maxTokens, profile, overrideSystemPrompt) => {
      capturedSystemPrompt = overrideSystemPrompt;
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    await postJson(`${baseUrl}/reply`, { text: "hello" });
    assert.doesNotMatch(capturedSystemPrompt || "", /Keep every reply under two sentences\./);
  });
});

// Tool-calling wiring (issue #51): on by default (MANA_TOOL_CALLING_ENABLED=0
// opts out),
// scoped to the "default" profile only (the one profile verified to emit
// reliable tool_calls -- see docs/roadmap/issue-51-tool-calling.md), and
// falls back to the plain reply path on any failure or empty result.
async function withToolCallingEnv(value, fn) {
  const prior = process.env.MANA_TOOL_CALLING_ENABLED;
  if (value === undefined) delete process.env.MANA_TOOL_CALLING_ENABLED;
  else process.env.MANA_TOOL_CALLING_ENABLED = value;
  try {
    await fn();
  } finally {
    if (prior === undefined) delete process.env.MANA_TOOL_CALLING_ENABLED;
    else process.env.MANA_TOOL_CALLING_ENABLED = prior;
  }
}

test("MANA_TOOL_CALLING_ENABLED=0 turns tool-calling off even when a runToolAwareReply is provided", async () => {
  await withToolCallingEnv("0", async () => {
    let toolAwareCalls = 0;
    let plainCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => {
        toolAwareCalls += 1;
        return { content: "tool reply", toolCalls: [] };
      },
      runLocalAssistantReply: async () => {
        plainCalls += 1;
        return "plain reply";
      },
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, { text: "hello" });
      assert.equal(payload.reply, "plain reply");
      assert.equal(toolAwareCalls, 0);
      assert.equal(plainCalls, 1);
    });
  });
});

test("tool-calling activates for the default profile by default when llama-server is available", async () => {
  await withToolCallingEnv(undefined, async () => {
    let capturedPrompt = null;
    let plainCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async (prompt) => {
        capturedPrompt = prompt;
        return {
          content: "The file says hello",
          toolCalls: [{ name: "read_file", args: { path: "notes.txt" }, ok: true }],
        };
      },
      runLocalAssistantReply: async () => {
        plainCalls += 1;
        return "plain reply";
      },
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "what does notes.txt say?",
        modelProfile: "default",
      });
      assert.equal(payload.reply, "The file says hello");
      assert.match(capturedPrompt, /notes\.txt/);
      assert.equal(plainCalls, 0);
    });
  });
});

test("a successful expression__set tool call surfaces as /reply's expression field (issue #253)", async () => {
  await withToolCallingEnv("1", async () => {
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => ({
        content: "Here's a wink for you~",
        toolCalls: [{ name: "expression__set", args: { name: "wink" }, ok: true }],
      }),
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "give me a wink",
        modelProfile: "default",
      });
      assert.equal(payload.reply, "Here's a wink for you~");
      assert.equal(payload.expression, "wink");
    });
  });
});

test("a failed expression__set tool call does NOT surface an expression field", async () => {
  await withToolCallingEnv("1", async () => {
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => ({
        content: "reply text",
        toolCalls: [{ name: "expression__set", args: { name: "wink" }, ok: false, error: "boom" }],
      }),
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "give me a wink",
        modelProfile: "default",
      });
      assert.equal(payload.reply, "reply text");
      assert.equal("expression" in payload, false);
    });
  });
});

test("when expression__set is called twice in one reply, the LAST successful call wins", async () => {
  await withToolCallingEnv("1", async () => {
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => ({
        content: "changed my mind~",
        toolCalls: [
          { name: "expression__set", args: { name: "wink" }, ok: true },
          { name: "expression__set", args: { name: "happy" }, ok: true },
        ],
      }),
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "give me an expression",
        modelProfile: "default",
      });
      assert.equal(payload.expression, "happy");
    });
  });
});

test("no expression field is present in /reply's response when no expression__set call happened", async () => {
  await withToolCallingEnv("1", async () => {
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => ({
        content: "The file says hello",
        toolCalls: [{ name: "read_file", args: { path: "notes.txt" }, ok: true }],
      }),
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "what does notes.txt say?",
        modelProfile: "default",
      });
      assert.equal("expression" in payload, false);
    });
  });
});

test("tool-calling does not activate for a non-default profile even when enabled", async () => {
  await withToolCallingEnv("1", async () => {
    let toolAwareCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => {
        toolAwareCalls += 1;
        return { content: "should not happen", toolCalls: [] };
      },
      runLocalAssistantReply: async () => "plain coding reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "debug this function",
        modelProfile: "coding",
      });
      assert.equal(payload.reply, "plain coding reply");
      assert.equal(toolAwareCalls, 0);
    });
  });
});

test("tool-calling falls back to the plain reply when llama-server isn't available", async () => {
  await withToolCallingEnv("1", async () => {
    let toolAwareCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => false,
      runToolAwareReply: async () => {
        toolAwareCalls += 1;
        return { content: "should not happen", toolCalls: [] };
      },
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, { text: "hello" });
      assert.equal(payload.reply, "plain reply");
      assert.equal(toolAwareCalls, 0);
    });
  });
});

test("tool-calling falls back to the plain reply when runToolAwareReply throws", async () => {
  await withToolCallingEnv("1", async () => {
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => {
        throw new Error("llama-server executable not found");
      },
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { response, payload } = await postJson(`${baseUrl}/reply`, { text: "hello" });
      assert.equal(response.status, 200);
      assert.equal(payload.reply, "plain reply");
    });
  });
});

test("tool-calling falls back to the plain reply when runToolAwareReply returns empty content", async () => {
  await withToolCallingEnv("1", async () => {
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runToolAwareReply: async () => ({ content: "", toolCalls: [] }),
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, { text: "hello" });
      assert.equal(payload.reply, "plain reply");
    });
  });
});

// Best-of-N wiring (issue #70): opt-in via MANA_BEST_OF_N_ENABLED, scoped to
// coding-mode replies only, layered on top of the tool-calling/plain path so
// any failure or empty result falls straight through to it.
async function withBestOfNEnv(value, fn) {
  const prior = process.env.MANA_BEST_OF_N_ENABLED;
  process.env.MANA_BEST_OF_N_ENABLED = value;
  try {
    await fn();
  } finally {
    if (prior === undefined) delete process.env.MANA_BEST_OF_N_ENABLED;
    else process.env.MANA_BEST_OF_N_ENABLED = prior;
  }
}

test("best-of-N stays off by default even when a runBestOfNReply is provided", async () => {
  await withBestOfNEnv(undefined, async () => {
    let bestOfNCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runBestOfNReply: async () => {
        bestOfNCalls += 1;
        return { content: "best-of-n reply", candidates: [], judgeIndex: 0 };
      },
      runLocalAssistantReply: async () => "plain coding reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "debug this function",
        modelProfile: "coding",
      });
      assert.equal(payload.reply, "plain coding reply");
      assert.equal(bestOfNCalls, 0);
    });
  });
});

test("best-of-N activates for coding-mode replies when enabled and llama-server is available", async () => {
  await withBestOfNEnv("1", async () => {
    let capturedOptions = null;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runBestOfNReply: async (prompt, options) => {
        capturedOptions = options;
        return {
          content: "the judged best fix",
          candidates: ["a", "b", "c"],
          judgeIndex: 1,
        };
      },
      runLocalAssistantReply: async () => "plain coding reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "debug this function",
        modelProfile: "coding",
      });
      assert.equal(payload.reply, "the judged best fix");
      assert.equal(capturedOptions.profile, "coding");
    });
  });
});

test("best-of-N does not activate for a non-coding reply even when enabled", async () => {
  await withBestOfNEnv("1", async () => {
    let bestOfNCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runBestOfNReply: async () => {
        bestOfNCalls += 1;
        return { content: "should not happen", candidates: [], judgeIndex: 0 };
      },
      runLocalAssistantReply: async () => "plain reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, { text: "hello there" });
      assert.equal(payload.reply, "plain reply");
      assert.equal(bestOfNCalls, 0);
    });
  });
});

test("best-of-N falls back to the plain reply when llama-server isn't available", async () => {
  await withBestOfNEnv("1", async () => {
    let bestOfNCalls = 0;
    const app = createApp({
      isLlamaServerEnabled: () => false,
      runBestOfNReply: async () => {
        bestOfNCalls += 1;
        return { content: "should not happen", candidates: [], judgeIndex: 0 };
      },
      runLocalAssistantReply: async () => "plain coding reply",
    });

    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/reply`, {
        text: "debug this function",
        modelProfile: "coding",
      });
      assert.equal(payload.reply, "plain coding reply");
      assert.equal(bestOfNCalls, 0);
    });
  });
});

test("best-of-N falls back to the plain reply when runBestOfNReply throws", async () => {
  await withBestOfNEnv("1", async () => {
    const app = createApp({
      isLlamaServerEnabled: () => true,
      runBestOfNReply: async () => {
        throw new Error("llama-server returned no usable candidates");
      },
      runLocalAssistantReply: async () => "plain coding reply",
    });

    await withServer(app, async (baseUrl) => {
      const { response, payload } = await postJson(`${baseUrl}/reply`, {
        text: "debug this function",
        modelProfile: "coding",
      });
      assert.equal(response.status, 200);
      assert.equal(payload.reply, "plain coding reply");
    });
  });
});

test("reply continues when optional market context fails", async () => {
  const app = createApp({
    capabilities: [
      fakeContextCapability("stockMarket", async () => {
        throw new Error("Alpha Vantage API key is not configured");
      }),
    ],
    buildAssistantReply: async (transcript, screenText, marketText) => {
      assert.equal(transcript, "can you read the current repository's readme?");
      assert.equal(marketText, "");
      return "README summary";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "can you read the current repository's readme?",
      modelProfile: "coding",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "README summary");
  });
});

test("reply falls through the whole plugin chain when nothing contributes context", async () => {
  const calls = [];
  const app = createApp({
    capabilities: [
      fakeContextCapability("ffxivMarket", async () => {
        calls.push("ffxivMarket");
        return "";
      }),
      fakeContextCapability("stockMarket", async () => {
        calls.push("stockMarket");
        return "";
      }),
    ],
    buildAssistantReply: async (transcript, screenText, marketText) => {
      assert.equal(marketText, "");
      return "README summary";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "can you read the current repository's readme?",
      modelProfile: "coding",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "README summary");
    assert.deepEqual(calls, ["ffxivMarket", "stockMarket"]);
  });
});

test("reply skips optional context builders when includeContext is false", async () => {
  let contextCalls = 0;
  const app = createApp({
    capabilities: [
      fakeContextCapability("ffxivMarket", async () => {
        contextCalls += 1;
        return "craft or universalis context";
      }),
      fakeContextCapability("stockMarket", async () => {
        contextCalls += 1;
        return "market context";
      }),
    ],
    buildAssistantReply: async (transcript, screenText, marketText) => {
      assert.match(transcript, /Repository README/);
      assert.equal(marketText, "");
      return "README summary";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "Repository README:\nFFXIV and Universalis crafting market data",
      modelProfile: "coding",
      includeContext: false,
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "README summary");
    assert.equal(contextCalls, 0);
  });
});

test("vision describe returns a reply from the vision runtime", async () => {
  const app = createApp({
    getVisionStatus: () => ({ available: true, model: "vl.gguf", mmproj: "mmproj.gguf" }),
    runVisionReply: async (prompt, images) => {
      assert.equal(prompt, "What is this?");
      assert.equal(images.length, 1);
      assert.match(images[0], /^data:image\/png;base64,/);
      return "That looks like a chocobo.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/vision/describe`, {
      image: "data:image/png;base64,iVBORw0KGgo=",
      prompt: "What is this?",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "That looks like a chocobo.");
  });
});

test("vision describe reports 503 when no vision model is available", async () => {
  const app = createApp({
    getVisionStatus: () => ({ available: false, reason: "No local vision model found." }),
    runVisionReply: async () => {
      throw new Error("should not be called");
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/vision/describe`, {
      image: "data:image/png;base64,iVBORw0KGgo=",
    });

    assert.equal(response.status, 503);
    assert.match(payload.error, /no local vision model/i);
    assert.match(payload.detail, /No local vision model found/);
  });
});

test("reply with an attached image: #679 a chat model that can see gets it in the normal chat turn", async () => {
  let chatCall = null;
  const app = createApp({
    getVisionStatus: () => ({ available: true }),
    chatAcceptsImages: () => true,
    runVisionReply: async () => {
      throw new Error("no describe-first call when the chat model can see");
    },
    buildAssistantReply: async (transcript, screenText, marketText, profile, sessionId, mode, preset, replyMeta) => {
      chatCall = { transcript, sessionId, images: replyMeta.images };
      return "A market board, obviously.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "what am I looking at?",
      image: "data:image/png;base64,iVBORw0KGgo=",
      sessionId: "s1",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "A market board, obviously.");
  });
  assert.deepEqual(chatCall, {
    transcript: "what am I looking at?",
    sessionId: "s1",
    images: ["data:image/png;base64,iVBORw0KGgo="],
  });
});

test("#679: the real chat path hands a seeable image to the model call", async () => {
  let extra = null;
  const app = createApp({
    getVisionStatus: () => ({ available: true }),
    chatAcceptsImages: () => true,
    runLocalAssistantReply: async (prompt, maxTokens, profile, systemPrompt, extraMessages) => {
      extra = extraMessages;
      return "A cat on a keyboard.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "what's this?",
      image: "data:image/png;base64,AAAA",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "A cat on a keyboard.");
  });
  assert.deepEqual(extra.images, ["data:image/png;base64,AAAA"]);
});

test("reply with an image allows empty text", async () => {
  let transcriptSeen = null;
  const app = createApp({
    getVisionStatus: () => ({ available: true }),
    chatAcceptsImages: () => false,
    runVisionReply: async (prompt, images) => {
      assert.doesNotMatch(prompt, /Their message/);
      assert.equal(images.length, 1);
      return "A screenshot of a stack trace.";
    },
    buildAssistantReply: async (transcript) => {
      transcriptSeen = transcript;
      return "I see a stack trace.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      image: "data:image/png;base64,iVBORw0KGgo=",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "I see a stack trace.");
  });
  assert.equal(transcriptSeen, "[Image: A screenshot of a stack trace.]");
});

test("#889: an image turn while vision is paused for gaming still gets a reply that says so", async () => {
  let transcriptSeen = null;
  const app = createApp({
    getVisionStatus: () => ({ available: true }),
    chatAcceptsImages: () => false,
    runVisionReply: async () => {
      throw Object.assign(new Error("Vision is paused while gaming"), { code: "VISION_PAUSED_GAMING" });
    },
    buildAssistantReply: async (transcript) => {
      transcriptSeen = transcript;
      return "I can't see images while you're gaming.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response } = await postJson(`${baseUrl}/reply`, {
      text: "what's this?",
      image: "data:image/png;base64,iVBORw0KGgo=",
    });
    assert.equal(response.status, 200);
  });
  assert.match(transcriptSeen, /vision is paused while a game is running[\s\S]*what's this\?$/);
});

test("POST /web/search returns results from the injected searchWeb", async () => {
  const app = createApp({
    searchWeb: async (query, options) => {
      assert.equal(query, "chocobo racing tips");
      assert.equal(options.limit, 3);
      return [{ title: "Tips", url: "https://example.com", snippet: "..." }];
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/web/search`, {
      query: "chocobo racing tips",
      limit: 3,
    });

    assert.equal(response.status, 200);
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].title, "Tips");
  });
});

test("POST /web/search rejects a missing query", async () => {
  const app = createApp({
    searchWeb: async () => {
      throw new Error("should not be called");
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/web/search`, {});
    assert.equal(response.status, 400);
    assert.match(payload.error, /query/i);
  });
});

test("POST /web/read returns the injected fetchPage result", async () => {
  const app = createApp({
    fetchPage: async (url) => {
      assert.equal(url, "https://example.com/page");
      return { url, title: "Example", text: "Hello page", truncated: false };
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/web/read`, {
      url: "https://example.com/page",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.title, "Example");
    assert.equal(payload.text, "Hello page");
  });
});

test("#1140 POST /web/read asks for the reader view only when told to", async () => {
  const seen = [];
  const app = createApp({
    fetchPage: async (url, options) => {
      seen.push(options);
      return { url, title: "Example", text: "Hello page", truncated: false, needsBrowser: null, images: {} };
    },
  });

  await withServer(app, async (baseUrl) => {
    await postJson(`${baseUrl}/web/read`, { url: "https://example.com/page", reader: true });
    await postJson(`${baseUrl}/web/read`, { url: "https://example.com/page", reader: "yes" });
  });
  assert.deepEqual(seen, [{ reader: true }, {}]);
});

test("GET /wiki/:term returns the injected wikiLookup result", async () => {
  const app = createApp({
    wikiLookup: async (term) => {
      assert.equal(term, "chocobo");
      return { title: "Chocobo", extract: "A large bird.", url: "https://en.wikipedia.org/wiki/Chocobo" };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/wiki/chocobo`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.title, "Chocobo");
  });
});

test("GET /wiki/:term returns 404 when nothing matches", async () => {
  const app = createApp({
    wikiLookup: async () => null,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/wiki/asdkjfhaskdjfh`);
    assert.equal(response.status, 404);
  });
});

test("reply falls back to web context when no market question is detected", async () => {
  const app = createApp({
    capabilities: [
      fakeContextCapability("webAccess", async (text) => {
        assert.equal(text, "search for FFXIV patch notes");
        return "Web search results:\n1. Patch Notes\n   https://example.com\n   ...\n\n";
      }),
    ],
    buildAssistantReply: async (transcript, screenText, marketText) => {
      assert.match(marketText, /Web search results/);
      return "Here's what I found.";
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/reply`, {
      text: "search for FFXIV patch notes",
    });

    assert.equal(response.status, 200);
    assert.equal(payload.reply, "Here's what I found.");
  });
});

test("reply skips web context when includeContext is false", async () => {
  let webContextCalls = 0;
  const app = createApp({
    capabilities: [
      fakeContextCapability("webAccess", async () => {
        webContextCalls += 1;
        return "Web search results:\n...";
      }),
    ],
    buildAssistantReply: async (transcript, screenText, marketText) => {
      assert.equal(marketText, "");
      return "ok";
    },
  });

  await withServer(app, async (baseUrl) => {
    await postJson(`${baseUrl}/reply`, {
      text: "search for FFXIV patch notes",
      includeContext: false,
    });
  });

  assert.equal(webContextCalls, 0);
});

async function withIdleThresholdMs(value, fn) {
  const original = process.env.MANA_IDLE_THRESHOLD_MS;
  process.env.MANA_IDLE_THRESHOLD_MS = String(value);
  try {
    await fn();
  } finally {
    if (original === undefined) delete process.env.MANA_IDLE_THRESHOLD_MS;
    else process.env.MANA_IDLE_THRESHOLD_MS = original;
  }
}

test("idle-report does not trigger consolidation below the idle threshold", async () => {
  let triggerCalls = 0;
  const app = createApp({
    triggerIdleConsolidation: async () => {
      triggerCalls += 1;
    },
    getGamingStatus: () => ({ gamingAppRunning: false }),
  });

  await withIdleThresholdMs(60000, async () => {
    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/internal/idle-report`, {
        idleSeconds: 5,
      });
      assert.equal(payload.idleTriggered, false);
    });
  });

  assert.equal(triggerCalls, 0);
});

test("idle-report triggers consolidation once idle time crosses the threshold", async () => {
  let triggerCalls = 0;
  const app = createApp({
    triggerIdleConsolidation: async () => {
      triggerCalls += 1;
    },
    getGamingStatus: () => ({ gamingAppRunning: false }),
  });

  await withIdleThresholdMs(1000, async () => {
    await withServer(app, async (baseUrl) => {
      const { payload } = await postJson(`${baseUrl}/internal/idle-report`, {
        idleSeconds: 5,
      });
      assert.equal(payload.idleTriggered, true);
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  assert.equal(triggerCalls, 1);
});

test("idle-report does not re-trigger on repeated reports during the same idle period", async () => {
  let triggerCalls = 0;
  const app = createApp({
    triggerIdleConsolidation: async () => {
      triggerCalls += 1;
    },
    getGamingStatus: () => ({ gamingAppRunning: false }),
  });

  await withIdleThresholdMs(1000, async () => {
    await withServer(app, async (baseUrl) => {
      await postJson(`${baseUrl}/internal/idle-report`, { idleSeconds: 5 });
      const { payload } = await postJson(`${baseUrl}/internal/idle-report`, {
        idleSeconds: 10,
      });
      assert.equal(payload.idleTriggered, false);
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  assert.equal(triggerCalls, 1);
});

test("idle-report fires again after the user goes active and idles out a second time", async () => {
  let triggerCalls = 0;
  const app = createApp({
    triggerIdleConsolidation: async () => {
      triggerCalls += 1;
    },
    getGamingStatus: () => ({ gamingAppRunning: false }),
  });

  await withIdleThresholdMs(1000, async () => {
    await withServer(app, async (baseUrl) => {
      await postJson(`${baseUrl}/internal/idle-report`, { idleSeconds: 5 });
      await postJson(`${baseUrl}/internal/idle-report`, { idleSeconds: 0 });
      const { payload } = await postJson(`${baseUrl}/internal/idle-report`, {
        idleSeconds: 5,
      });
      assert.equal(payload.idleTriggered, true);
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  assert.equal(triggerCalls, 2);
});

test("formatMemoryMarkdown renders a placeholder with no summary or facts", () => {
  const md = formatMemoryMarkdown("", []);
  assert.match(md, /_\(no summary yet\)_/);
  assert.doesNotMatch(md, /## Key Facts/);
});

test("formatMemoryMarkdown renders the compacted summary and key facts", () => {
  const md = formatMemoryMarkdown("User prefers concise replies.", [
    "Likes FFXIV crafting",
    "Uses windows-launcher",
  ]);
  assert.match(md, /## Summary\n\nUser prefers concise replies\./);
  assert.match(md, /## Key Facts\n\n- Likes FFXIV crafting\n- Uses windows-launcher/);
});

test("buildVaultViews gives the summary, a mood view in level words and the entity notes (#935)", () => {
  const views = buildVaultViews({ summary: "tired, chatty", energy: 0.2, sociability: 0.8, stress: 0.5 });
  const byRel = Object.fromEntries(views.map((v) => [v.rel, v.body]));
  assert.ok("Views/Summary.md" in byRel);
  assert.match(byRel["Views/Mood.md"], /Right now: tired, chatty\.\n\n- Energy: low\n- Sociability: high\n- Stress: moderate/);
  assert.ok(views.every((v) => /^Views\/(Summary|Mood|Facts Index|Pending Review|Entities Index|Entities\/[a-z0-9-]+)\.md$/.test(v.rel)));
});

test("formatMemoryMarkdown omits the Connections section when there are none (issue #75)", () => {
  const md = formatMemoryMarkdown("Summary text.", ["a fact"]);
  assert.doesNotMatch(md, /## Connections/);
});

test("formatMemoryMarkdown renders connections in their own section, separate from facts (issue #75)", () => {
  const md = formatMemoryMarkdown(
    "Summary text.",
    ["a fact"],
    ["Summary #1 <-> Summary #3: both discuss the FFXIV Weaver crafting rotation."],
  );
  assert.match(
    md,
    /## Connections\n\n- Summary #1 <-> Summary #3: both discuss the FFXIV Weaver crafting rotation\./,
  );
  // Connections must stay a distinct section, not folded into Key Facts.
  const factsIndex = md.indexOf("## Key Facts");
  const connectionsIndex = md.indexOf("## Connections");
  assert.ok(factsIndex > -1 && connectionsIndex > factsIndex);
});

test("buildMemoryNotes creates one note per entity, empty otherwise", () => {
  const notes = buildMemoryNotes(
    { "acme corp": [{ sessionId: "s1", at: "2026-07-01", display: "Acme Corp" }] },
    [],
    [],
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0].slug, "acme-corp");
  assert.equal(notes[0].title, "Acme Corp");
  assert.match(notes[0].body, /# Acme Corp/);
  assert.match(notes[0].body, /session `s1`/);
  assert.deepEqual(notes[0].links, []);
});

test("buildMemoryNotes links entities that co-occur in the same session", () => {
  const notes = buildMemoryNotes(
    {
      "acme corp": [{ sessionId: "s1", at: "t1", display: "Acme Corp" }],
      "jane doe": [{ sessionId: "s1", at: "t1", display: "Jane Doe" }],
      "unrelated topic": [{ sessionId: "s2", at: "t2", display: "Unrelated Topic" }],
    },
    [],
    [],
  );
  const acme = notes.find((n) => n.slug === "acme-corp");
  const jane = notes.find((n) => n.slug === "jane-doe");
  const unrelated = notes.find((n) => n.slug === "unrelated-topic");

  assert.deepEqual(acme.links, ["jane-doe"]);
  assert.deepEqual(jane.links, ["acme-corp"]);
  assert.match(acme.body, /\[\[jane-doe\]\]/);
  assert.deepEqual(unrelated.links, []);
});

test("buildMemoryNotes creates a Key Facts note linking to mentioned entities", () => {
  const notes = buildMemoryNotes(
    { "ffxiv": [{ sessionId: "s1", at: "t1", display: "FFXIV" }] },
    ["Plays FFXIV on weekends", "Prefers concise replies"],
    [],
    // #1387: typed, so one mention is enough for a note.
    { ffxiv: { type: "project" } },
  );
  const facts = notes.find((n) => n.slug === "key-facts");
  assert.ok(facts);
  assert.match(facts.body, /- Plays FFXIV on weekends \(\[\[ffxiv\]\]\)/);
  assert.match(facts.body, /- Prefers concise replies\n/);
});

test("buildMemoryNotes creates a Connections note verbatim, and omits empty sections", () => {
  const notes = buildMemoryNotes({}, [], [
    "Summary #1 <-> Summary #3: both discuss the same crafting rotation.",
  ]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].slug, "connections");
  assert.match(notes[0].body, /both discuss the same crafting rotation/);
});

test("createApp wires the memory inbox watcher with a usable appendTurn/runVisionReply/runWhisper", async () => {
  let capturedOptions = null;
  createApp({
    startMemoryInboxWatcher: (options) => {
      capturedOptions = options;
    },
  });

  assert.ok(capturedOptions, "watcher start was called");
  assert.equal(typeof capturedOptions.inboxDir, "string");
  assert.equal(typeof capturedOptions.appendTurn, "function");
  assert.equal(typeof capturedOptions.runVisionReply, "function");
  assert.equal(typeof capturedOptions.runWhisper, "function");
});

// Persona override routes: real persona.js module (module-cache singleton,
// same as production), each test uses its own sessionId to avoid
// cross-test state bleed within this one process.
test("POST /persona/override sets a session override and reports it back", async () => {
  const app = createApp({});
  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/persona/override`, {
      sessionId: "route-test-session-a",
      override: "Stay extra quiet today.",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      ok: true,
      sessionId: "route-test-session-a",
      override: "Stay extra quiet today.",
    });
  });

  const persona = require("../persona");
  assert.equal(persona.getPersonaOverride("route-test-session-a"), "Stay extra quiet today.");
  persona.clearPersonaOverride("route-test-session-a");
});

test("POST /persona/override rejects a missing sessionId or override", async () => {
  const app = createApp({});
  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/persona/override`, {
      override: "no sessionId here",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(payload, { error: "sessionId and override are required" });
  });
});

test("POST /persona/override/clear removes a session's override", async () => {
  const persona = require("../persona");
  persona.setPersonaOverride("route-test-session-b", "Be a little more teasing.");

  const app = createApp({});
  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/persona/override/clear`, {
      sessionId: "route-test-session-b",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { ok: true, cleared: true });
  });

  assert.equal(persona.getPersonaOverride("route-test-session-b"), null);
});

// #475 whole-branch review fix: POST /editors/workspace/snapshots/:id/restore
// used to return 200 with {restored: {stale: true, ...}} on a stale,
// unconfirmed restore -- truthy, so both renderer UIs' own
// `if (!result.restored) throw` check read that as success and silently did
// nothing while claiming it worked. It must now return 409 with a
// non-truthy `restored`, so the renderers' existing error branch fires.
test("POST snapshots/:id/restore returns 409 with a non-truthy restored field when the underlying restore is stale", async () => {
  const staleResult = {
    stale: true,
    id: "snap-1",
    kind: "file",
    key: "a.txt",
    newerSnapshotId: "snap-2",
  };
  const app = createApp({
    editors: {
      restoreEditSnapshot: async (id, opts) => {
        assert.equal(id, "snap-1");
        assert.deepEqual(opts, { confirmStale: false });
        return staleResult;
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/editors/workspace/snapshots/snap-1/restore`, {}, ADMIN);
    assert.equal(response.status, 409);
    assert.equal(payload.restored, null);
    assert.deepEqual(payload.stale, staleResult);
  });
});

test("POST snapshots/:id/restore still returns 200 with the normal shape when the restore isn't stale", async () => {
  const app = createApp({
    editors: {
      restoreEditSnapshot: async () => ({ restoredPath: "/repo/a.txt" }),
    },
  });

  await withServer(app, async (baseUrl) => {
    const { response, payload } = await postJson(`${baseUrl}/editors/workspace/snapshots/snap-1/restore`, {}, ADMIN);
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { restored: { restoredPath: "/repo/a.txt" } });
  });
});

test("provider routes: added and checked from this PC only, keys never back out, kept while in use (#1426)", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createModelSettingsStore } = require("../model-settings-store");
  const { createModelManagement } = require("../model-management");
  const store = createModelSettingsStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mana-providers-")),
    secrets: { protect: (v) => `enc:${v}`, unprotect: (b) => b.slice(4) },
  });
  const checked = [];
  const modelManagement = createModelManagement({
    env: {},
    localGgufs: [],
    modelSettingsStore: store,
    checkToolLoop: async ({ baseUrl, apiKey }) => {
      checked.push([baseUrl, apiKey]);
      return { ok: true, model: "llama", chat: true, tools: true, stream: true };
    },
  });
  const app = createApp({ modelManagement });
  await withServer(app, async (baseUrl) => {
    const listed = await (await fetch(`${baseUrl}/models/providers`, { headers: ADMIN })).json();
    assert.ok(listed.presets.some((p) => p.id === "deepseek"));
    assert.deepEqual(listed.providers, []);

    const remote = await postJson(`${baseUrl}/models/providers`, { preset: "groq", apiKey: "gsk-1234" }, { ...ADMIN, "X-Forwarded-For": "192.168.1.50" });
    assert.equal(remote.response.status, 403);

    const added = await postJson(`${baseUrl}/models/providers`, { preset: "groq", apiKey: "gsk-1234" }, ADMIN);
    assert.equal(added.response.status, 200);
    assert.equal(added.payload.provider.keyHint, "…1234");
    assert.equal(added.payload.provider.lastCheck.ok, true);
    assert.equal(added.payload.provider.lastCheck.tools, true);
    assert.ok(!JSON.stringify(added.payload).includes("gsk-1234"));
    assert.deepEqual(checked, [["https://api.groq.com/openai/v1", "gsk-1234"]]);

    const twice = await postJson(`${baseUrl}/models/providers`, { preset: "groq", apiKey: "x" }, ADMIN);
    assert.equal(twice.response.status, 400);
    assert.match(twice.payload.error, /already added/);

    store.setFallbackSettings({ enabled: true, providerId: "groq", model: "llama" });
    const busy = await fetch(`${baseUrl}/models/providers/groq`, { method: "DELETE", headers: ADMIN });
    assert.equal(busy.status, 409);
    assert.match((await busy.json()).error, /Cloud fallback/);
  });
});
