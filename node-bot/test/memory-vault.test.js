// Issue #935: two-way sync between remembered facts and the Obsidian vault.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAcpMemoryStore } = require("../acp-memory-store");
const { VIEWS_MARKER, createMemoryVault, noteName, keyFromName, parseNote } = require("../memory-vault");
const { runDoctorChecks } = require("../doctor");

function setup({ approvals } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-vault-"));
  const vaultDir = path.join(root, "vault");
  fs.mkdirSync(vaultDir);
  const store = createAcpMemoryStore({ dataDir: path.join(root, "memory") });
  const logs = [];
  const approvalGate = approvals
    ? { requestApproval: async (type, request) => approvals.push({ type, ...request }) }
    : null;
  const clock = { ms: Date.now() };
  const vault = createMemoryVault({ store, vaultDir, approvalGate, watch: false, log: (m) => logs.push(m), now: () => clock.ms });
  const note = (rel) => path.join(vaultDir, rel);
  const read = (rel) => fs.readFileSync(note(rel), "utf8");
  const write = (rel, content) => fs.writeFileSync(note(rel), content, "utf8");
  const fact = (key) => store.listFacts().find((f) => f.key === key && f.status !== "stale");
  // A deleted note counts once it's been missing for two syncs 30 s apart.
  const syncPastGrace = () => {
    vault.sync();
    clock.ms += 31 * 1000;
    return vault.sync();
  };
  return { root, vaultDir, store, vault, logs, note, read, write, fact, clock, syncPastGrace };
}

test("facts export as notes, and a second sync writes nothing (idempotent first start)", () => {
  const t = setup();
  t.store.rememberFact({ key: "gpu", text: "The user has an RTX 5080.", origin: { kind: "user_stated" } });
  t.store.setFactPinned("gpu", true);
  t.store.rememberFact({ key: "coffee", text: "Maybe likes coffee.", origin: { kind: "model_inferred" } });

  const first = t.vault.sync();
  assert.equal(first.written, 2);
  const gpu = parseNote(t.read("Facts/gpu.md"));
  assert.equal(gpu.header.status, "active");
  assert.equal(gpu.header.pinned, true);
  assert.equal(gpu.header.source, "you told me");
  assert.match(String(gpu.header.since), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(gpu.body, "The user has an RTX 5080.");
  assert.equal(parseNote(t.read("Facts/Pending/coffee.md")).header.status, "pending");

  assert.deepEqual(t.vault.sync(), { applied: 0, written: 0, removed: 0, skipped: [] });
  // State lost (or the vault moved): the notes already there are adopted.
  fs.rmSync(path.join(t.root, "memory", "vault-sync.json"));
  const adopted = t.vault.sync();
  assert.equal(adopted.written, 0);
  assert.equal(t.fact("gpu").text, "The user has an RTX 5080.");
});

test("Mana's changes reach the note; its own writes never come back as edits (loop guard)", () => {
  const t = setup();
  t.store.rememberFact({ key: "gpu", text: "RTX 4080.", origin: { kind: "user_stated" } });
  t.vault.sync();
  const historyBefore = t.store.getFactHistory("gpu").length;
  t.store.rememberFact({ key: "gpu", text: "RTX 5080.", action: "patch", origin: { kind: "user_stated" } });
  assert.equal(t.vault.sync().written, 1);
  assert.equal(parseNote(t.read("Facts/gpu.md")).body, "RTX 5080.");
  assert.equal(t.vault.sync().applied, 0);
  // Only the patch was logged: nothing was read back from the vault.
  assert.equal(t.store.getFactHistory("gpu").length, historyBefore + 1);
});

test("editing an existing fact's note applies it directly as a vault edit; a pin change asks first", () => {
  const approvals = [];
  const t = setup({ approvals });
  t.store.rememberFact({ key: "gpu", text: "RTX 4080.", origin: { kind: "user_stated" } });
  t.vault.sync();
  t.write("Facts/gpu.md", t.read("Facts/gpu.md").replace("pinned: false", "pinned: true").replace("RTX 4080.", "RTX 5080,\nwater cooled."));
  const result = t.vault.sync();
  assert.equal(result.applied, 1);
  const gpu = t.fact("gpu");
  assert.equal(gpu.text, "RTX 5080, water cooled.");
  assert.equal(gpu.status, "active");
  assert.equal(gpu.origin.kind, "vault_edit");
  assert.equal(gpu.history.at(-1).text, "RTX 4080.");
  // Rewritten in Mana's own form, then quiet.
  assert.equal(parseNote(t.read("Facts/gpu.md")).header.source, "your vault");
  assert.equal(t.vault.sync().applied, 0);

  // Pinned means in every prompt: not until the user's OK in Mana.
  assert.equal(gpu.pinned, undefined);
  assert.equal(parseNote(t.read("Facts/gpu.md")).header.pinned, false);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].type, "memory-vault-pin");
  assert.equal(approvals[0].forceReview, true);
  assert.deepEqual(approvals[0].payload, { key: "gpu", pinned: true });
  // Approving runs server.js's executor, setFactPinned.
  t.store.setFactPinned(approvals[0].payload.key, approvals[0].payload.pinned);
  t.vault.sync();
  assert.equal(parseNote(t.read("Facts/gpu.md")).header.pinned, true);
});

