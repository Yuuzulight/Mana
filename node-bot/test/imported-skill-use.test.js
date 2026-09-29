// Q20 (#664): using an imported (SKILL.md folder) skill follows Settings >
// Skills -- "free", "each" (ask every time) or "first" (ask the first time,
// the default). Mana's own flat skills are never asked about.
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createSkillsStore } = require("../skills-store");
const { createSkillToolSource } = require("../ai/skill-tool-source");
const { createApprovalGate } = require("../approval-gate");
const { skillsCapability } = require("../capabilities/skills-capability");
const { withServer } = require("./helpers");

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function setup() {
  const skillsStore = createSkillsStore({ skillsDir: tempDir("mana-imported-skills-") });
  skillsStore.importSkill({
    files: [
      {
        path: "SKILL.md",
        encoding: "utf8",
        content: "---\nname: pdf tools\ndescription: work with pdf files\n---\nUse nano-pdf.\n",
      },
    ],
  });
  skillsStore.createSkill({ name: "tea timer", description: "time the tea", body: "Wait 3 minutes." });
  const approvalGate = createApprovalGate({ dataDir: tempDir("mana-imported-approvals-") });
  const source = createSkillToolSource({ approvalGate, skillsStore });
  const view = async (name) => JSON.parse(await source.executeTool("skill__view", { name }));
  const approveAll = async () => {
    for (const request of approvalGate.listPending()) await approvalGate.decide(request.id, "allow-once");
  };
  return { skillsStore, approvalGate, view, approveAll };
}

test("default 'ask the first time': one approval, then used freely; own skills never ask", async () => {
  const { skillsStore, approvalGate, view, approveAll } = setup();
  assert.equal(skillsStore.getImportedSkillUse(), "first");

  assert.equal((await view("tea timer")).status, "ok");
  const asked = await view("pdf tools");
  assert.equal(asked.status, "pending");
  assert.match(asked.note, /imported skill/);
  assert.equal(approvalGate.listPending()[0].forceReview, true);

  await approveAll();
  assert.equal((await view("pdf tools")).body, "Use nano-pdf.");
  assert.equal((await view("pdf tools")).status, "ok");
  assert.equal(approvalGate.listPending().length, 0);

  // Deleting it forgets the approval: a re-import is asked about again.
  assert.equal(skillsStore.deleteSkill("pdf tools"), true);
  assert.equal(skillsStore.mayUseImportedSkill("pdf tools"), false);
});

test("'ask each time' asks for every use; 'use freely' never asks", async () => {
  const { skillsStore, approvalGate, view, approveAll } = setup();
  skillsStore.setImportedSkillUse("each");

  assert.equal((await view("pdf tools")).status, "pending");
  await approveAll();
  assert.equal((await view("pdf tools")).status, "ok");
  assert.equal((await view("pdf tools")).status, "pending", "the approval covered one use");

  skillsStore.setImportedSkillUse("free");
  assert.equal((await view("pdf tools")).status, "ok");
  assert.throws(() => skillsStore.setImportedSkillUse("sometimes"), /importedSkillUse must be one of/);
});

test("an imported skill's text isn't put in the prompt unasked; the setting is read and saved (local-only)", async () => {
  const { skillsStore } = setup();
  const context = { skillsStore };
  assert.equal(await skillsCapability.contributePromptContext("help me with pdf files", context), "");
  skillsStore.setImportedSkillUse("free");
  assert.match(await skillsCapability.contributePromptContext("help me with pdf files", context), /nano-pdf/);

  let local = true;
  const app = express();
  app.use(express.json());
  skillsCapability.registerRoutes(app, { skillsStore, isLocalRestartRequest: () => local });
  await withServer(app, async (baseUrl) => {
    const put = (importedSkillUse) =>
      fetch(`${baseUrl}/skill-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importedSkillUse }),
      });
    assert.equal((await put("each")).status, 200);
    assert.deepEqual(await (await fetch(`${baseUrl}/skill-settings`)).json(), { importedSkillUse: "each" });
    assert.equal((await put("nope")).status, 400);
    local = false;
    assert.equal((await put("free")).status, 403);
  });
  assert.equal(skillsStore.getImportedSkillUse(), "each");
});
