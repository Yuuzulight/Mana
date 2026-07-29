const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");

const {
  skillsCapability,
  findMatchingSkill,
} = require("../capabilities/skills-capability");
const { withServer } = require("./helpers");

function fakeStore(overrides = {}) {
  return {
    listSkills: () => [],
    viewSkill: () => null,
    createSkill: () => {
      throw new Error("createSkill not stubbed");
    },
    updateSkill: () => null,
    deleteSkill: () => false,
    pruneStaleSkills: () => ({ staled: [], archived: [] }),
    ...overrides,
  };
}

// A minimal fake approval gate -- immediately "approves" every request by
// running the executor synchronously, mirroring what a real gate does once
// an action type is always-allowed. approval-gate.js's own pending/deny/
// always-allow logic is covered by approval-gate.test.js, not here.
function fakeApprovalGate(skillsStore) {
  return {
    requestApproval: async (actionType, { payload }) => ({
      status: "approved",
      actionType,
      result: skillsStore.createSkill(payload),
    }),
  };
}

test("skills capability lists the cheap index from the store", async () => {
  const app = express();
  app.use(express.json());
  skillsCapability.registerRoutes(app, {
    skillsStore: fakeStore({
      listSkills: () => [{ name: "Skill A", description: "desc", category: "general" }],
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.skills.length, 1);
    assert.equal(payload.skills[0].name, "Skill A");
  });
});

test("skills capability returns full content for a specific skill", async () => {
  const app = express();
  app.use(express.json());
  skillsCapability.registerRoutes(app, {
    skillsStore: fakeStore({
      viewSkill: (name) => (name === "Skill A" ? { name: "Skill A", body: "full body" } : null),
    }),
  });

  await withServer(app, async (baseUrl) => {
    const found = await fetch(`${baseUrl}/skills/${encodeURIComponent("Skill A")}`);
    assert.equal(found.status, 200);
    assert.equal((await found.json()).body, "full body");

    const missing = await fetch(`${baseUrl}/skills/nope`);
    assert.equal(missing.status, 404);
  });
});

test("skills capability creates a skill from name/description/body once the gate approves it", async () => {
  const app = express();
  app.use(express.json());
  let received = null;
  const skillsStore = fakeStore({
    createSkill: (input) => {
      received = input;
      return { ...input, fileName: "slug.md" };
    },
  });
  skillsCapability.registerRoutes(app, {
    skillsStore,
    approvalGate: fakeApprovalGate(skillsStore),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Skill", description: "d", body: "b" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 201);
    assert.equal(payload.fileName, "slug.md");
    assert.deepEqual(received, { name: "New Skill", description: "d", body: "b", category: undefined });
  });
});

test("skills capability's create route returns the gate's pending response when not yet approved", async () => {
  const app = express();
  app.use(express.json());
  skillsCapability.registerRoutes(app, {
    skillsStore: fakeStore(),
    approvalGate: {
      requestApproval: async () => ({ status: "pending", requestId: "abc123", summary: "Create skill \"New Skill\"" }),
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Skill", description: "d", body: "b" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 202);
    assert.equal(payload.status, "pending");
    assert.equal(payload.requestId, "abc123");
  });
});

test("skills capability rejects creation missing required fields", async () => {
  const app = express();
  app.use(express.json());
  skillsCapability.registerRoutes(app, {
    skillsStore: fakeStore(),
    approvalGate: fakeApprovalGate(fakeStore()),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(response.status, 400);
  });
});

test("skills capability's patch route updates a skill and is not gated by approval", async () => {
  const app = express();
  app.use(express.json());
  let received = null;
  skillsCapability.registerRoutes(app, {
    skillsStore: fakeStore({
      updateSkill: (name, updates) => {
        received = { name, updates };
        return { name, description: updates.description, body: "b", category: "general" };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills/${encodeURIComponent("Skill A")}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "updated desc" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.description, "updated desc");
    assert.deepEqual(received, { name: "Skill A", updates: { description: "updated desc" } });
  });
});

test("skills capability's patch route 404s for an unknown skill", async () => {
  const app = express();
  app.use(express.json());
  skillsCapability.registerRoutes(app, { skillsStore: fakeStore() });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills/nope`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    });
    assert.equal(response.status, 404);
  });
});

test("skills capability's delete route removes a skill", async () => {
  const app = express();
  app.use(express.json());
  let received = null;
  skillsCapability.registerRoutes(app, {
    skillsStore: fakeStore({
      deleteSkill: (name) => {
        received = name;
        return true;
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills/${encodeURIComponent("Skill A")}`, {
      method: "DELETE",
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { deleted: true, name: "Skill A" });
    assert.equal(received, "Skill A");
  });
});

test("skills capability's delete route 404s for an unknown skill", async () => {
  const app = express();
  app.use(express.json());
  skillsCapability.registerRoutes(app, { skillsStore: fakeStore() });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills/nope`, { method: "DELETE" });
    assert.equal(response.status, 404);
  });
});

test("skills capability's prune route delegates to the store with the request's thresholds", async () => {
  const app = express();
  app.use(express.json());
  let received = null;
  skillsCapability.registerRoutes(app, {
    skillsStore: fakeStore({
      pruneStaleSkills: (opts) => {
        received = opts;
        return { staled: ["A"], archived: [] };
      },
    }),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills/prune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staleDays: 10, archiveDays: 20 }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { ok: true, staled: ["A"], archived: [] });
    assert.deepEqual(received, { staleDays: 10, archiveDays: 20 });
  });
});

test("skills capability's propose route delegates to runSkillProposalPublic", async () => {
  const app = express();
  app.use(express.json());
  let received = null;
  const skillsStore = fakeStore();
  const approvalGate = fakeApprovalGate(skillsStore);
  skillsCapability.registerRoutes(app, {
    skillsStore,
    approvalGate,
    runSkillProposalPublic: async (deps) => {
      received = deps;
      return { ok: true, found: true, name: "new-skill" };
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills/propose`, { method: "POST" });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { ok: true, found: true, name: "new-skill" });
    assert.equal(received.skillsStore, skillsStore);
    assert.equal(received.approvalGate, approvalGate);
  });
});