test("a note keeps its own header lines, its line breaks and a BOM doesn't break it", () => {
  const t = setup();
  t.store.rememberFact({ key: "gpu", text: "RTX 4080.", origin: { kind: "user_stated" } });
  t.vault.sync();
  const mine = "tags:\n  - hardware\n  - pc\naliases: [graphics card]\n# my comment\ncssclasses:\n- wide";
  t.write(
    "Facts/gpu.md",
    `\uFEFF${t.read("Facts/gpu.md").replace("pinned: false", `pinned: false\n${mine}`).replace("RTX 4080.", "RTX 5080,\n\nwater cooled.")}`,
  );
  t.vault.sync();
  assert.equal(t.fact("gpu").text, "RTX 5080, water cooled.");
  let note = t.read("Facts/gpu.md");
  assert.ok(note.includes(`${mine}\n---\n\nRTX 5080,\n\nwater cooled.\n`));
  assert.match(note, /^---\nstatus: active\npinned: false\n/);
  assert.equal(parseNote(note).header.tags, undefined);
  assert.equal(t.vault.sync().applied, 0);

  // Mana's own change replaces the body but keeps the user's header lines.
  t.store.rememberFact({ key: "gpu", text: "RTX 5090.", action: "patch", origin: { kind: "user_stated" } });
  t.vault.sync();
  note = t.read("Facts/gpu.md");
  assert.ok(note.includes(`${mine}\n---\n\nRTX 5090.\n`));
  // Moved to Archived/: still kept.
  t.store.rememberFact({ key: "gpu", action: "archive" });
  t.vault.sync();
  assert.ok(t.read("Facts/Archived/gpu.md").includes(mine));
});

test("a vault edit keeps the untrusted flag and redaction still applies", () => {
  const t = setup();
  t.store.rememberFact({ key: "site", text: "Some claim.", unverifiedSource: true, origin: { kind: "user_stated" } });
  t.vault.sync();
  t.write("Facts/site.md", t.read("Facts/site.md").replace("Some claim.", "my key sk-abcdefghijklmnopqrstuvwxyz123456 ok"));
  t.vault.sync();
  const site = t.fact("site");
  assert.equal(site.unverifiedSource, true);
  assert.doesNotMatch(site.text, /sk-abcdef/);
  assert.doesNotMatch(t.read("Facts/site.md"), /sk-abcdef/);
});

test("a brand-new note becomes a pending fact that asks for the user's OK", () => {
  const approvals = [];
  const t = setup({ approvals });
  t.vault.sync();
  t.write("Facts/raid night.md", "---\nstatus: active\npinned: true\n---\nRaid night is Friday.\n");
  t.vault.sync();
  const raid = t.fact("raid night");
  assert.equal(raid.status, "pending");
  assert.equal(raid.pinned, undefined);
  assert.equal(raid.origin.kind, "vault_edit");
  assert.doesNotMatch(t.store.getRelatedFacts("when is raid night"), /Friday/);
  assert.equal(fs.existsSync(t.note("Facts/raid night.md")), false);
  assert.equal(parseNote(t.read("Facts/Pending/raid night.md")).header.status, "pending");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].type, "memory-vault-note");
  assert.equal(approvals[0].forceReview, true);
  assert.deepEqual(
    { key: approvals[0].payload.key, action: approvals[0].payload.action },
    { key: "raid night", action: "confirm" },
  );

  // Approving in Mana (the executor is rememberFact) moves the note.
  t.store.rememberFact(approvals[0].payload);
  t.vault.sync();
  assert.equal(t.fact("raid night").status, "active");
  assert.equal(fs.existsSync(t.note("Facts/Pending/raid night.md")), false);
  assert.ok(fs.existsSync(t.note("Facts/raid night.md")));
});

