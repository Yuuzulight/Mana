# Mid-turn Correction/Amend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth barge-in classifier category, `amend`, that steers an in-flight reply via a same-topic correction ("no, the other file") instead of discarding it (`correction`) or treating it as an unrelated new topic (`new_question`).

**Architecture:** One new keyword-checked branch in the existing `classifyBargeIn` function, checked ahead of `correction` so amend-shaped phrasing doesn't get swallowed by `correction`'s broader keywords. Dispatch in both apps mirrors `correction`'s existing shape exactly (discard the held reply, send the transcript as a new turn, no resume) — the only difference is the transcript gets a light instructional wrapper before sending, so the model produces a corrected continuation using the original reply it already has in session history, rather than an unrelated answer.

**Tech Stack:** Node's built-in `node:test` (backend), vanilla JS Electron renderers (no new automated coverage for the renderer-side dispatch, matching #339/#340's own precedent).

**Spec:** [docs/superpowers/specs/2026-08-20-mid-turn-amend-design.md](../specs/2026-08-20-mid-turn-amend-design.md)

## Global Constraints

- No LLM generation is aborted — the amend turn is a fresh generation informed by session history (already verified to contain the original reply by the time any barge-in can fire), not a mid-stream edit.
- No new backend endpoint or request schema — `amend` reuses the existing `/reply`(`-stream`) path via `handleTranscript`/`handleTranscriptText`, with a client-side text wrapper only.
- The amend keyword list is deliberately narrow (`"the other"`, `"not that"`, `"not this"`) — it must NOT include `"i meant"`, since that would reclassify the existing, already-tested `correction` case `"wait, that's not what I meant"` (its substring `"...what i meant"` contains `"i meant"`) as `amend` instead, a silent regression to shipped #339/#340 behavior. This was verified by checking every existing test string in `node-bot/test/barge-in-classifier.test.js` for collisions before finalizing the list — none of the three chosen keywords appear in any existing test case.
- A bare contrastive phrase with none of the three keywords (e.g. "in Python not JS") is an accepted, documented gap for this pass — it falls through to `new_question` instead of `amend`. Not a bug to fix here.

---

## File Structure

- **Modify** `node-bot/utils/barge-in-classifier.js` — add the `amend` category check.
- **Modify** `node-bot/test/barge-in-classifier.test.js` — add `amend` test cases, including a non-regression check on the existing `correction` test.
- **Modify** `windows-launcher/renderer/renderer.js` — add the `amend` dispatch branch to `handleBargeInInterruption`.
- **Modify** `desktop-client/renderer/renderer.js` — add the `amend` dispatch branch to `handleDesktopBargeInInterruption`.

---

## Task 1: Backend classifier — `amend` category

**Files:**
- Modify: `node-bot/utils/barge-in-classifier.js`
- Test: `node-bot/test/barge-in-classifier.test.js`

**Interfaces:**
- Produces: `classifyBargeIn(text)` now also returns `{ category: 'amend', reason: string }` for matching input — consumed by Tasks 2/3's renderer dispatch code (via the existing `POST /barge-in/classify` endpoint, unchanged by this task).

- [ ] **Step 1: Write the failing tests**

Add to `node-bot/test/barge-in-classifier.test.js`, after the existing `"correction keywords are checked before question/backchannel keywords"` test:

```js
test("amend-shaped clarifications classify as amend, ahead of correction's overlapping keywords", () => {
  // "no" alone is a correction keyword, but "the other" wins since amend is
  // checked first.
  assert.equal(classifyBargeIn("no, the other file").category, "amend");
  assert.equal(classifyBargeIn("not that one, the other one").category, "amend");
  assert.equal(classifyBargeIn("not this file").category, "amend");
});

test("amend's keyword list does not regress the existing correction case it could have collided with", () => {
  // "that's not what I meant" contains neither "the other" nor "not that"
  // nor "not this" -- this must keep classifying as correction, unchanged
  // from #339/#340's shipped behavior.
  assert.equal(classifyBargeIn("wait, that's not what I meant").category, "correction");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd node-bot && node --test test/barge-in-classifier.test.js`
