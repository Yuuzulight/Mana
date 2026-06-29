# Editor Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared local backend approval flow so Mana can apply editor edit proposals only after explicit user approval.

**Architecture:** Extend the existing shared editor integration module with `approveEditProposal(id)`, then expose it through `POST /editors/workspace/proposals/:id/approve`. Keep Zed and VS Code editor adapters behind the same local backend boundary so future editor integrations reuse the same approval and conflict checks.

**Tech Stack:** Node.js CommonJS, Express, Node built-in test runner, local filesystem APIs.

---

## File Structure

- Modify `node-bot/zed-integration.js`: add the proposal approval method, workspace-contained path resolution, exact original-content conflict check, and applied proposal status update.
- Modify `node-bot/server.js`: add `POST /editors/workspace/proposals/:id/approve` near the existing proposal routes.
- Modify `node-bot/test/zed-integration.test.js`: add focused unit and route tests for approval success, conflict, repeat approval, and missing proposals.
- Modify `node-bot/mana-acp-agent.js`: update ACP filesystem capability metadata to `write: "approval-required"`.
- Modify `node-bot/test/mana-acp-agent.test.js`: update the initialize capability assertion.
- Modify `docs/zed_external_agent.md`: document the shared `/approve` approval flow.

---

### Task 1: Add Failing Tests For Shared Proposal Approval

**Files:**
- Modify: `node-bot/test/zed-integration.test.js`

- [ ] **Step 1: Add unit tests after the existing "editor integrations create safe edit proposals without writing files" test**

Add this code after that test block:

```js
test("editor integrations approve a pending proposal and write the proposed content", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-approve-"));
  const sourceFile = path.join(tempDir, "src.js");
  fs.writeFileSync(sourceFile, "const value = 1;\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const timestamps = [
      new Date("2026-06-29T00:00:00.000Z"),
      new Date("2026-06-29T00:01:00.000Z"),
    ];
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
      idFactory: () => "proposal-approve-1",
      now: () => timestamps.shift() || new Date("2026-06-29T00:02:00.000Z"),
    });

    editors.createEditProposal({
      path: "src.js",
      proposedContent: "const value = 2;\n",
      summary: "Update value",
    });

    assert.equal(fs.readFileSync(sourceFile, "utf8"), "const value = 1;\n");

    const applied = editors.approveEditProposal("proposal-approve-1");

    assert.equal(applied.id, "proposal-approve-1");
    assert.equal(applied.status, "applied");
    assert.equal(applied.appliedAt, "2026-06-29T00:01:00.000Z");
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "const value = 2;\n");
    assert.equal(editors.getEditProposal("proposal-approve-1").status, "applied");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("editor integrations reject approval when the file changed after proposal creation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-conflict-"));
  const sourceFile = path.join(tempDir, "src.js");
  fs.writeFileSync(sourceFile, "const value = 1;\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
      idFactory: () => "proposal-conflict-1",
    });

    editors.createEditProposal({
      path: "src.js",
      proposedContent: "const value = 2;\n",
      summary: "Update value",
    });
    fs.writeFileSync(sourceFile, "const value = 3;\n");

    assert.throws(
      () => editors.approveEditProposal("proposal-conflict-1"),
      /content changed/i,
    );
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "const value = 3;\n");
    assert.equal(editors.getEditProposal("proposal-conflict-1").status, "pending");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("editor integrations reject approving the same proposal twice", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-approve-once-"));
  const sourceFile = path.join(tempDir, "src.js");
  fs.writeFileSync(sourceFile, "const value = 1;\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const editors = createEditorIntegrations({
      env: {},
      commandResolver: (command) => command,
      workspaceStore,
      idFactory: () => "proposal-once-1",
    });

    editors.createEditProposal({
      path: "src.js",
      proposedContent: "const value = 2;\n",
      summary: "Update value",
    });
    editors.approveEditProposal("proposal-once-1");

    assert.throws(
      () => editors.approveEditProposal("proposal-once-1"),
      /not pending/i,
    );
    assert.equal(fs.readFileSync(sourceFile, "utf8"), "const value = 2;\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval\node-bot
node --test test\zed-integration.test.js
```

Expected: FAIL because `editors.approveEditProposal` is not a function.