test("a new note with a trigger becomes a pending standing intent", () => {
  const t = setup();
  t.vault.sync();
  t.write("Facts/raid.md", '---\ntrigger: "raids: prog"\n---\nMention the food buff.\n');
  t.vault.sync();
  const raid = t.fact("raid");
  assert.equal(raid.status, "pending");
  assert.equal(raid.trigger, "raids: prog");
  assert.equal(raid.triggerUserWords, "raids: prog");
  assert.equal(parseNote(t.read("Facts/Pending/raid.md")).header.trigger, "raids: prog");
});

test("an intent's trigger and paused flag are editable from its note", () => {
  const t = setup();
  t.store.rememberFact({ key: "raid", text: "Mention the food buff.", trigger: "raids", origin: { kind: "user_stated" } });
  t.vault.sync();
  const content = t.read("Facts/raid.md");
  assert.match(content, /trigger: "raids"\npaused: false/);
  t.write("Facts/raid.md", content.replace('"raids"', '"savage raids"').replace("paused: false", "paused: true"));
  t.vault.sync();
  const raid = t.fact("raid");
  assert.equal(raid.trigger, "savage raids");
  assert.equal(raid.triggerUserWords, "savage raids");
  assert.equal(raid.paused, true);
});

test("status: archived in the header archives; deleting a note archives; moving it back restores", () => {
  const t = setup();
  t.store.rememberFact({ key: "gpu", text: "RTX 5080.", origin: { kind: "user_stated" } });
  t.store.rememberFact({ key: "cat", text: "Has a cat.", origin: { kind: "user_stated" } });
  t.vault.sync();

  t.write("Facts/gpu.md", t.read("Facts/gpu.md").replace("status: active", "status: archived"));
  t.vault.sync();
  assert.equal(t.fact("gpu").status, "archived");
  assert.equal(fs.existsSync(t.note("Facts/gpu.md")), false);
  assert.equal(parseNote(t.read("Facts/Archived/gpu.md")).header.status, "archived");

  fs.unlinkSync(t.note("Facts/cat.md"));
  // Not yet (a sync tool may be replacing the file), and not written back.
  assert.equal(t.vault.sync().written, 0);
  assert.equal(t.fact("cat").status, "active");
  assert.equal(fs.existsSync(t.note("Facts/cat.md")), false);
  t.clock.ms += 29 * 1000;
  t.vault.sync();
  assert.equal(t.fact("cat").status, "active");
  t.clock.ms += 2 * 1000;
  t.vault.sync();
  assert.equal(t.fact("cat").status, "archived");
  assert.ok(fs.existsSync(t.note("Facts/Archived/cat.md")));

  fs.renameSync(t.note("Facts/Archived/cat.md"), t.note("Facts/cat.md"));
  t.vault.sync();
  assert.equal(t.fact("cat").status, "active");
  assert.equal(parseNote(t.read("Facts/cat.md")).header.status, "active");
  assert.equal(fs.existsSync(t.note("Facts/Archived/cat.md")), false);
  assert.equal(t.store.getFactHistory("cat").at(-1).op, "unarchive");

  // Deleting an archived note leaves the fact archived and the note gone.
  fs.unlinkSync(t.note("Facts/Archived/gpu.md"));
  assert.equal(t.syncPastGrace().written, 0);
  assert.equal(t.fact("gpu").status, "archived");
  assert.equal(fs.existsSync(t.note("Facts/Archived/gpu.md")), false);
});

