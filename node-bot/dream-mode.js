// Issue #673 (idea 38): Dream Mode cursors. Pulled out of server.js's
// background-memory closures so the incremental logic is unit testable
// with a fake summarizer, the same reason skill-proposal.js was.
//
// Each stage keeps a watermark in background_meta.json's `cursors`
// ({mtime: newest session-file mtime it has processed, at: when it ran}).
// A session file whose mtime is past a stage's watermark is new (or changed)
// for that stage. Meta written before #673 has no cursors, so each stage's
// first run after upgrading behaves exactly as before and sets one.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function newSince(processedFiles, cursor) {
  const mark = Number(cursor?.mtime) || 0;
  return processedFiles.filter((p) => p.summary && Number(p.mtime) > mark);
}

function cursorAt(processedFiles, at) {
  return { mtime: Math.max(0, ...processedFiles.map((p) => Number(p.mtime) || 0)), at };
}

function setCursor(meta, stage, processedFiles, at, extra = {}) {
  meta.cursors = { ...(meta.cursors || {}), [stage]: { ...cursorAt(processedFiles, at), ...extra } };
}

function oneLine(text, maxChars) {
  let value = String(text || "").trim().replace(/\s+/g, " ");
  if (value.length > maxChars) value = `${value.slice(0, maxChars).trim()}...`;
  return value;
}

// The session-summary loader (was the body of server.js's
// asyncLoadBackgroundMemory): the maxFiles most recently modified session
// files, reusing meta.files' cached summary when the mtime is unchanged.
// #673: a file the reviewer pruned stays pruned until it changes -- pruning
// clears its summary, so without that check the cached-summary branch
// missed it, the file was re-read, and the prune was lost.
async function loadSessionSummaries({ sessionsDir, meta, maxFiles }) {
  const names = await fs.promises.readdir(sessionsDir);
  const jsonFiles = names.filter((f) => f.endsWith(".json"));
  const statsAll = (
    await Promise.all(
      jsonFiles.map(async (f) => {
        const p = path.join(sessionsDir, f);
        try {
          return { file: f, mtime: (await fs.promises.stat(p)).mtimeMs, path: p };
        } catch (e) {
          return null;
        }
      }),
    )
  ).filter(Boolean);
  statsAll.sort((a, b) => b.mtime - a.mtime);

  meta.files = meta.files || {};
  const summaries = [];
  const processedFiles = [];
  let processed = 0;
  for (const s of statsAll.slice(0, maxFiles)) {
    const prev = meta.files[s.file];
    if (prev && prev.mtime === s.mtime && prev.pruned) {
      processed++;
      continue;
    }
    if (prev && prev.mtime === s.mtime && prev.summary) {
      summaries.push(prev.summary);
      processedFiles.push({ file: s.file, summary: prev.summary, mtime: prev.mtime });
    } else {
      try {
        const obj = JSON.parse((await fs.promises.readFile(s.path, "utf8")) || "null") || {};
        const summ =
          typeof obj.summary === "string" ? obj.summary.replace(/\s+/g, " ").trim() : "";
        if (summ) summaries.push(summ);
        meta.files[s.file] = { mtime: s.mtime, summary: summ };
        processedFiles.push({ file: s.file, summary: summ, mtime: s.mtime });
      } catch (e) {
        // ignore malformed files and remove from meta
        delete meta.files[s.file];
      }
    }
    processed++;
  }
  return { summaries, processedFiles, processed, totalFiles: jsonFiles.length };
}

// Compactor. First run (no cursor): summarize everything, as before --
// unless the pre-#673 hash says nothing changed, in which case just set the
// cursor. After that, fold only new/changed summaries into the previous
// compacted text; with none, no model call at all.
// summarize(prompt) -> Promise<string|null>, the remote-then-local fallback.
async function runCompactorStage({ processedFiles, meta, summarize, maxChars, now }) {
  const withSummary = processedFiles.filter((p) => p.summary).slice(0, 200);
  if (!withSummary.length) return { called: false, text: null };
  const previous = meta.lastCompacted?.text || "";
  const cursor = meta.cursors?.compactor;
  const joined = withSummary.map((p) => p.summary).join("\n\n");
  const hash = crypto.createHash("sha1").update(joined).digest("hex");

  // A session that was folded in before and is gone now (deleted, or
  // pushed out of the maxFiles window) can't be subtracted from the
  // compacted text, so that forces a full rebuild, as every run did before.
  const current = new Set(withSummary.map((p) => p.file));
  const lostOne = (cursor?.files || []).some((file) => !current.has(file));

  let prompt;
  let fresh = withSummary;
  if (cursor && previous && !lostOne) {
    fresh = newSince(withSummary, cursor);
    if (!fresh.length) return { called: false, text: previous };
    prompt = `You are a concise summarization assistant. Below is the current background memory block, followed by session summaries that are new or changed since it was written. Update the block so it also covers the new summaries: keep concrete facts and user preferences, let newer information replace what it contradicts, and avoid redundancy. Return only the updated background memory text; do not add commentary.\n\nCURRENT BACKGROUND MEMORY:\n${previous}\n\nBEGIN NEW SUMMARIES:\n${fresh.map((p) => p.summary).join("\n\n")}\n\nEND NEW SUMMARIES\n\nUPDATED BACKGROUND MEMORY:`;
  } else {
    if (previous && meta.lastCompacted?.hash === hash) {
      setCursor(meta, "compactor", processedFiles, now(), { files: [...current] });
      return { called: false, text: previous, changedMeta: true };
    }
    prompt = `You are a concise summarization assistant. Combine the following session summaries into a single compact background memory block suitable for inclusion beneath system instructions. Keep concrete facts, user preferences, and avoid redundancy. Return only the compacted summary text; do not add commentary.\n\nBEGIN SUMMARIES:\n${joined}\n\nCOMPACT SUMMARY:`;
  }

  const reply = await summarize(prompt);
  if (!reply || typeof reply !== "string" || !reply.trim()) return { called: true, text: null };
  const text = oneLine(reply, maxChars);
  meta.lastCompacted = { hash, text, at: now() };
  setCursor(meta, "compactor", processedFiles, now(), { files: [...current] });
  return { called: true, text, incremental: fresh !== withSummary, summarized: fresh.length };
}

