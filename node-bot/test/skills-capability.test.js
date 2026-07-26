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
    pruneStaleSkills: () => ({ staled: [], archived: [] }),
    ...overrides,
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

test("skills capability creates a skill from name/description/body", async () => {
  const app = express();
  app.use(express.json());
  let received = null;
  skillsCapability.registerRoutes(app, {
    skillsStore: fakeStore({
      createSkill: (input) => {
        received = input;
        return { ...input, fileName: "slug.md" };
      },
    }),
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

test("skills capability rejects creation missing required fields", async () => {
  const app = express();
  app.use(express.json());
  skillsCapability.registerRoutes(app, { skillsStore: fakeStore() });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(response.status, 400);
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