test("conflict: the user's vault edit wins, Mana's version stays in the history log", () => {
  const t = setup();
  t.store.rememberFact({ key: "gpu", text: "RTX 4080.", origin: { kind: "user_stated" } });
  t.vault.sync();
  t.write("Facts/gpu.md", t.read("Facts/gpu.md").replace("RTX 4080.", "RTX 5080 (mine)."));
  t.store.rememberFact({ key: "gpu", text: "RTX 5090 (Mana's).", action: "patch", origin: { kind: "user_stated" } });
  t.vault.sync();
  assert.equal(t.fact("gpu").text, "RTX 5080 (mine).");
  assert.equal(parseNote(t.read("Facts/gpu.md")).body, "RTX 5080 (mine).");
  const logged = t.store.getFactHistory("gpu").map((e) => e.after?.text);
  assert.ok(logged.includes("RTX 5090 (Mana's)."));
});

test("changing status on a pending note doesn't approve it: reverted and logged", () => {
  const t = setup();
  t.store.rememberFact({ key: "coffee", text: "Likes coffee.", origin: { kind: "model_inferred" } });
  t.vault.sync();
  t.write("Facts/Pending/coffee.md", t.read("Facts/Pending/coffee.md").replace("status: pending", "status: active"));
  t.vault.sync();
  assert.equal(t.fact("coffee").status, "pending");
  assert.equal(parseNote(t.read("Facts/Pending/coffee.md")).header.status, "pending");
  assert.ok(t.logs.some((m) => /ignored the status change.*approved only in Mana/.test(m)));

  // Moving it out of Pending/ doesn't approve it either.
  fs.renameSync(t.note("Facts/Pending/coffee.md"), t.note("Facts/coffee.md"));
  t.vault.sync();
  assert.equal(t.fact("coffee").status, "pending");
  assert.ok(fs.existsSync(t.note("Facts/Pending/coffee.md")));
  assert.equal(fs.existsSync(t.note("Facts/coffee.md")), false);
});