test("skills capability's propose route reports unavailable when no proposal pass is wired", async () => {
  const app = express();
  app.use(express.json());
  skillsCapability.registerRoutes(app, { skillsStore: fakeStore() });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills/propose`, { method: "POST" });
    const payload = await response.json();
    assert.equal(response.status, 500);
    assert.equal(payload.ok, false);
  });
});

test("skills capability reports health with the current skill count", () => {
  const configured = skillsCapability.getHealth({
    skillsStore: fakeStore({ listSkills: () => [{}, {}] }),
  });
  assert.equal(configured.status, "configured");
  assert.equal(configured.count, 2);
});

test("findMatchingSkill matches on the skill name as a phrase", () => {
  const skills = [{ name: "restart-searxng", description: "bring web search back up" }];
  const match = findMatchingSkill(skills, "how do I restart searxng again?");
  assert.equal(match.name, "restart-searxng");
});

test("findMatchingSkill matches on overlapping significant words", () => {
  const skills = [
    { name: "diagnosing-a-stuck-tts-provider", description: "what to check when audio stops playing" },
  ];
  const match = findMatchingSkill(skills, "the audio stopped playing after the voice provider swapped");
  assert.equal(match.name, "diagnosing-a-stuck-tts-provider");
});

test("findMatchingSkill returns null when nothing overlaps", () => {
  const skills = [{ name: "restart-searxng", description: "bring web search back up" }];
  assert.equal(findMatchingSkill(skills, "what's the weather like"), null);
});

test("contributePromptContext returns the matched skill's full body and nothing when unmatched", async () => {
  const store = fakeStore({
    listSkills: () => [{ name: "restart-searxng", description: "bring web search back up" }],
    viewSkill: (name) =>
      name === "restart-searxng" ? { name: "restart-searxng", body: "1. do the thing" } : null,
  });

  const matched = await skillsCapability.contributePromptContext("please restart searxng", {
    skillsStore: store,
  });
  assert.equal(matched, "[SKILL: restart-searxng]\n1. do the thing\n[END SKILL]");

  const unmatched = await skillsCapability.contributePromptContext("what's for dinner", {
    skillsStore: store,
  });
  assert.equal(unmatched, "");
});