- [ ] **Step 3: Commit failing tests**

Do not commit failing tests separately. Keep them staged only if needed; implementation follows in Task 2.

---

### Task 2: Implement Shared Proposal Approval

**Files:**
- Modify: `node-bot/zed-integration.js`
- Test: `node-bot/test/zed-integration.test.js`

- [ ] **Step 1: Add approval support inside `createEditProposalStore`**

In `node-bot/zed-integration.js`, inside `createEditProposalStore`, add this function after `getProposal`:

```js
  function markApplied(id) {
    const proposal = getProposal(id);
    if (proposal.status !== "pending") {
      throw new Error("edit proposal is not pending");
    }

    proposal.status = "applied";
    proposal.appliedAt = now().toISOString();
    return proposal;
  }
```

Then add `markApplied` to the returned object:

```js
  return {
    createProposal,
    getProposal,
    listProposals,
    markApplied,
  };
```

- [ ] **Step 2: Add `approveEditProposal` inside `createEditorIntegrations`**

In `node-bot/zed-integration.js`, add this function after `getEditProposal`:

```js
  function approveEditProposal(id) {
    const workspace = requireActiveWorkspace(workspaceStore);
    const proposal = proposalStore.getProposal(id);
    if (proposal.status !== "pending") {
      throw new Error("edit proposal is not pending");
    }

    const target = toWorkspaceRelativePath(workspace.path, proposal.relativePath);
    if (!fs.existsSync(target.fullPath) || !fs.statSync(target.fullPath).isFile()) {
      throw new Error("workspace file does not exist");
    }

    const currentContent = fs.readFileSync(target.fullPath, "utf8");
    if (currentContent !== proposal.originalContent) {
      throw new Error("edit proposal conflict: current file content changed");
    }

    fs.writeFileSync(target.fullPath, proposal.proposedContent, "utf8");
    return proposalStore.markApplied(id);
  }
```

Add it to the returned object:

```js
  return {
    approveEditProposal,
    createEditProposal,
    getEditProposal,
    getWorkspace,
    getStatus,
    listWorkspaceFiles,
    listEditProposals,
    open,
    readWorkspaceFile,
    setWorkspace,
  };
```

- [ ] **Step 3: Run the focused tests**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval\node-bot
node --test test\zed-integration.test.js
```

Expected: PASS for all `zed-integration` tests.

- [ ] **Step 4: Commit shared approval implementation**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval
git add node-bot\zed-integration.js node-bot\test\zed-integration.test.js
git commit -m "feat: approve editor edit proposals"
```

---

### Task 3: Add Backend `/approve` Route

**Files:**
- Modify: `node-bot/server.js`
- Modify: `node-bot/test/zed-integration.test.js`

- [ ] **Step 1: Add route tests after the existing "createApp exposes safe edit proposal routes" test**

Add this code:

```js
test("createApp approves an edit proposal through the shared backend route", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-route-approve-"));
  const sourceFile = path.join(tempDir, "app.js");
  fs.writeFileSync(sourceFile, "console.log('before');\n");

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const timestamps = [
      new Date("2026-06-29T00:00:00.000Z"),
      new Date("2026-06-29T00:01:00.000Z"),
    ];
    const app = createApp({
      editors: createEditorIntegrations({
        env: {},
        commandResolver: (command) => command,
        workspaceStore,
        idFactory: () => "proposal-route-approve-1",
        now: () => timestamps.shift() || new Date("2026-06-29T00:02:00.000Z"),
        spawn: () => ({ once: (event, handler) => event === "spawn" && handler() }),
      }),
    });

    await withServer(app, async (baseUrl) => {
      await fetch(`${baseUrl}/editors/workspace/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "app.js",
          proposedContent: "console.log('after');\n",
          summary: "Change log text",
        }),
      });

      const approveResponse = await fetch(
        `${baseUrl}/editors/workspace/proposals/proposal-route-approve-1/approve`,
        { method: "POST" },
      );
      const approveBody = await approveResponse.json();

      assert.equal(approveResponse.status, 200);
      assert.equal(approveBody.proposal.id, "proposal-route-approve-1");
      assert.equal(approveBody.proposal.status, "applied");
      assert.equal(approveBody.proposal.appliedAt, "2026-06-29T00:01:00.000Z");
      assert.equal(fs.readFileSync(sourceFile, "utf8"), "console.log('after');\n");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createApp returns an error when approving a missing proposal", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-editor-route-approve-missing-"));

  try {
    const workspaceStore = createEditorWorkspaceStore();
    workspaceStore.setWorkspace(tempDir, { editor: "zed" });
    const app = createApp({
      editors: createEditorIntegrations({
        env: {},
        commandResolver: (command) => command,
        workspaceStore,
        spawn: () => ({ once: (event, handler) => event === "spawn" && handler() }),
      }),
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/editors/workspace/proposals/missing-proposal/approve`,
        { method: "POST" },
      );
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.equal(body.proposal, null);
      assert.match(body.error, /edit proposal not found/i);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run route tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval\node-bot
node --test test\zed-integration.test.js
```

Expected: FAIL because the `/approve` route does not exist.

- [ ] **Step 3: Add the route in `server.js`**

Add this route after `app.get("/editors/workspace/proposals/:id", ...)`:

```js
app.post("/editors/workspace/proposals/:id/approve", (req, res) => {
  try {
    const editors = getEditorIntegrations();
    return res.json({ proposal: editors.approveEditProposal(req.params.id) });
  } catch (error) {
    return res.status(400).json({
      proposal: null,
      error: error.message,
    });
  }
});
```

- [ ] **Step 4: Run the focused tests**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval\node-bot
node --test test\zed-integration.test.js
```

Expected: PASS for all `zed-integration` tests.

- [ ] **Step 5: Commit backend approval route**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval
git add node-bot\server.js node-bot\test\zed-integration.test.js
git commit -m "feat: expose editor proposal approval route"
```

---

### Task 4: Update ACP Capability Metadata And Docs

**Files:**
- Modify: `node-bot/mana-acp-agent.js`
- Modify: `node-bot/test/mana-acp-agent.test.js`
- Modify: `docs/zed_external_agent.md`

- [ ] **Step 1: Update the ACP test expectation**

In `node-bot/test/mana-acp-agent.test.js`, change the initialize metadata expectation from:

```js
write: "proposal-only",
```

to:

```js
write: "approval-required",
```

- [ ] **Step 2: Run the ACP tests to verify they fail**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval\node-bot
node --test test\mana-acp-agent.test.js
```

Expected: FAIL because `mana-acp-agent.js` still reports `proposal-only`.

- [ ] **Step 3: Update `mana-acp-agent.js`**

In `node-bot/mana-acp-agent.js`, change:

```js
write: "proposal-only",
```

to:

```js
write: "approval-required",
```

- [ ] **Step 4: Update `docs/zed_external_agent.md`**

Replace the current limit that says no apply action is exposed with wording that says:

```md
- File edits are reviewable proposals first.
- Applying a proposal requires an explicit local backend approval call: `POST /editors/workspace/proposals/:id/approve`.
- The approval route checks that the current file content still matches the proposal's original snapshot before writing.
- If the file changed, Mana refuses the write and keeps the proposal pending for review.
```

- [ ] **Step 5: Run the ACP tests**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval\node-bot
node --test test\mana-acp-agent.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit capability and docs update**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval
git add node-bot\mana-acp-agent.js node-bot\test\mana-acp-agent.test.js docs\zed_external_agent.md
git commit -m "docs: document editor approval writes"
```

---

### Task 5: Final Verification

**Files:**
- Verify all changed JavaScript and docs.

- [ ] **Step 1: Run focused test suite**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval\node-bot
node --test test\zed-integration.test.js test\mana-acp-agent.test.js
```

Expected: all tests pass.

- [ ] **Step 2: Run syntax checks**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval\node-bot
node --check zed-integration.js
node --check server.js
node --check mana-acp-agent.js
```

Expected: no output and exit code 0 for each command.

- [ ] **Step 3: Check working tree**

Run:

```powershell
cd C:\ManaAI\Mana\.worktrees\zed-agent-shared-approval
git status --short --branch
```

Expected: branch is clean and ahead of `origin/main` by the new commits.

- [ ] **Step 4: Commit any missed documentation or test updates**

If `git status --short` shows intended files, inspect them with `git diff`, then commit with a specific message. Do not commit dependency folders or generated artifacts.