test("a broken or oversized note is skipped, left alone, and named by Doctor", () => {
  const t = setup();
  t.store.rememberFact({ key: "gpu", text: "RTX 5080.", origin: { kind: "user_stated" } });
  t.vault.sync();
  const broken = "---\nstatus: active\nthis is not yaml\n---\nRTX 9090.\n";
  t.write("Facts/gpu.md", broken);
  t.write("Facts/huge.md", `---\n---\n${"x".repeat(9000)}\n`);
  const result = t.vault.sync();
  assert.deepEqual(result.skipped.map((s) => s.file).sort(), ["Facts/gpu.md", "Facts/huge.md"]);
  assert.equal(t.read("Facts/gpu.md"), broken);
  assert.equal(t.fact("gpu").text, "RTX 5080.");
  assert.equal(t.fact("huge"), undefined);

  const check = runDoctorChecks({ memoryVault: t.vault.getStatus() }).checks.find((c) => c.id === "memory-vault");
  assert.equal(check.status, "warn");
  assert.match(check.message, /Facts\/gpu\.md \(broken YAML header line/);

  // Fixed: taken in, and the warning clears.
  t.write("Facts/gpu.md", broken.replace("this is not yaml\n", ""));
  fs.unlinkSync(t.note("Facts/huge.md"));
  t.vault.sync();
  assert.equal(t.fact("gpu").text, "RTX 9090.");
  assert.equal(runDoctorChecks({ memoryVault: t.vault.getStatus() }).checks.find((c) => c.id === "memory-vault").status, "pass");
});

test("temp files, dot files, other folders and non-.md files are ignored", () => {
  const t = setup();
  t.vault.sync();
  fs.mkdirSync(t.note("Facts/Other"));
  t.write("Facts/Other/x.md", "---\n---\nNope.\n");
  t.write("Facts/.hidden.md", "---\n---\nNope.\n");
  t.write("Facts/~draft.md", "---\n---\nNope.\n");
  t.write("Facts/notes.txt", "Nope.");
  fs.mkdirSync(t.note(".obsidian"));
  t.write(".obsidian/app.md", "---\n---\nNope.\n");
  assert.equal(t.vault.sync().applied, 0);
  assert.equal(t.store.listFacts().length, 0);
});

test("keys become safe filenames and decode back; no path escapes the vault", () => {
  for (const key of ["../../evil", "a/b\\c", "CON", "what? <yes>: #1 [x]|^", "trailing.", " 50% "]) {
    const name = noteName(key);
    assert.doesNotMatch(name, /[<>:"/\\|?*#^[\]]/);
    assert.doesNotMatch(name, /^\.|[. ]$/);
    assert.equal(keyFromName(name), key.trim());
  }
  assert.match(noteName("CON"), /^%43ON$/);
  assert.ok(noteName("k".repeat(200)).length <= 120);

  const t = setup();
  t.store.rememberFact({ key: "../../evil", text: "Stays inside.", origin: { kind: "user_stated" } });
  t.store.rememberFact({ key: "k".repeat(200), text: "Long key.", origin: { kind: "user_stated" } });
  t.vault.sync();
  assert.deepEqual(fs.readdirSync(t.vaultDir).sort(), ["Facts"]);
  const long = fs.readdirSync(t.note("Facts")).find((n) => n.startsWith("kkk"));
  // A cut name still binds to its fact.
  t.write(`Facts/${long}`, t.read(`Facts/${long}`).replace("Long key.", "Long key, edited."));
  t.vault.sync();
  assert.equal(t.fact("k".repeat(200)).text, "Long key, edited.");
});

test("a missing vault folder is an error, never created", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-vault-"));
  const store = createAcpMemoryStore({ dataDir: path.join(root, "memory") });
  const vault = createMemoryVault({ store, vaultDir: path.join(root, "nope"), watch: false, log: () => {} });
  vault.sync();
  assert.equal(fs.existsSync(path.join(root, "nope")), false);
  assert.equal(vault.getStatus().writable, false);
  const check = runDoctorChecks({ memoryVault: vault.getStatus() }).checks.find((c) => c.id === "memory-vault");
  assert.equal(check.status, "warn");
});

test("start() mirrors Mana's fact changes automatically", async () => {
  const t = setup();
  const vault = createMemoryVault({ store: t.store, vaultDir: t.vaultDir, watch: false, log: () => {} });
  vault.start();
  t.store.rememberFact({ key: "gpu", text: "RTX 5080.", origin: { kind: "user_stated" } });
  await new Promise((resolve) => setTimeout(resolve, 1700));
  vault.stop();
  assert.equal(parseNote(t.read("Facts/gpu.md")).body, "RTX 5080.");
});

test("moving a note into Archived/ archives it; deleting a pending note archives it", () => {
  const t = setup();
  t.store.rememberFact({ key: "gpu", text: "RTX 5080.", origin: { kind: "user_stated" } });
  t.store.rememberFact({ key: "coffee", text: "Likes coffee.", origin: { kind: "model_inferred" } });
  t.vault.sync();
  fs.renameSync(t.note("Facts/gpu.md"), t.note("Facts/Archived/gpu.md"));
  fs.unlinkSync(t.note("Facts/Pending/coffee.md"));
  t.syncPastGrace();
  assert.equal(t.fact("gpu").status, "archived");
  assert.equal(parseNote(t.read("Facts/Archived/gpu.md")).header.status, "archived");
  assert.equal(t.fact("coffee").status, "archived");
  assert.ok(fs.existsSync(t.note("Facts/Archived/coffee.md")));
});

test("a note that's back within the grace period was never deleted", () => {
  const t = setup();
  t.store.rememberFact({ key: "gpu", text: "RTX 5080.", origin: { kind: "user_stated" } });
  t.vault.sync();
  const content = t.read("Facts/gpu.md");
  fs.unlinkSync(t.note("Facts/gpu.md"));
  t.vault.sync();
  t.write("Facts/gpu.md", content);
  t.clock.ms += 31 * 1000;
  t.vault.sync();
  // Gone again later: the grace starts over.
  fs.unlinkSync(t.note("Facts/gpu.md"));
  t.vault.sync();
  assert.equal(t.fact("gpu").status, "active");
  t.clock.ms += 31 * 1000;
  t.vault.sync();
  assert.equal(t.fact("gpu").status, "archived");
});

test("renaming a note renames its fact instead of archiving it and adding a pending one", () => {
  const approvals = [];
  const t = setup({ approvals });
  t.store.rememberFact({ key: "gpu", text: "RTX 5080.", origin: { kind: "user_stated" } });
  t.store.setFactPinned("gpu", true);
  t.vault.sync();
  const id = t.fact("gpu").id;
  fs.renameSync(t.note("Facts/gpu.md"), t.note("Facts/graphics card.md"));
  t.vault.sync();
  assert.equal(t.fact("gpu"), undefined);
  const renamed = t.fact("graphics card");
  assert.deepEqual([renamed.id, renamed.status, renamed.pinned, renamed.text], [id, "active", true, "RTX 5080."]);
  assert.equal(t.store.getFactHistory("graphics card").at(-1).op, "rename");
  assert.equal(approvals.length, 0);
  assert.ok(fs.existsSync(t.note("Facts/graphics card.md")));
  assert.equal(fs.existsSync(t.note("Facts/gpu.md")), false);
  assert.deepEqual(t.syncPastGrace(), { applied: 0, written: 0, removed: 0, skipped: [] });
  assert.equal(t.store.listFacts().length, 1);
});

test("sync-conflict copies are skipped, never taken in or touched", () => {
  const t = setup();
  t.store.rememberFact({ key: "gpu", text: "RTX 5080.", origin: { kind: "user_stated" } });
  t.vault.sync();
  const copies = [
    "Facts/gpu-DESKTOP-4F2K9.md",
    "Facts/gpu 2.md",
    "Facts/gpu.sync-conflict-20260930-101500-ABCDEFG.md",
    "Facts/gpu (conflicted copy 2026-09-30).md",
    "Facts/Pending/gpu (Conflicted copy laptop 202609301015).md",
  ];
  for (const rel of copies) t.write(rel, t.read("Facts/gpu.md").replace("RTX 5080.", "RTX 4080."));
  // Ordinary names that only look alike are still new notes.
  t.write("Facts/raid 2.md", "---\ntags: raid\n---\nSecond raid team.\n");
  t.write("Facts/gpu-fan.md", "---\ntags: pc\n---\nNoisy.\n");
  const result = t.vault.sync();
  assert.deepEqual(result.skipped.map((s) => s.file).sort(), [...copies].sort());
  assert.ok(result.skipped.every((s) => s.reason === "a sync-conflict copy, ignored"));
  assert.equal(t.fact("gpu").text, "RTX 5080.");
  for (const rel of copies) assert.ok(fs.existsSync(t.note(rel)));
  assert.equal(t.fact("raid 2").status, "pending");
  assert.equal(t.fact("gpu-fan").status, "pending");
});

test("restoring is refused while another live fact holds the key", () => {
  const t = setup();
  t.store.rememberFact({ key: "gpu", text: "RTX 4080.", origin: { kind: "user_stated" } });
  t.store.rememberFact({ key: "gpu", action: "archive" });
  t.store.rememberFact({ key: "gpu", text: "RTX 5080.", origin: { kind: "user_stated" } });
  t.vault.sync();
  t.write("Facts/Archived/gpu.md", t.read("Facts/Archived/gpu.md").replace("status: archived", "status: active"));
  t.vault.sync();
  const live = t.store.listFacts().filter((f) => f.key === "gpu" && f.status === "active");
  assert.equal(live.length, 1);
  assert.equal(live[0].text, "RTX 5080.");
  assert.ok(t.logs.some((m) => /can't restore "gpu"/.test(m)));
  assert.equal(parseNote(t.read("Facts/Archived/gpu.md")).header.status, "archived");
});

function viewsVault(t, views) {
  return createMemoryVault({ store: t.store, vaultDir: t.vaultDir, watch: false, log: () => {}, buildViews: () => views.list });
}

test("views are written read-only under Views/, regenerated when they change, and never read back", () => {
  const t = setup();
  const views = {
    list: [
      { rel: "Views/Summary.md", body: "# Mana Memory\n\nSummary one.\n" },
      { rel: "Views/Mood.md", body: "# Mana's mood\n\nRight now: okay.\n" },
      { rel: "Views/Entities/tokyo.md", body: "# Tokyo\n" },
    ],
  };
  const vault = viewsVault(t, views);
  vault.refreshViews();
  const summary = t.read("Views/Summary.md");
  assert.ok(summary.startsWith(`${VIEWS_MARKER}\n\n# Mana Memory`));
  assert.match(VIEWS_MARKER, /edits here are overwritten/);
  assert.ok(t.read("Views/Entities/tokyo.md").startsWith(VIEWS_MARKER));

  // An edit is overwritten, and never becomes a fact.
  t.write("Views/Summary.md", `${summary}\nMy own line.\n`);
  t.write("Views/notes-of-mine.md", "Not Mana's.\n");
  assert.equal(vault.sync().applied, 0);
  views.list = [
    { rel: "Views/Summary.md", body: "# Mana Memory\n\nSummary two.\n" },
    { rel: "Views/Mood.md", body: "# Mana's mood\n\nRight now: okay.\n" },
  ];
  const moodBefore = fs.statSync(t.note("Views/Mood.md")).mtimeMs;
  vault.refreshViews();
  assert.doesNotMatch(t.read("Views/Summary.md"), /My own line|Summary one/);
  assert.match(t.read("Views/Summary.md"), /Summary two/);
  assert.equal(fs.statSync(t.note("Views/Mood.md")).mtimeMs, moodBefore);
  // A view Mana no longer has is removed; a file that isn't Mana's is kept.
  assert.equal(fs.existsSync(t.note("Views/Entities/tokyo.md")), false);
  assert.equal(t.read("Views/notes-of-mine.md"), "Not Mana's.\n");
  assert.equal(t.store.listFacts().length, 0);
});

test("a view path outside Views/ is refused", () => {
  const t = setup();
  const vault = viewsVault(t, { list: [{ rel: "Views/../Facts/evil.md", body: "x" }] });
  vault.refreshViews();
  assert.equal(fs.existsSync(t.note("Facts/evil.md")), false);
});

function journalVault(t, { reply = "We talked about the raid and my new GPU.", gaming = false } = {}) {
  const calls = [];
  const vault = createMemoryVault({
    store: t.store,
    vaultDir: t.vaultDir,
    watch: false,
    log: () => {},
    runModel: async (prompt, maxTokens) => {
      calls.push({ prompt, maxTokens });
      return typeof reply === "function" ? reply() : reply;
    },
    isGaming: () => gaming,
  });
  return { vault, calls };
}

test("the journal appends a short entry linking the facts it touched", async () => {
  const t = setup();
  const transcript = `Let's plan the raid. ${"blah ".repeat(1000)}`;
  await t.store.appendTurn({ sessionId: "s1", user: transcript, assistant: "Sure!" });
  t.store.rememberFact({ key: "raid night", text: "Raid night is Friday.", origin: { kind: "user_stated" } });
  const { vault, calls } = journalVault(t, { reply: `Today was fun. ${"x".repeat(5000)}` });

  assert.equal(await vault.writeJournal(), true);
  const files = fs.readdirSync(t.note("Journal"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.md$/);
  const journal = t.read(`Journal/${files[0]}`);
  assert.match(journal, /^# \d{4}-\d{2}-\d{2}\n\n## \d{2}:\d{2}\n\nToday was fun\./);
  assert.match(journal, /Facts: \[\[raid night\]\]/);
  // Short, and never the transcript.
  assert.ok(journal.length < 1400);
  assert.doesNotMatch(journal, /blah blah/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.length < 4000);
  assert.match(calls[0].prompt, /Raid night is Friday/);

  // Nothing new since: no model call, no entry.
  assert.equal(await vault.writeJournal(), false);
  assert.equal(calls.length, 1);
});

test("the journal skips while gaming or when no model is loaded", async () => {
  const t = setup();
  t.store.rememberFact({ key: "gpu", text: "RTX 5080.", origin: { kind: "user_stated" } });
  const gaming = journalVault(t, { gaming: true });
  assert.equal(await gaming.vault.writeJournal(), false);
  assert.equal(gaming.calls.length, 0);
  const unloaded = journalVault(t, { reply: null });
  assert.equal(await unloaded.vault.writeJournal(), false);
  assert.equal(fs.existsSync(t.note("Journal")), false);
});

test("views and the journal never create a missing vault", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mana-vault-"));
  const store = createAcpMemoryStore({ dataDir: path.join(root, "memory") });
  store.rememberFact({ key: "gpu", text: "RTX 5080.", origin: { kind: "user_stated" } });
  const vault = createMemoryVault({
    store,
    vaultDir: path.join(root, "nope"),
    watch: false,
    log: () => {},
    buildViews: () => [{ rel: "Views/Mood.md", body: "okay" }],
    runModel: async () => "A day.",
  });
  vault.refreshViews();
  assert.equal(await vault.writeJournal(), false);
  assert.equal(fs.existsSync(path.join(root, "nope")), false);
});