Expected: the two new tests FAIL (amend doesn't exist yet, so `classifyBargeIn("no, the other file")` currently returns `category: "correction"`, not `"amend"`); every other existing test still passes.

- [ ] **Step 3: Add the `amend` category check**

In `node-bot/utils/barge-in-classifier.js`, update the JSDoc `@returns` type and insert a new numbered section **before** the existing `// 1. Correction/stop keywords` section (renumbering the existing sections 1→2, 2→3, 3→4, 4→5):

Replace:

```js
/**
 * Classifies a transcribed barge-in interruption so the caller can decide
 * whether to resume the reply that was cut off, discard it, or answer the
 * interruption and then resume. Matches intent-classifier.js's style:
 * ordered keyword lists, .includes() checks, explicit fallback.
 *
 * @param {string} text
 * @returns {{ category: 'backchannel'|'correction'|'new_question'|'unclassified', reason: string }}
 */
function classifyBargeIn(text) {
  if (!text || typeof text !== "string") {
    return { category: "unclassified", reason: "empty_or_invalid_input" };
  }
  const textLower = text.toLowerCase().trim();

  // Short/bare-word keywords ("no", "ok") collide with substrings of
  // unrelated words ("now", "know", "joke") under .includes(), so match
  // those on word boundaries; multi-word phrases ("hold on", "never mind")
  // aren't single dictionary words that collide, so substring is fine.
  const words = textLower.split(/[^a-z']+/).filter(Boolean);
  const matchesKeyword = (keyword) =>
    keyword.includes(" ") ? textLower.includes(keyword) : words.includes(keyword);

  // 1. Correction/stop keywords -- checked first (fast-path) so a sentence
  // that also happens to contain a question word ("wait, is that right")
  // still stops the reply instead of being treated as a new question.
  const correctionKeywords = [
```

with:

```js
/**
 * Classifies a transcribed barge-in interruption so the caller can decide
 * whether to resume the reply that was cut off, discard it, amend it, or
 * answer the interruption and then resume. Matches intent-classifier.js's
 * style: ordered keyword lists, .includes() checks, explicit fallback.
 *
 * @param {string} text
 * @returns {{ category: 'amend'|'backchannel'|'correction'|'new_question'|'unclassified', reason: string }}
 */
function classifyBargeIn(text) {
  if (!text || typeof text !== "string") {
    return { category: "unclassified", reason: "empty_or_invalid_input" };
  }
  const textLower = text.toLowerCase().trim();

  // Short/bare-word keywords ("no", "ok") collide with substrings of
  // unrelated words ("now", "know", "joke") under .includes(), so match
  // those on word boundaries; multi-word phrases ("hold on", "never mind")
  // aren't single dictionary words that collide, so substring is fine.
  const words = textLower.split(/[^a-z']+/).filter(Boolean);
  const matchesKeyword = (keyword) =>
    keyword.includes(" ") ? textLower.includes(keyword) : words.includes(keyword);

  // 1. Amend keywords -- checked first, ahead of correction, so a same-topic
  // clarification ("no, the other file") steers the reply instead of being
  // treated as a full stop. Deliberately narrow (no "i meant") -- a broader
  // match would swallow the existing correction phrasing "that's not what
  // I meant" (its "...what i meant" tail contains "i meant" as a substring).
  const amendKeywords = [
    "the other",
    "not that",
    "not this",
  ];
  const matchedAmend = amendKeywords.find(matchesKeyword);
  if (matchedAmend) {
    return { category: "amend", reason: `matched_amend_keyword (${matchedAmend})` };
  }

  // 2. Correction/stop keywords -- checked next (fast-path) so a sentence
  // that also happens to contain a question word ("wait, is that right")
  // still stops the reply instead of being treated as a new question.
  const correctionKeywords = [
```

Then, purely for numbering consistency (no behavior change), update the three remaining `// N.` comments later in the same function:
- `// 2. New-question heuristic:` → `// 3. New-question heuristic:`
- `// 3. Backchannel keywords.` → `// 4. Backchannel keywords.`
- `// 4. Default:` → `// 5. Default:`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd node-bot && node --test test/barge-in-classifier.test.js`
Expected: PASS (all tests, existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add node-bot/utils/barge-in-classifier.js node-bot/test/barge-in-classifier.test.js
git commit -m "Add amend category to the barge-in classifier (#399)"
```

---

## Task 2: windows-launcher — `amend` dispatch

**Files:**
- Modify: `windows-launcher/renderer/renderer.js`

**Interfaces:**
- Consumes: `classifyBargeInText(text)` (existing, unchanged) — its `category` result now includes `"amend"`; `heldReply`, `handleTranscript(transcript, gamingModeActive)` (both existing, unchanged).

Before editing, re-read the current `handleBargeInInterruption` function in `windows-launcher/renderer/renderer.js` (grep for `async function handleBargeInInterruption`) to confirm it still matches the shape below — this file has had several rounds of edits already.

- [ ] **Step 1: Add the `amend` branch**

Replace:

```js
async function handleBargeInInterruption(category, transcript, gamingModeActive) {
  // Captured once up front: a nested interruption's own capture window can
  // overlap this one's `await handleTranscript` below (see
  // bargeInCaptureCount's doc comment) and replace the module-global
  // `heldReply` with a new hold before this call resumes -- comparing
  // identity against `hold` rather than re-reading the global lets this
  // dispatch stay correct regardless of that ordering.
  const hold = heldReply;

  if (category === "correction") {
    heldReply = null;
    if (transcript) {
      await handleTranscript(transcript, gamingModeActive);
    }
    return;
  }
```

with:

```js
async function handleBargeInInterruption(category, transcript, gamingModeActive) {
  // Captured once up front: a nested interruption's own capture window can
  // overlap this one's `await handleTranscript` below (see
  // bargeInCaptureCount's doc comment) and replace the module-global
  // `heldReply` with a new hold before this call resumes -- comparing
  // identity against `hold` rather than re-reading the global lets this
  // dispatch stay correct regardless of that ordering.
  const hold = heldReply;

  if (category === "amend") {
    // Same shape as correction (discard, no resume -- the amended reply
    // replaces what was being said, it doesn't supplement it), except the
    // transcript is wrapped so the model steers using the original reply
    // it already has in session history (see the design doc's Key Finding:
    // buildAssistantReply appends the full reply to session history before
    // /reply/stream's final event, well before any barge-in can fire).
    heldReply = null;
    if (transcript) {
      await handleTranscript(`(amending what you just said) ${transcript}`, gamingModeActive);
    }
    return;
  }

  if (category === "correction") {
    heldReply = null;
    if (transcript) {
      await handleTranscript(transcript, gamingModeActive);
    }
    return;
  }
```

- [ ] **Step 2: Manual verification**

You cannot launch the actual Electron app in this environment. Read through the edited `handleBargeInInterruption` once end-to-end and confirm: `classifyBargeInText` (defined nearby, unchanged) returns whatever `POST /barge-in/classify` responds with, `handleBargeInTrigger` (the caller, unchanged) passes that `category` straight through, and the new `if (category === "amend")` branch is reached before the `"correction"` check for an `amend`-classified transcript — `node --check renderer/renderer.js` confirms no syntax error was introduced.

- [ ] **Step 3: Commit**

```bash
git add windows-launcher/renderer/renderer.js
git commit -m "Add amend dispatch to windows-launcher's barge-in handler (#399)"
```

---

## Task 3: desktop-client — `amend` dispatch

**Files:**
- Modify: `desktop-client/renderer/renderer.js`

**Interfaces:**
- Consumes: `classifyBargeInText(text)` (existing, unchanged) — its `category` result now includes `"amend"`; `heldReply`, `handleTranscriptText(transcript)` (both existing, unchanged).

Before editing, re-read the current `handleDesktopBargeInInterruption` function in `desktop-client/renderer/renderer.js` (grep for `async function handleDesktopBargeInInterruption`) to confirm it still matches the shape below.

- [ ] **Step 1: Add the `amend` branch**

Replace:

```js
  async function handleDesktopBargeInInterruption(category, transcript) {
    // Captured once up front: a nested interruption's own capture window can
    // overlap this one's `await handleTranscriptText` below (see
    // bargeInCaptureCount's doc comment) and replace the module-global
    // `heldReply` with a new hold before this call resumes -- comparing
    // identity against `hold` rather than re-reading the global lets this
    // dispatch stay correct regardless of that ordering.
    const hold = heldReply;

    if (category === 'correction') {
      heldReply = null;
      if (transcript) {
        await handleTranscriptText(transcript);
      }
      return;
    }
```

with:

```js
  async function handleDesktopBargeInInterruption(category, transcript) {
    // Captured once up front: a nested interruption's own capture window can
    // overlap this one's `await handleTranscriptText` below (see
    // bargeInCaptureCount's doc comment) and replace the module-global
    // `heldReply` with a new hold before this call resumes -- comparing
    // identity against `hold` rather than re-reading the global lets this
    // dispatch stay correct regardless of that ordering.
    const hold = heldReply;

    if (category === 'amend') {
      // Same shape as correction (discard, no resume -- the amended reply
      // replaces what was being said, it doesn't supplement it), except the
      // transcript is wrapped so the model steers using the original reply
      // it already has in session history (see the design doc's Key Finding:
      // buildAssistantReply appends the full reply to session history before
      // /reply/stream's final event, well before any barge-in can fire).
      heldReply = null;
      if (transcript) {
        await handleTranscriptText(`(amending what you just said) ${transcript}`);
      }
      return;
    }

    if (category === 'correction') {
      heldReply = null;
      if (transcript) {
        await handleTranscriptText(transcript);
      }
      return;
    }
```

- [ ] **Step 2: Manual verification**

Same as Task 2 Step 2: read through the edited function end-to-end, confirm the `amend` branch is reached ahead of `correction`, and run `node --check renderer/renderer.js` to confirm no syntax error.

- [ ] **Step 3: Commit**

```bash
git add desktop-client/renderer/renderer.js
git commit -m "Add amend dispatch to desktop-client's barge-in handler (#399)"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (classifier `amend` category, checked ahead of `correction`) → Task 1. §2 (dispatch mirrors `correction`'s shape, transcript wrapper, no resume) → Tasks 2/3. §3 (no LLM-abort, no held-text reconstruction) → confirmed by construction — neither task introduces any generation-abort or held-text-passing code. Testing section's `amend`-vs-`correction` non-regression requirement → Task 1 Step 1's second test.
- **Placeholder scan:** every step has complete, concrete code copied from (or diffed against) the actual current files, read fresh during this plan's authoring. No TBD/TODO. The spec's own "exact regex/keyword list finalized during implementation" caveat was resolved here, in the plan, not deferred further — the final three-keyword list is concrete and verified non-colliding against every existing test string.
- **Type consistency:** `classifyBargeIn`'s return shape (`{category, reason}`) is unchanged in structure, only the `category` enum grows by one value (`'amend'`), consumed identically by both apps' existing `classifyBargeInText` (untouched — it already just forwards whatever `category` the endpoint returns). `handleTranscript(transcript, gamingModeActive)` and `handleTranscriptText(transcript)` are called with the exact same signatures the `correction` branch already uses, just a different first-argument string.