// Connections. Runs only when there are summaries new to this stage, and
// asks only for connections that involve at least one of them, against
// the most recent existing ones. New lines are merged ahead of the ones
// already found instead of replacing them.
// ask(prompt) -> Promise<string|null>.
async function runConnectionsStage({ processedFiles, meta, ask, maxSummaries, minSummaries, now }) {
  if (processedFiles.length < minSummaries) return { ok: false, reason: "not_enough_summaries" };
  const fresh = newSince(processedFiles, meta.cursors?.connections);
  if (!fresh.length) return { ok: false, reason: "no_new_summaries" };
  const freshFiles = new Set(fresh.map((p) => p.file));
  const listed = [...fresh, ...processedFiles.filter((p) => !freshFiles.has(p.file))].slice(
    0,
    maxSummaries,
  );
  const numbered = listed
    .map(
      (p, idx) =>
        `${idx + 1}. ${freshFiles.has(p.file) ? "[new] " : ""}[session: ${p.file}] ${String(p.summary || "").slice(0, 300)}`,
    )
    .join("\n\n");
  const prompt = `You are finding real connections between separate chat session summaries -- e.g. two sessions touching the same topic days apart, or one session following up on an earlier one. Given the numbered summaries below (each tagged with its session file; the ones marked [new] were added since the last check), list at most 5 short connection lines, each involving at least one [new] summary and saying what relates them by topic rather than by number, formatted like "FFXIV crafting rework: discussed again a week after it was first planned". Only report connections that are actually there -- if none of the [new] summaries connect to anything, reply with exactly the single word NONE and nothing else.\n\nBEGIN SUMMARIES:\n${numbered}\n\nEND SUMMARIES\n\nCONNECTIONS:`;

  const reply = await ask(prompt);
  if (!reply || typeof reply !== "string") return { ok: false, reason: "no_reply" };
  const trimmed = reply.trim();
  const found =
    !trimmed || /^NONE$/i.test(trimmed)
      ? []
      : trimmed
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 5);
  // Lines from before #673 name summaries by a number from an old prompt,
  // so the first run with a cursor replaces them instead of merging.
  meta.connections = meta.cursors?.connections
    ? mergeUnique(found, meta.connections || [], 5)
    : mergeUnique(found, [], 5);
  setCursor(meta, "connections", processedFiles, now());
  return { ok: true, connections: meta.connections, found };
}

// Newer first, case-insensitive dedupe, capped.
function mergeUnique(newer, older, cap) {
  const seen = new Set();
  const merged = [];
  for (const item of [...newer, ...older]) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    const k = value.toLowerCase();
    if (!value || seen.has(k)) continue;
    seen.add(k);
    merged.push(value);
  }
  return merged.slice(0, cap);
}

// Reviewer: the numbered list it reviews and whether a scheduled run can
// skip the model call. The sha1 of the list changes whenever a summary is
// added, changed or pruned, which is exactly "something new to review".
function reviewPlan({ processedFiles, meta, skipIfUnchanged }) {
  const numbered = processedFiles
    .map((p, idx) => `${idx + 1}. ${String(p.summary || "").slice(0, 400)}`)
    .join("\n\n");
  const hash = crypto.createHash("sha1").update(numbered).digest("hex");
  return { numbered, hash, skip: Boolean(skipIfUnchanged) && meta.lastReviewedHash === hash };
}

module.exports = {
  newSince,
  loadSessionSummaries,
  runCompactorStage,
  runConnectionsStage,
  mergeUnique,
  reviewPlan,
};
