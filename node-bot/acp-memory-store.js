const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { significantWords, sharedWordCount } = require("./utils/word-overlap");
const { cosine } = require("./tools/vector-store");
const { detectTextValence } = require("./utils/text-mood");
const { parseTemporalWindow } = require("./utils/temporal-query");
const { redactSensitive } = require("./utils/sensitive-text");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

// Issue #263 part 2: cleanText's .slice(0, maxLength) keeps the START of
// the string -- correct for most uses here (a user/assistant turn that's
// too long should keep its beginning), but wrong for the rolling session
// summary specifically: the newest turn's summaryLine is always appended
// at the END, so once the accumulated string exceeds maxSummaryChars,
// cleanText would silently drop the just-added newest content and keep
// stale early material instead. This keeps the END (most recent) instead.
function truncateKeepingRecent(value, maxLength) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? cleaned.slice(-maxLength) : cleaned;
}

// Issue #364: the related-facts blocks get cut to a character budget by
// their callers. A plain .slice() lands mid-line, and a clipped fact still
// reads as a whole one -- "- coffee: likes it, but not after 6pm" becomes
// "- coffee: likes it," and inverts its own meaning, which is worse than
// dropping it. Drop whole lines instead, then drop any trailing header
// left with nothing under it ("Remembered:" on its own says nothing).
// A single line longer than the budget is dropped rather than clipped.
function truncateWholeLines(block, maxChars) {
  if (block.length <= maxChars) return block;
  const kept = [];
  let used = 0;
  for (const line of block.split("\n")) {
    const cost = kept.length ? line.length + 1 : line.length;
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  while (kept.length && !kept[kept.length - 1].startsWith("- ")) kept.pop();
  return kept.join("\n");
}

// Issue #674: recall finds facts by meaning, not only by their key
// appearing word for word, and the number injected per turn is capped.
const MAX_RECALL_CANDIDATES = 20;
const MAX_PINNED_FACTS = 5;
// session_search returns up to 20; after a rerank only the best go back.
const SESSION_SEARCH_RERANKED_TOP = 8;
// ponytail: fixed cosine cutoff, not tuned against real Qwen3-Embedding
// scores yet -- make it an env var if recall is visibly too loose/tight.
const MIN_FACT_SIMILARITY = 0.5;

// Issue #663: "pending" is a fact Mana picked up on her own and the user has
// not confirmed yet. It is live (patchable, recallable, one per key) like an
// active fact; old records have no pending status, so they behave as before.
function isLiveFact(fact) {
  return fact.status === "active" || fact.status === "pending";
}

// Issue #317/#277/#431: unverified, archived/stale and invalidated facts
// never auto-surface -- unchanged from the key-match-only version. #663:
// pending facts do, marked tentative (factsBlockFor).
function isRecallable(fact) {
  return isLiveFact(fact) && !fact.unverifiedSource && !fact.invalidatedAt;
}

// Facts from before ids existed fall back to their (active-unique) key;
// prefixed so a key like "__proto__" can't collide with an object builtin
// in the embedding cache.
function factRecallId(fact) {
  return fact.id || `key:${fact.key}`;
}

function newestFirst(a, b) {
  return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
}

// Issue #698: a standing intent ("when X comes up, mention Y") is a fact
// with a `trigger` (X; its text is Y). It never surfaces as a plain fact:
// it fires when a message is about its trigger, then waits out the
// cooldown. Only a confirmed (active) intent fires; paused and expired
// ones never do. A missing expiresAt/lastFiredAt parses to NaN, and every
// comparison with NaN is false, so neither blocks.
const INTENT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
// ponytail: fixed cap so a message touching many intents doesn't turn the
// reply into a list of reminders; the rest fire on a later match.
const MAX_INTENTS_PER_TURN = 2;
// Cosine cutoff for an intent's trigger vs the message, stricter than
// MIN_FACT_SIMILARITY because a wrong reminder is worse than a missed one.
// Measured 2026-09-29 with the live Qwen3-Embedding-0.6B-Q8_0 on this exact
// path (trigger bare, message with QUERY_PROMPT): 12 intents x 6 positive /
// 6 hard-negative messages, best F0.5 at 0.55 (P 0.89, R 0.46; 0.50 gave
// P 0.77, R 0.61), and 0.2% false fires on other intents' messages.
const MIN_INTENT_SIMILARITY = 0.55;
// Q41: a keyword match on the trigger only breaks a near-tie -- it fires an
// intent whose similarity is in [0.45, 0.55), never on its own (keywords
// alone false-fired on other senses of a word, e.g. "static electricity").
const MIN_INTENT_KEYWORD_SIMILARITY = 0.45;

// Q42: an intent's trigger is saved twice -- Mana's restated rule
// (`trigger`) and the user's own words (`triggerUserWords`) -- and either
// can match. The user's words get their own vector under this id suffix.
const USER_WORDS_ID_SUFFIX = "#user";

function intentTriggers(fact) {
  return [fact.trigger, fact.triggerUserWords].filter(Boolean);
}

// Facts plus, for each intent saved with the user's own words, a stand-in
// whose trigger is those words, so it's embedded and cached separately.
function withUserWordsVariants(facts) {
  return facts.flatMap((fact) =>
    fact.trigger && fact.triggerUserWords
      ? [fact, { ...fact, id: `${factRecallId(fact)}${USER_WORDS_ID_SUFFIX}`, trigger: fact.triggerUserWords }]
      : [fact],
  );
}

// Whole words only, so a short trigger like "GPU" (too short for
// significantWords) still matches "a new GPU?" but not "gpus".
function wordsOf(text) {
  return ` ${String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(" ")} `;
}

function intentCanFire(fact, nowMs) {
  return (
    fact.status === "active" &&
    !fact.paused &&
    !(Date.parse(fact.expiresAt) <= nowMs) &&
    !(nowMs - Date.parse(fact.lastFiredAt) < INTENT_COOLDOWN_MS)
  );
}

// Issue #674: pure candidate gathering. Pinned facts always go in (up to
// MAX_PINNED_FACTS, newest first) and never also count as matches. The
// matched candidates come in three tiers, first to last:
//   1. the key appears in the message (as before #674), ordered by key
//      length then recency (#364) -- so a store with only key hits orders
//      exactly as it did before;
//   2. vector similarity over "key: text" (when similarityById is given),
//   3. keyword overlap on key + text (significantWords), needing two shared
//      words, or one for a one-word message -- same min() shape as
//      findConflictingFact -- so a single common word like "have" alone
//      doesn't pull in unrelated facts.
// Tiers 2 and 3 share one sort: similarity, then shared words, then recency.
// #698: intents match the same three ways, on their trigger (similarity is
// over the trigger's own vector, see factEmbeddingText), and come back
// separately as `intents`.
function factRecallCandidates(facts, text, similarityById = null, nowMs = Date.now()) {
  const lowerText = String(text || "").toLowerCase();
  const messageWords = significantWords(text);
  const minWordHits = Math.min(2, messageWords.length);
  const pinned = [];
  const keyHits = [];
  const scored = [];
  const intents = [];
  const messageWordString = wordsOf(text);
  for (const fact of facts) {
    if (!isRecallable(fact)) continue;
    if (fact.trigger) {
      if (!intentCanFire(fact, nowMs)) continue;
      const id = factRecallId(fact);
      const similarity = Math.max(
        similarityById?.get(id) || 0,
        similarityById?.get(`${id}${USER_WORDS_ID_SUFFIX}`) || 0,
      );
      let wordHits = 0;
      let keywordHit = false;
      for (const trigger of intentTriggers(fact)) {
        const triggerWords = significantWords(trigger);
        const hits = sharedWordCount(triggerWords, messageWords);
        const triggerWordString = wordsOf(trigger);
        if (
          (triggerWordString.trim() && messageWordString.includes(triggerWordString)) ||
          (triggerWords.length && hits >= Math.min(2, triggerWords.length))
        ) {
          keywordHit = true;
        }
        wordHits = Math.max(wordHits, hits);
      }
      if (similarity >= MIN_INTENT_SIMILARITY || (keywordHit && similarity >= MIN_INTENT_KEYWORD_SIMILARITY)) {
        intents.push({ fact, similarity, wordHits });
      }
      continue;
    }
    if (fact.pinned) {
      pinned.push(fact);
      continue;
    }
    if (lowerText.includes(fact.key.toLowerCase())) {
      keyHits.push(fact);
      continue;
    }
    const similarity = similarityById?.get(factRecallId(fact)) || 0;
    const wordHits = minWordHits
      ? sharedWordCount(significantWords(`${fact.key} ${fact.text}`), messageWords)
      : 0;
    if (similarity >= MIN_FACT_SIMILARITY || (minWordHits && wordHits >= minWordHits)) {
      scored.push({ fact, similarity, wordHits });
    }
  }
  keyHits.sort((a, b) => b.key.length - a.key.length || newestFirst(a, b));
  scored.sort(
    (a, b) =>
      b.similarity - a.similarity || b.wordHits - a.wordHits || newestFirst(a.fact, b.fact),
  );
  pinned.sort(newestFirst);
  intents.sort((a, b) => b.similarity - a.similarity || b.wordHits - a.wordHits);
  return {
    pinned: pinned.slice(0, MAX_PINNED_FACTS),
    candidates: [...keyHits, ...scored.map((s) => s.fact)].slice(0, MAX_RECALL_CANDIDATES),
    intents: intents.slice(0, MAX_INTENTS_PER_TURN).map((s) => s.fact),
  };
}

function maxMatchedFacts(options) {
  return Math.max(
    1,
    Number(options.maxMatchedFacts || process.env.MANA_MEMORY_MAX_MATCHED_FACTS) || 5,
  );
}

// Pinned lines first: they are the same every turn, so the block's start
// stays stable (#660), and they survive the whole-line char cap first.
function factsBlockFor(pinned, matched) {
  const lines = [...pinned, ...matched].map(
    (fact) =>
      `- ${fact.key}: ${fact.text}${fact.status === "pending" ? " (unconfirmed -- check with the user before relying on it)" : ""}`,
  );
  return lines.length ? `Remembered:\n${lines.join("\n")}` : "";
}

// Issue #336: the record shape's own version, stamped on every new fact so
// a later shape change can migrate existing data instead of guessing at it.
// Facts written before this simply have no schemaVersion, and that absence
// is exactly what a migration needs in order to recognize them.
const FACT_SCHEMA_VERSION = 1;

// Issue #336: what kind of claim a fact is. Sits alongside unverifiedSource
// (#317) rather than replacing it -- "not traceable to anything the user
// said this turn" is a different statement from "this is an inference", and
// one does not imply the other. No migration: existing facts keep working
// with this field simply absent.
const EPISTEMIC_KINDS = ["fact", "self_report", "preference", "inferred"];

function normalizeEpistemic(value) {
  // An unrecognized value falls back to absent rather than throwing, the
  // same way an unrecognized `action` falls back to "insert" below.
  return EPISTEMIC_KINDS.includes(value) ? value : undefined;
}

// Issue #673: where a fact's current value came from. Set by the caller
// (server-side, never from model arguments):
//   user_stated    -- the user asked Mana to remember it this turn
//   model_inferred -- Mana saved it without being asked
//   tool_derived   -- a content-returning tool (browser, MCP, file read...)
//                     ran earlier in the turn, so the text may be the tool's
//   system         -- reflexes, admin/Settings actions
// Only user_stated/system writes land active and verified; the rest start
// pending (#663) and tool_derived is also unverified until confirmed.
const ORIGIN_KINDS = ["user_stated", "model_inferred", "tool_derived", "system"];
const EPISTEMIC_FOR_ORIGIN = {
  user_stated: "self_report",
  model_inferred: "inferred",
  tool_derived: "inferred",
};

function normalizeOrigin(origin, sessionId, at) {
  if (!origin || !ORIGIN_KINDS.includes(origin.kind)) return null;
  const tools = [
    ...new Set((Array.isArray(origin.tools) ? origin.tools : []).map((t) => cleanText(t, 80))),
  ]
    .filter(Boolean)
    .slice(0, 10);
  // turnAt: when the turn happened (the caller's), which for an approved
  // write can be well before it's applied (`at`).
  return {
    kind: origin.kind,
    sessionId: cleanText(sessionId || "default", 240),
    turnAt: cleanText(origin.turnAt, 40) || at,
    tools,
  };
}

// Issue #673: trust is derived, not stored -- a fact nobody confirmed is
// "tentative" (pending), one whose text isn't traceable to the user
// (attribution check, or tool-derived) is "untrusted". Facts written before
// #673 have neither, so they stay "trusted", as they are treated today.
function factTrust(fact) {
  if (fact.unverifiedSource) return "untrusted";
  if (fact.status === "pending") return "tentative";
  return "trusted";
}

// Issue #273 (Soul-of-Waifu-inspired self-healing memory): a deterministic,
// keyword-overlap check -- same technique skills-capability.js's
// findMatchingSkill() already uses, not a new LLM call -- for whether a
// new fact's key+text significantly overlaps an EXISTING active fact under
// a *different* key. Never auto-overwrites: a lexical heuristic has real
// false-positive risk (two facts sharing several words aren't necessarily
// contradictory), so this only surfaces a possible conflict for the model
// to judge and follow up on with an explicit patch, rather than risking
// silent data loss from an auto-merge.
const MIN_CONFLICT_WORD_HITS = 3;
function findConflictingFact(facts, key, text) {
  const words = significantWords(`${key} ${text}`);
  if (!words.length) return null;
  const lowerKey = key.toLowerCase();
  for (const fact of facts) {
    if (fact.status !== "active" || fact.key.toLowerCase() === lowerKey) continue;
    const factWords = significantWords(`${fact.key} ${fact.text}`);
    if (!factWords.length) continue;
    const hits = sharedWordCount(factWords, words);
    if (hits >= Math.min(MIN_CONFLICT_WORD_HITS, factWords.length)) return fact;
  }
  return null;
}

// Issue #431: the explicit counterpart to findConflictingFact's lexical
// guess -- the model names, by key, exactly which existing fact this new
// one replaces. Marks the old fact invalidatedAt rather than deleting or
// overwriting it, so its prior validity window stays queryable via
// getFactsValidAt. Silently a no-op if the named key doesn't match an
// active, not-already-invalidated fact (typo, stale key) -- same lenient
// "nothing to do" behavior remove/archive already use, and it must never
// let a fact invalidate itself (that's just an ordinary patch, handled
// above already).
function applySupersedes(facts, cleanKey, supersedes, timestamp) {
  const cleanSupersedes = cleanText(supersedes, 200);
  if (!cleanSupersedes || cleanSupersedes.toLowerCase() === cleanKey.toLowerCase()) {
    return null;
  }
  // #663: a pending fact can be superseded too.
  const target = facts.find(
    (f) =>
      isLiveFact(f) &&
      !f.invalidatedAt &&
      f.key.toLowerCase() === cleanSupersedes.toLowerCase(),
  );
  if (!target) {
    return { key: cleanSupersedes, found: false };
  }
  target.invalidatedAt = timestamp;
  return { key: cleanSupersedes, found: true };
}

function liveFactByKey(facts, key) {
  const lowerKey = String(key || "").toLowerCase();
  return facts.find((f) => isLiveFact(f) && f.key.toLowerCase() === lowerKey);
}

// Issue #663: what a memory-write approval pins -- the target fact as the
// model saw it when it asked (null: no live fact with that key yet).
// Pinning/unpinning isn't a change to what was reviewed, so it's left out.
function factVersion(fact) {
  if (!fact) return null;
  return crypto
    .createHash("sha1")
    .update(JSON.stringify([fact.id, fact.text, fact.status, fact.invalidatedAt || null, fact.updatedAt]))
    .digest("hex")
    .slice(0, 12);
}

function sessionFilename(sessionId) {
  return `${Buffer.from(String(sessionId || "default")).toString("base64url")}.json`;
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ACP memory session must contain a JSON object");
  }
  return parsed;
}

function writeJsonObject(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function createEmptySession(input, now) {
  const sessionId = cleanText(input.sessionId || "default", 240);
  return {
    sessionId,
    name: cleanText(input.name, 80) || null,
    cwd: cleanText(input.cwd, 1000),
    editor: cleanText(input.editor || "zed", 80),
    createdAt: now,
    updatedAt: now,
    summary: "",
    turns: [],
  };
}

function autoNameFromText(text) {
  const full = String(text || "").replace(/\s+/g, " ").trim();
  if (!full) {
    return "";
  }
  return full.length > 60 ? `${full.slice(0, 60)}…` : full;
}

function summarizeTurn(user, assistant, maxSummaryChars) {
  const userText = cleanText(user, 500);
  const assistantText = cleanText(assistant, 500);
  if (!userText && !assistantText) {
    return "";
  }

  return `- User: ${userText}${assistantText ? ` Assistant: ${assistantText}` : ""}`;
}

// Issue #78: lightweight cross-session entity tagging, zero LLM calls --
// matches runs of 1-3 Title Case words. Multi-word runs (e.g. "New York",
// "Acme Corp") are reliably real entities on their own; single-word matches
// are filtered against a short stopword list to cut down on sentence-initial
// capitalization noise ("The", "What", ...).
// ponytail: naive regex heuristic, not real NER -- upgrade if the
// false-positive rate on real usage becomes a problem.
const ENTITY_STOPWORDS = new Set([
  "i", "the", "a", "an", "this", "that", "these", "those", "we", "you",
  "he", "she", "it", "they", "what", "how", "why", "when", "where", "who",
  "is", "are", "can", "do", "does", "did", "will", "would", "should",
  "could", "please", "thanks", "ok", "okay", "yes", "no",
]);

function extractEntities(text) {
  const matches =
    String(text || "").match(/\b[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*){0,2}\b/g) ||
    [];
  const entities = new Set();
  for (const raw of matches) {
    const trimmed = raw.trim();
    const isSingleWord = !trimmed.includes(" ");
    if (isSingleWord && ENTITY_STOPWORDS.has(trimmed.toLowerCase())) continue;
    entities.add(trimmed);
  }
  return [...entities];
}

function createAcpMemoryStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.MANA_ACP_MEMORY_DIR ||
    path.join(__dirname, "data", "acp-memory");
  const sessionsDir = path.join(dataDir, "sessions");
  const entityIndexPath = path.join(dataDir, "entity-index.json");
  // Issue #432: kept as its own file rather than a new field on
  // entity-index.json's existing records -- those are bare mention arrays
  // ({sessionId, at, display}[]), read/written as arrays by
  // recordEntityMentions/lookupEntity/gatherRelatedFactsBlocks already;
  // changing that shape would touch every one of those call sites for no
  // reason when a second lookup-by-key file does the job additively.
  const entityTypesPath = path.join(dataDir, "entity-types.json");
  const factsPath = path.join(dataDir, "facts.json");
  const emotionalStatePath = path.join(dataDir, "emotional-state.json");
  // ponytail: fixed cap, not age-based pruning -- revisit if explicit
  // facts genuinely need trimming by more than "keep the most recent N".
  const maxFacts = 500;
  // #673: over the cap, drop the oldest *inactive* (stale/archived/
  // superseded) facts first and never an active one -- a plain
  // slice(-maxFacts) silently deleted the oldest active facts once the file
  // held 500 records of any status. ponytail: active facts alone can exceed
  // maxFacts (the cap becomes soft); add an archiving policy if that
  // ever happens in practice.
  function trimFacts(facts) {
    let excess = facts.length - maxFacts;
    if (excess <= 0) return facts;
    return facts.filter((fact) => {
      // Superseded facts keep status "active" but carry invalidatedAt
      // (applySupersedes), so they count as inactive here too. #663:
      // pending facts are live, kept like active ones.
      if (excess > 0 && (!isLiveFact(fact) || fact.invalidatedAt)) {
        excess -= 1;
        return false;
      }
      return true;
    });
  }
  // ponytail: fixed cap per entity, not age-based pruning -- revisit if a
  // heavily-recurring entity's mention list needs trimming by more than
  // "keep the most recent N".
  const maxMentionsPerEntity = 100;
  // #426 sub-project 1: optional -- most callers (tests, older wiring) don't
  // need snapshotting, so its absence is a silent no-op rather than a
  // required dependency threaded through every existing construction site.
  const snapshotStore = options.snapshotStore || null;

  if (snapshotStore) {
    snapshotStore.registerRestorer("memory-session", async (sessionId, session) => {
      // #475 review: back up the session as it stands right before a
      // restore overwrites it, so the restore itself is undoable -- same
      // reasoning as every other recordSnapshot call site in this file.
      const current = getSession(sessionId);
      if (current) {
        try {
          snapshotStore.recordSnapshot({
            kind: "memory-session",
            key: sessionId,
            payload: current,
            summary: `pre-restore backup: ${sessionId}`,
            source: "system",
          });
        } catch (e) {
          console.warn("pre-restore session backup failed:", e?.message || e);
        }
      }
      saveSession(session);
      return { sessionId };
    });

    snapshotStore.registerRestorer("memory-fact", async (key, snapshotPayload) => {
      const facts = loadFacts();
      const idx = facts.findIndex((f) => f.key === key);
      // #475 review: same pre-restore backup as memory-session above --
      // `existing` is exactly what's about to be lost (removed, or
      // overwritten) once this restore lands.
      const existing = idx === -1 ? null : facts[idx];
      try {
        snapshotStore.recordSnapshot({
          kind: "memory-fact",
          key,
          payload: existing ? JSON.parse(JSON.stringify(existing)) : null,
          summary: `pre-restore backup: ${key}`,
          source: "system",
        });
      } catch (e) {
        console.warn("pre-restore fact backup failed:", e?.message || e);
      }
      if (snapshotPayload === null) {
        // The fact didn't exist before this write -- restoring means removing it.
        if (idx !== -1) facts.splice(idx, 1);
      } else if (idx === -1) {
        facts.push(snapshotPayload);
      } else {
        facts[idx] = snapshotPayload;
      }
      saveFacts(facts, { op: "restore", key });
      return { key };
    });
  }
  const now = options.now || (() => new Date().toISOString());
  const maxRecentTurns = Math.max(1, Number(options.maxRecentTurns || 20));
  // Issue #338: the existing caps are size-based. They stop one unusually
  // large stretch from dominating the injected block, but nothing stops a
  // stale tail: a session picked back up after a fortnight would still
  // inject its last turns as though they were the live thread. This bounds
  // them by age as well as by count. Nothing is lost, only un-preloaded --
  // older turns stay reachable through searchSessions(). Set to 0 to
  // disable the window and keep the previous count-only behavior.
  const maxRecentTurnAgeMs = Math.max(
    0,
    Number(
      options.maxRecentTurnAgeMs ||
        process.env.MANA_RECENT_TURN_MAX_AGE_MS ||
        2 * 24 * 60 * 60 * 1000,
    ),
  );
  // Issue #385: how many of the newest turns survive the age window
  // regardless. Deliberately 1 -- the point is "where were we", not
  // replaying a session. 0 restores #338's pure age-window behavior.
  const minRecentTurns = Math.max(
    0,
    Number(
      options.minRecentTurns === undefined
        ? process.env.MANA_MIN_RECENT_TURNS || 1
        : options.minRecentTurns,
    ),
  );
  const maxSummaryChars = Math.max(
    100,
    Number(options.maxSummaryChars || 4000),
  );
  const maxPromptChars = Math.max(100, Number(options.maxPromptChars || 2000));
  // Token-aware defaults
  const tokenEstimator =
    typeof options.tokenEstimator === "function"
      ? options.tokenEstimator
      : (text) => Math.max(1, Math.ceil((String(text || "").length || 0) / 4));
  const maxSummaryTokens = Math.max(
    16,
    Number(options.maxSummaryTokens || Math.floor(maxSummaryChars / 4)),
  );
  const maxPromptTokens = Math.max(
    16,
    Number(options.maxPromptTokens || Math.floor(maxPromptChars / 4)),
  );
  const summarizeFn =
    typeof options.summarizeFn === "function" ? options.summarizeFn : null;
  // Optional (full-text session search): indexes every turn's raw text so
  // past conversations are searchable by keyword, independent of the
  // curated summary above. Not constructed here -- server.js wires the real
  // one in, tests simply omit it, same pattern as summarizeFn.
  const sessionSearchIndex = options.sessionSearchIndex || null;
  // Optional (issue #263 part 1: hybrid keyword+vector session search).
  // Same shape as tools/retriever-index.js's computeEmbeddings: an async
  // (texts: string[]) => Promise<(number[]|null)[]>. Injected rather than
  // required directly so this module stays free of the embedder's own
  // network-calling code -- server.js wires the real one in, tests omit it
  // (or inject a fake), same pattern as summarizeFn/sessionSearchIndex.
  const computeEmbeddingsFn =
    typeof options.computeEmbeddingsFn === "function" ? options.computeEmbeddingsFn : null;
  // Names the model behind computeEmbeddingsFn (retriever-index.js's
  // embeddingModelId), so cached fact vectors from another model are
  // re-embedded rather than compared with this one's.
  const embeddingModelIdFn =
    typeof options.embeddingModelIdFn === "function" ? options.embeddingModelIdFn : () => "";
  // Optional (issue #295, round-2 scoping of #285): the Hebbian associative
  // graph over entity keys. Same injection convention as
  // sessionSearchIndex/computeEmbeddingsFn -- server.js wires the real one
  // in, tests omit it (or inject a fake).
  const memoryGraph = options.memoryGraph || null;
  // Optional (issue #674): ai/reranker-runtime.js's rerank(query, docs) ->
  // {order, reranked, ms, fallback}; never throws, returns input order on
  // failure. Same injection convention as computeEmbeddingsFn.
  const rerankFn = typeof options.rerankFn === "function" ? options.rerankFn : null;

  ensureDir(sessionsDir);

  function filePathForSession(sessionId) {
    return path.join(sessionsDir, sessionFilename(sessionId));
  }

  function loadEntityIndex() {
    return readJsonObject(entityIndexPath) || {};
  }

  function recordEntityMentions(entities, sessionId, at) {
    if (!entities.length) return;
    const index = loadEntityIndex();
    for (const entity of entities) {
      const key = entity.toLowerCase();
      const mentions = index[key] || [];
      mentions.push({ sessionId, at, display: entity });
      index[key] = mentions.slice(-maxMentionsPerEntity);
    }
    writeJsonObject(entityIndexPath, index);
  }

  // Given a name/topic, returns which sessions mentioned it -- e.g. for a
  // future "what did we say about X" lookup that reaches beyond the
  // current session's own summary.
  function lookupEntity(name) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) return [];
    return loadEntityIndex()[key] || [];
  }

  function loadEntityTypes() {
    return readJsonObject(entityTypesPath) || {};
  }

  function saveEntityTypes(types) {
    writeJsonObject(entityTypesPath, types);
  }

  function displayForEntityKey(index, key) {
    const mentions = index[key];
    return mentions && mentions.length ? mentions[mentions.length - 1].display : key;
  }

  // Issue #432: entities with real mentions but no type entry yet -- the
  // background typing pass's own input. Capped by the caller (the batch-
  // size vote settled on 25 -- see the background job, not this store);
  // this just returns candidates in whatever order Object.keys gives, up
  // to `limit`.
  function listUntypedEntities(limit) {
    const index = loadEntityIndex();
    const types = loadEntityTypes();
    const untyped = [];
    for (const key of Object.keys(index)) {
      if (types[key]) continue;
      untyped.push({ key, display: displayForEntityKey(index, key) });
      if (untyped.length >= limit) break;
    }
    return untyped;
  }

  // Sets an entity's ontology type/subcategory. subcategory is open/free-
  // form and display-only -- it's never consulted for merge-matching (see
  // entity-ontology.js's own header comment on why keeping it unvalidated
  // is the deliberate choice, not an oversight). Returns false if the key
  // has no recorded mentions at all (nothing to type).
  function setEntityType(key, type, subcategory) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    if (!normalizedKey) return false;
    const index = loadEntityIndex();
    if (!index[normalizedKey]) return false;
    const types = loadEntityTypes();
    types[normalizedKey] = {
      type,
      ...(subcategory ? { subcategory: cleanText(subcategory, 60) } : {}),
      typedAt: now(),
    };
    saveEntityTypes(types);
    return true;
  }

  // The merge-candidate pool for a given type -- existing canonical
  // (non-alias) entities already typed as `type`. "not_an_entity" is never
  // queried this way; it has nothing to merge into.
  function listCanonicalEntitiesOfType(type) {
    const types = loadEntityTypes();
    const index = loadEntityIndex();
    const result = [];
    for (const [key, meta] of Object.entries(types)) {
      if (meta.type !== type || meta.canonicalKey) continue;
      result.push({ key, display: displayForEntityKey(index, key), subcategory: meta.subcategory || null });
    }
    return result;
  }

  // Issue #432: non-destructive merge -- `key`'s own mentions/type/history
  // are untouched, this only adds a pointer reads can resolve through.
  // Never points a key at itself. Returns false if `key` has no type entry
  // yet (setEntityType must run first) or the canonical key is invalid.
  function setCanonicalAlias(key, canonicalKey) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    const normalizedCanonical = String(canonicalKey || "").trim().toLowerCase();
    if (!normalizedKey || !normalizedCanonical || normalizedKey === normalizedCanonical) {
      return false;
    }
    const types = loadEntityTypes();
    if (!types[normalizedKey]) return false;
    types[normalizedKey].canonicalKey = normalizedCanonical;
    saveEntityTypes(types);
    return true;
  }

  // Resolves a key through its alias pointer (if any) -- everything about
  // this entity should be considered under whatever this returns.
  function resolveCanonicalKey(key) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    const types = loadEntityTypes();
    return types[normalizedKey]?.canonicalKey || normalizedKey;
  }

  // Issue #641: display text + ontology type (null while untyped) for a
  // batch of entity keys -- one read of each file for the memory-graph
  // view, not one per node.
  function describeEntities(keys) {
    const index = loadEntityIndex();
    const types = loadEntityTypes();
    return keys.map((key) => ({
      key,
      display: displayForEntityKey(index, key),
      type: types[key]?.type || null,
    }));
  }

  // Issue #198: explicit facts the model itself chose to persist via the
  // hot-path "remember" tool -- distinct from the passive entity-mention
  // index above, which only ever records "X was mentioned somewhere", never
  // a specific asserted fact, and never updates/removes a prior entry.
  // Stored as {facts: [...]} (not a bare array) so readJsonObject's
  // object-only guard doesn't reject it.
  function loadFacts() {
    const parsed = readJsonObject(factsPath);
    return Array.isArray(parsed?.facts) ? parsed.facts : [];
  }

  // Issue #264: a cheap index (key + a short text preview, no full detail)
  // of every active fact -- lets a caller (memory-tool-source.js's
  // remember-tool description) show the model what's already remembered,
  // so it can reuse an existing key instead of always inserting a fresh
  // one for a rephrased version of the same fact.
  function listFactKeys() {
    return loadFacts()
      .filter((f) => isLiveFact(f) && !f.invalidatedAt)
      .map((f) => ({
        key: f.key,
        preview: cleanText(f.text, 80),
        ...(f.status === "pending" ? { pending: true } : {}),
        ...(f.trigger ? { trigger: cleanText(f.trigger, 80) } : {}),
      }));
  }

  // Issue #663: the version an approval request pins (see factVersion).
  function getFactVersion(key) {
    return factVersion(liveFactByKey(loadFacts(), cleanText(key, 200)));
  }

  // Issue #324: full-detail listing (every status, every field including
  // unverifiedSource) for the Settings "Memory" browser -- distinct from
  // listFactKeys above, which deliberately strips detail down to what the
  // model's own tool description needs.
  function listFacts() {
    return loadFacts();
  }

  // Issue #673: append-only history of every fact change, beside
  // facts.json. saveFacts diffs what it's about to write against what's on
  // disk and logs one {at, op, key, before, after, origin} line per changed
  // record, so side effects -- the other fact applySupersedes invalidates,
  // records the 500 cap drops -- are logged without each caller having to.
  // ponytail: grows without bound (a few KB per change); rotate it if it
  // ever gets big enough to matter.
  const factsLogPath = path.join(dataDir, "facts-log.jsonl");

  // Facts from before ids existed fall back to key + creation time.
  function factIdentity(fact) {
    return fact.id || `key:${fact.key}:${fact.createdAt || ""}`;
  }

  // change: {op, key, origin} -- op/origin describe the write to `key`;
  // another record that changed in the same save is logged as "invalidate"
  // (superseded) or with the same op, and one that disappeared as "drop".
  function saveFacts(facts, change = {}) {
    const op = change.op || "update";
    const lowerKey = change.key ? String(change.key).toLowerCase() : null;
    const before = new Map(loadFacts().map((f) => [factIdentity(f), f]));
    writeJsonObject(factsPath, { facts });
    const at = now();
    const isTarget = (fact) => !lowerKey || String(fact.key).toLowerCase() === lowerKey;
    const entries = [];
    for (const fact of facts) {
      const id = factIdentity(fact);
      const prev = before.get(id) || null;
      before.delete(id);
      if (prev && JSON.stringify(prev) === JSON.stringify(fact)) continue;
      const target = isTarget(fact);
      entries.push({
        at,
        op: target || !fact.invalidatedAt || prev?.invalidatedAt ? op : "invalidate",
        key: fact.key,
        before: prev,
        after: fact,
        ...(target && change.origin ? { origin: change.origin } : {}),
      });
    }
    for (const gone of before.values()) {
      entries.push({ at, op: isTarget(gone) ? op : "drop", key: gone.key, before: gone, after: null });
    }
    if (!entries.length) return;
    try {
      fs.appendFileSync(factsLogPath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
    } catch (e) {
      console.warn("Fact history log append failed:", e?.message || e);
    }
  }

  // Issue #673: every logged change to one key, oldest first -- the diff
  // (before/after) and blame (origin) behind GET
  // /admin/memory/facts/:key/history. Rolling back reuses the memory-fact
  // snapshot restorer and its approval.
  function getFactHistory(key) {
    const lowerKey = cleanText(key, 200).toLowerCase();
    if (!lowerKey || !fs.existsSync(factsLogPath)) return [];
    const entries = [];
    for (const line of fs.readFileSync(factsLogPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (String(entry.key).toLowerCase() === lowerKey) entries.push(entry);
      } catch (e) {
        // A torn last line from a crash mid-append; skip it.
      }
    }
    return entries;
  }

  function snapshotFact(key, fact, summary, source) {
    if (!snapshotStore) return;
    try {
      // Deep-cloned: `fact` is a live reference into the loaded array, and
      // callers mutate it in place (existing.history.push(...) mutates the
      // same array existing.history already pointed at) right after this --
      // a shallow copy would be corrupted by then.
      snapshotStore.recordSnapshot({
        kind: "memory-fact",
        key,
        payload: fact ? JSON.parse(JSON.stringify(fact)) : null,
        summary,
        source,
      });
    } catch (e) {
      console.warn("Fact snapshot failed:", e?.message || e);
    }
  }

  // action: "insert" (default) and "patch" both update the live fact with
  // this key if one exists, otherwise create it (#673: insert used to add a
  // duplicate); the result's `decision` says which ("add" / "update" /
  // "none" for an identical restatement). "remove" marks an existing
  // active fact as stale (soft delete -- preserves history, matches this
  // store's general append-safe philosophy elsewhere) and is a no-op if
  // nothing with that key exists. "archive" (issue #277) marks a fact
  // still-true-but-no-longer-worth-automatically-surfacing: distinct from
  // "stale" (no longer true) -- an archived fact is excluded from
  // getRelatedFacts' automatic key-match surfacing and listFactKeys' tool
  // description, but never deleted.
  const MAX_FACT_HISTORY = 5;
  // unverifiedSource (issue #317): set by the caller (memory-tool-source.js's
  // speaker-attribution guard) when the proposed text doesn't look
  // traceable to anything the user actually said this turn. Stored as its
  // own flag, orthogonal to `status` -- a fact can be freshly-inserted,
  // active, AND unverified all at once. Excluded from gatherRelatedFactsBlocks'
  // automatic surfacing below (same treatment as an archived fact), but NOT
  // from listFactKeys -- the model still needs to see it exists so a later
  // correction patches this key instead of creating a duplicate.
  function rememberFact({
    sessionId,
    key,
    text,
    action,
    unverifiedSource,
    epistemic,
    occurredAt,
    supersedes,
    source,
    origin,
    expectedVersions,
    trigger,
    triggerUserWords,
    expiresAt,
  } = {}) {
    const cleanKey = cleanText(key, 200);
    if (!cleanKey) {
      throw new Error("key is required");
    }
    const normalizedAction = ["insert", "patch", "remove", "archive", "confirm"].includes(action)
      ? action
      : "insert";
    const facts = loadFacts();
    const existing = liveFactByKey(facts, cleanKey);
    const timestamp = now();

    // Issue #663: an approved write applies only to the facts the approver
    // reviewed. expectedVersions ([{key, version}], from getFactVersion at
    // request time) is checked in the same synchronous call that writes, so
    // nothing can change in between. Refused before the snapshot: nothing
    // is written at all.
    if (Array.isArray(expectedVersions)) {
      const changed = expectedVersions
        .filter(
          (e) => factVersion(liveFactByKey(facts, cleanText(e?.key, 200))) !== (e?.version ?? null),
        )
        .map((e) => e?.key);
      if (changed.length) {
        return {
          ok: false,
          action: normalizedAction,
          key: cleanKey,
          refused: "changed",
          changed,
          error: `Not applied: ${changed.map((k) => `"${k}"`).join(", ")} changed after this was requested, so nothing was overwritten.`,
        };
      }
    }

    // Issue #673: absent origin (older callers) behaves exactly as before:
    // active, and no origin recorded.
    const cleanOrigin = normalizeOrigin(origin, sessionId, timestamp);
    const kind = cleanOrigin?.kind;
    const snapshot = () =>
      snapshotFact(cleanKey, existing, `fact ${normalizedAction}: ${cleanKey}`, source || "agent");

    // Issue #663: pending -> active. #673: confirming is the user vouching
    // for the fact, so it also clears unverifiedSource.
    if (normalizedAction === "confirm") {
      if (!existing || factTrust(existing) === "trusted") {
        return { ok: true, action: "confirm", decision: "none", key: cleanKey, found: Boolean(existing) };
      }
      snapshot();
      existing.status = "active";
      delete existing.unverifiedSource;
      existing.confirmedAt = timestamp;
      existing.updatedAt = timestamp;
      saveFacts(facts, { op: "confirm", key: cleanKey, origin: cleanOrigin });
      return { ok: true, action: "confirm", decision: "confirm", key: cleanKey, found: true };
    }

    if (normalizedAction === "remove" || normalizedAction === "archive") {
      if (!existing) {
        return { ok: true, action: normalizedAction, decision: "none", key: cleanKey, found: false };
      }
      snapshot();
      existing.status = normalizedAction === "remove" ? "stale" : "archived";
      existing.updatedAt = timestamp;
      saveFacts(facts, { op: normalizedAction === "remove" ? "delete" : "archive", key: cleanKey, origin: cleanOrigin });
      return {
        ok: true,
        action: normalizedAction,
        decision: normalizedAction === "remove" ? "delete" : "archive",
        key: cleanKey,
        found: true,
      };
    }

    const cleanTextValue = cleanText(redactSensitive(text), 500);
    if (!cleanTextValue) {
      throw new Error("text is required for insert/patch");
    }

    // Issue #336: epistemic is what kind of claim this is. #673 fills it
    // from origin when the caller doesn't say.
    const normalizedEpistemic = normalizeEpistemic(epistemic) || EPISTEMIC_FOR_ORIGIN[kind];
    // Issue #336: when the event happened, as opposed to createdAt/updatedAt
    // which record when Mana was told. "I moved house in March" is a fact
    // recorded today about something months old.
    const cleanOccurredAt = cleanText(occurredAt, 40);
    // Issue #673: tool-derived text is never trusted on its own, whatever
    // the attribution check said; model-inferred and tool-derived values
    // start pending (#663) until the user confirms them.
    const unverified = Boolean(unverifiedSource) || kind === "tool_derived";
    const nextStatus = kind === "model_inferred" || kind === "tool_derived" ? "pending" : "active";
    // Issue #698: makes this fact a standing intent (see intentCanFire).
    // Like epistemic, only written when supplied, never cleared by omission.
    const cleanTrigger = cleanText(trigger, 200);
    const cleanTriggerUserWords = cleanText(triggerUserWords, 200);
    const cleanExpiresAt = cleanText(expiresAt, 40);

    // Issue #673: the write decision. "insert" on a key that already has a
    // live fact updates that fact instead of adding a second one with the
    // same key (#264's key reuse, enforced instead of only asked for).
    if (existing) {
      // Restating the same text is "none" -- no write, no snapshot -- unless
      // it upgrades the fact (the user confirming a pending or unverified
      // one). A lower-trust restatement never downgrades it.
      const sameText = existing.text === cleanTextValue;
      const upgrades =
        (existing.status === "pending" && nextStatus === "active") ||
        (existing.unverifiedSource && !unverified);
      const intentChanged =
        (cleanTrigger && cleanTrigger !== existing.trigger) ||
        (cleanTriggerUserWords && cleanTriggerUserWords !== existing.triggerUserWords) ||
        (cleanExpiresAt && cleanExpiresAt !== existing.expiresAt);
      if (sameText && !supersedes && !upgrades && !intentChanged) {
        return { ok: true, action: "patch", decision: "none", key: cleanKey, text: cleanTextValue };
      }
      snapshot();
      if (!sameText) {
        // Issue #273: keep a bounded correction history instead of silently
        // discarding the prior value -- "what did I used to think was true"
        // stays inspectable, matching the self-healing-memory pattern this
        // issue is built around.
        // Issue #431: each history entry carries its own validity window
        // (when that text became the active value, when it stopped being)
        // instead of a bare updatedAt, so "what did I believe was true on
        // date X" is answerable from history entries too, not just the
        // current value. #673: and where that value came from.
        const history = Array.isArray(existing.history) ? existing.history : [];
        history.push({
          text: existing.text,
          validFrom: existing.validFrom || existing.createdAt,
          invalidatedAt: timestamp,
          ...(existing.origin ? { origin: existing.origin } : {}),
        });
        existing.history = history.slice(-MAX_FACT_HISTORY);
        existing.text = cleanTextValue;
        existing.validFrom = timestamp;
        // A new value hasn't been confirmed by anyone yet.
        delete existing.confirmedAt;
      }
      existing.updatedAt = timestamp;
      // An identical restatement only ever upgrades (see above).
      if (!sameText || nextStatus === "active") existing.status = nextStatus;
      if (unverified && !sameText) {
        existing.unverifiedSource = true;
      } else if (!unverified) {
        delete existing.unverifiedSource;
      }
      if (cleanOrigin) existing.origin = cleanOrigin;
      // Issue #336: unlike unverifiedSource above, these are only written
      // when supplied and are never cleared by omission. unverifiedSource
      // describes *this* write, so a clean re-statement should drop it;
      // what kind of claim a fact is, and when it happened, do not stop
      // being true because a later correction did not restate them.
      if (normalizedEpistemic) existing.epistemic = normalizedEpistemic;
      if (cleanOccurredAt) existing.occurredAt = cleanOccurredAt;
      // A new trigger without new user words drops the old words, so the
      // reminder never keeps firing on the topic it moved away from.
      if (cleanTrigger && cleanTrigger !== existing.trigger && !cleanTriggerUserWords) {
        delete existing.triggerUserWords;
      }
      if (cleanTrigger) existing.trigger = cleanTrigger;
      if (cleanTriggerUserWords) existing.triggerUserWords = cleanTriggerUserWords;
      if (cleanExpiresAt) existing.expiresAt = cleanExpiresAt;
      const supersededPatch = applySupersedes(facts, cleanKey, supersedes, timestamp);
      saveFacts(facts, { op: "update", key: cleanKey, origin: cleanOrigin });
      return {
        ok: true,
        action: "patch",
        decision: "update",
        key: cleanKey,
        text: cleanTextValue,
        ...(existing.status === "pending" ? { pending: true } : {}),
        ...(existing.unverifiedSource ? { unverifiedSource: true } : {}),
        ...(supersededPatch ? { superseded: supersededPatch } : {}),
      };
    }

    snapshot();
    const conflict = findConflictingFact(facts, cleanKey, cleanTextValue);
    facts.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      key: cleanKey,
      text: cleanTextValue,
      sessionId: cleanText(sessionId || "default", 240),
      status: nextStatus,
      validFrom: timestamp,
      schemaVersion: FACT_SCHEMA_VERSION,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(unverified ? { unverifiedSource: true } : {}),
      ...(normalizedEpistemic ? { epistemic: normalizedEpistemic } : {}),
      ...(cleanOccurredAt ? { occurredAt: cleanOccurredAt } : {}),
      ...(cleanOrigin ? { origin: cleanOrigin } : {}),
      ...(cleanTrigger ? { trigger: cleanTrigger } : {}),
      ...(cleanTrigger && cleanTriggerUserWords ? { triggerUserWords: cleanTriggerUserWords } : {}),
      ...(cleanExpiresAt ? { expiresAt: cleanExpiresAt } : {}),
    });
    const supersededInsert = applySupersedes(facts, cleanKey, supersedes, timestamp);
    saveFacts(trimFacts(facts), { op: "add", key: cleanKey, origin: cleanOrigin });
    return {
      ok: true,
      action: "insert",
      decision: "add",
      key: cleanKey,
      text: cleanTextValue,
      ...(nextStatus === "pending" ? { pending: true } : {}),
      ...(unverified ? { unverifiedSource: true } : {}),
      ...(conflict
        ? { possibleConflict: { key: conflict.key, preview: cleanText(conflict.text, 80) } }
        : {}),
      ...(supersededInsert ? { superseded: supersededInsert } : {}),
    };
  }

  // Issue #431: a standalone invalidation, for callers judging a conflict
  // *after* rememberFact already returned (memory-tool-source.js's
  // LLM-confirmed auto-invalidation) -- applySupersedes only runs inline
  // during a single rememberFact call, this is the same lookup/mutation as
  // its own operation.
  function invalidateFactByKey(key) {
    const cleanTargetKey = cleanText(key, 200);
    if (!cleanTargetKey) return { key: cleanTargetKey, found: false };
    const facts = loadFacts();
    const target = facts.find(
      (f) =>
        f.status === "active" &&
        !f.invalidatedAt &&
        f.key.toLowerCase() === cleanTargetKey.toLowerCase(),
    );
    if (!target) return { key: cleanTargetKey, found: false };
    target.invalidatedAt = now();
    saveFacts(facts, { op: "invalidate", key: cleanTargetKey });
    return { key: cleanTargetKey, found: true };
  }

  // Issue #663: pending facts nobody confirmed within maxAgeDays of being
  // picked up are archived, not deleted. Run from Dream Mode (server.js).
  function archiveExpiredPendingFacts({ maxAgeDays = 14 } = {}) {
    const cutoff = new Date(Date.parse(now()) - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const facts = loadFacts();
    const expired = facts.filter(
      (f) => f.status === "pending" && String(f.createdAt || f.updatedAt || "") < cutoff,
    );
    if (!expired.length) return { archived: [] };
    const timestamp = now();
    for (const fact of expired) {
      snapshotFact(fact.key, fact, `pending fact expired: ${fact.key}`, "system");
      fact.status = "archived";
      fact.updatedAt = timestamp;
    }
    saveFacts(facts, { op: "expire" });
    return { archived: expired.map((f) => f.key) };
  }

  // Issue #674: user-set "always relevant" flag (name, pronouns, current
  // project) -- a pinned fact is injected every turn, up to
  // MAX_PINNED_FACTS, whether or not the message mentions it. Only the
  // Settings UI sets it; the model's memory tool has no pin action.
  // Issue #698: Settings' pause/resume for a standing intent reuses the
  // same flag toggle ("paused" instead of "pinned").
  function setFactFlag(key, flag, on, ops) {
    const cleanTargetKey = cleanText(key, 200);
    const facts = loadFacts();
    const target = facts.find(
      (f) => f.status === "active" && f.key.toLowerCase() === cleanTargetKey.toLowerCase(),
    );
    if (!cleanTargetKey || !target) return { key: cleanTargetKey, found: false };
    if (on) {
      target[flag] = true;
    } else {
      delete target[flag];
    }
    saveFacts(facts, { op: on ? ops[0] : ops[1], key: cleanTargetKey });
    return { key: cleanTargetKey, found: true, [flag]: Boolean(on) };
  }

  function setFactPinned(key, pinned) {
    return setFactFlag(key, "pinned", pinned, ["pin", "unpin"]);
  }

  function setFactPaused(key, paused) {
    return setFactFlag(key, "paused", paused, ["pause", "resume"]);
  }

  // Issue #698: starts each fired intent's cooldown. Re-reads the store so
  // a write made while this turn awaited the embedder isn't overwritten.
  function markIntentsFired(ids) {
    if (!ids.length) return;
    const facts = loadFacts();
    const at = now();
    const fired = facts.filter((f) => ids.includes(factRecallId(f)));
    if (!fired.length) return;
    for (const fact of fired) fact.lastFiredAt = at;
    saveFacts(facts, { op: "fire" });
  }

  // Issue #431: the point-in-time query the whole feature is for -- "what
  // did I believe was true on date X". Deliberately ignores status
  // (stale/archived) -- see acp-memory-store's own header comment on
  // applySupersedes -- a fact removed/archived later was still genuinely
  // believed true before that happened; only validFrom/invalidatedAt speak
  // to whether a given value was the active claim as of asOf.
  function windowCovers(validFrom, invalidatedAt, cutoff) {
    return Boolean(validFrom) && validFrom <= cutoff && (!invalidatedAt || invalidatedAt > cutoff);
  }

  function getFactsValidAt(asOf) {
    const cutoff = cleanText(asOf, 40);
    if (!cutoff) return [];
    const results = [];
    for (const fact of loadFacts()) {
      if (windowCovers(fact.validFrom || fact.createdAt, fact.invalidatedAt, cutoff)) {
        results.push(fact);
        continue;
      }
      // The current value's own window doesn't cover asOf -- e.g. it was
      // patched again since, or hadn't been patched to its current text
      // yet -- but an earlier correction's own window (recorded in
      // history) might. Return the fact as it stood then: its shape, with
      // the historical text/window overlaid.
      const history = Array.isArray(fact.history) ? fact.history : [];
      const pastVersion = history.find((h) => windowCovers(h.validFrom, h.invalidatedAt, cutoff));
      if (pastVersion) {
        results.push({ ...fact, text: pastVersion.text, validFrom: pastVersion.validFrom, invalidatedAt: pastVersion.invalidatedAt });
      }
    }
    return results;
  }

  // Issue #141: the "searchable, on-demand" half of the two-tier memory
  // split -- buildPromptMemory() above is the small always-injected tier
  // (hard-capped by maxPromptTokens); this is the much larger archive
  // (every entity ever mentioned, across every session, plus explicit
  // remembered facts) pulled in only when the current message actually
  // names something from it. Entity mentions are a plain index lookup
  // rather than real full-text search -- cheap, deterministic, and reuses
  // the index appendTurn() already maintains; explicit facts match by
  // direct key substring rather than the Title-Case entity heuristic,
  // since a fact's key ("the user's GPU") isn't necessarily Title Case.
  // Shared by getRelatedFacts (string, unchanged) and getRelatedFactsEntries
  // (issue #282, structured) -- gathers the mentions block and the fact
  // candidates (#674: pinned + up to MAX_RECALL_CANDIDATES matches) that
  // either caller then budgets/formats/caps its own way.
  function gatherRelatedFactsBlocks(text, options = {}) {
    const excludeSessionId = options.excludeSessionId;
    const maxEntities = Math.max(
      1,
      Number(
        options.maxEntities || process.env.MANA_RELATED_FACTS_MAX_ENTITIES || 3,
      ),
    );

    const entities = extractEntities(text).slice(0, maxEntities);
    const index = loadEntityIndex();
    const mentionLines = [];
    for (const entity of entities) {
      const mentions = (index[entity.toLowerCase()] || []).filter(
        (m) => m.sessionId !== excludeSessionId,
      );
      if (!mentions.length) continue;
      const last = mentions[mentions.length - 1];
      mentionLines.push(
        `- ${entity}: previously discussed in another session (${last.at})`,
      );
    }

    // Issue #364: candidates are ordered before the caller truncates (see
    // factRecallCandidates) -- unsorted, the facts that survive a tight
    // budget are just whichever happened to be stored first.
    const { pinned, candidates, intents } = factRecallCandidates(
      options.facts || loadFacts(),
      text,
      options.similarityById,
      Date.parse(now()),
    );

    return {
      mentionsBlock: mentionLines.length
        ? `Related from other sessions:\n${mentionLines.join("\n")}`
        : "",
      pinned,
      candidates,
      intents,
    };
  }

  // Issue #674: fact-text embeddings for recall by meaning. Held in memory
  // after the first read and persisted beside facts.json so a restart does
  // not re-embed every fact. Keyed by fact id; the stored hash of the
  // embedded text makes a patched fact's old vector a cache miss.
  const factEmbeddingsPath = path.join(dataDir, "fact-embeddings.json");
  let factEmbeddings = null;
  let factEmbeddingBackfill = null;
  // ponytail: fixed batch per backfill; the rest fill in on later turns.
  const FACT_EMBEDDING_BATCH = 32;
  // After a timeout/error, skip the embedder for a minute: on Windows a
  // connect to a closed localhost port retries for ~2s, which would
  // otherwise cost every turn the full timeout.
  const EMBEDDING_RETRY_AFTER_MS = 60 * 1000;
  let embeddingsDownUntil = 0;

  // #698: an intent is matched on what it's about, not what it says.
  function factEmbeddingText(fact) {
    return fact.trigger || `${fact.key}: ${fact.text}`;
  }

  function factEmbeddingHash(fact) {
    return crypto.createHash("sha1").update(factEmbeddingText(fact)).digest("hex");
  }

  function loadFactEmbeddings() {
    if (!factEmbeddings) {
      try {
        factEmbeddings = readJsonObject(factEmbeddingsPath)?.embeddings || {};
      } catch (e) {
        // A corrupt cache is only a cache -- start over and re-embed.
        factEmbeddings = {};
      }
    }
    return factEmbeddings;
  }

  // A cached vector counts only if its text is unchanged and it came from
  // the current embedding model (entries without `model` were written by
  // the RETRIEVER_EMBEDDER_URL service, id ""). The length check still
  // catches a model swapped behind that URL.
  function cachedFactVector(fact, dims, model) {
    const cached = loadFactEmbeddings()[factRecallId(fact)];
    return cached &&
      cached.hash === factEmbeddingHash(fact) &&
      (cached.model || "") === model &&
      cached.vector?.length === dims
      ? cached.vector
      : null;
  }

  // Runs in the background, never awaited by a reply: embedding a whole
  // fact store on CPU would blow the per-turn budget, so this turn uses
  // whatever vectors are already cached and later turns pick up the rest.
  function backfillFactEmbeddings(facts, dims, model) {
    if (factEmbeddingBackfill) return;
    const cache = loadFactEmbeddings();
    const missing = facts
      .filter((fact) => !cachedFactVector(fact, dims, model))
      .slice(0, FACT_EMBEDDING_BATCH);
    if (!missing.length) return;
    factEmbeddingBackfill = (async () => {
      try {
        const vectors = await computeEmbeddingsFn(missing.map(factEmbeddingText));
        missing.forEach((fact, i) => {
          if (Array.isArray(vectors?.[i]) && vectors[i].length) {
            cache[factRecallId(fact)] = {
              hash: factEmbeddingHash(fact),
              vector: vectors[i],
              ...(model ? { model } : {}),
            };
          }
        });
        // Drop vectors for facts trimmed out of facts.json since.
        const live = new Set(withUserWordsVariants(loadFacts()).map(factRecallId));
        for (const id of Object.keys(cache)) if (!live.has(id)) delete cache[id];
        writeJsonObject(factEmbeddingsPath, { embeddings: cache });
      } catch (e) {
        console.warn("Fact embedding backfill failed:", e?.message || e);
      } finally {
        factEmbeddingBackfill = null;
      }
    })();
  }

  // Issue #674: the message is embedded once per turn, bounded by
  // MANA_MEMORY_RECALL_TIMEOUT_MS. Any failure returns null and recall
  // carries on with key + keyword candidates; `recall.fallback` says why.
  async function factSimilarities(text, facts, recall) {
    if (!computeEmbeddingsFn) {
      recall.fallback = "embeddings not wired";
      return null;
    }
    if (Date.now() < embeddingsDownUntil) {
      recall.fallback = "embeddings skipped after a recent failure";
      return null;
    }
    const timeoutMs = Number(process.env.MANA_MEMORY_RECALL_TIMEOUT_MS) || 1000;
    let timer = null;
    try {
      const [queryVector] = await Promise.race([
        computeEmbeddingsFn([String(text || "")], { query: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      // computeEmbeddings returns nulls when USE_EMBEDDINGS is off or the
      // embedder is unreachable -- the normal "no vectors" case, not logged.
      if (!Array.isArray(queryVector) || !queryVector.length) {
        recall.fallback = "embeddings unavailable";
        return null;
      }
      const model = embeddingModelIdFn();
      backfillFactEmbeddings(facts, queryVector.length, model);
      const scores = new Map();
      for (const fact of facts) {
        const vector = cachedFactVector(fact, queryVector.length, model);
        if (vector) scores.set(factRecallId(fact), cosine(queryVector, vector));
      }
      return scores;
    } catch (e) {
      embeddingsDownUntil = Date.now() + EMBEDDING_RETRY_AFTER_MS;
      recall.fallback = `embeddings failed: ${e?.message || e}`;
      console.warn("Fact recall falling back to keyword match:", recall.fallback);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function getRelatedFacts(text, options = {}) {
    const maxChars = Math.max(
      50,
      Number(
        options.maxChars || process.env.MANA_RELATED_FACTS_MAX_CHARS || 300,
      ),
    );
    const { mentionsBlock, pinned, candidates } = gatherRelatedFactsBlocks(text, options);
    const factsBlock = factsBlockFor(pinned, candidates.slice(0, maxMatchedFacts(options)));
    const blocks = [mentionsBlock, factsBlock].filter(Boolean);
    if (!blocks.length) return "";

    const block = blocks.join("\n\n");
    return truncateWholeLines(block, maxChars);
  }

  // Issue #282: structured form of getRelatedFacts -- mentions and facts as
  // two independently-positionable entries instead of one joined string, so
  // a caller building a real chat-message array can place each as its own
  // system-role message wherever it wants (e.g. close to the live user
  // turn, matching SillyTavern's "depth" concept) rather than always
  // gluing them into one block. Each entry is capped at maxChars on its
  // own -- unlike getRelatedFacts' shared combined cap -- since the two are
  // now independent messages, not one joined block.
  //
  // options.mentionsPosition / options.factsPosition: "early" (right after
  // the persona/system prompt) or "late" (right before the live user
  // message, the higher-salience position). Both default to "late" --
  // cross-session mentions and remembered facts are specifically relevant
  // to what's being asked *right now*, so they read better close to the
  // live message than buried near the persona definition.
  //
  // Issue #674: async so recall can also match by meaning (embeddings) and
  // rerank when there are more candidates than fit --
  // at most MAX_PINNED_FACTS pinned + maxMatchedFacts matched facts go in,
  // the maxChars cap stays as a second limit. `recall` reports the counts
  // and any fallback for the prompt-composition report (#400).
  async function getRelatedFactsEntries(text, options = {}) {
    const maxChars = Math.max(
      50,
      Number(
        options.maxChars || process.env.MANA_RELATED_FACTS_MAX_CHARS || 300,
      ),
    );
    const mentionsPosition = options.mentionsPosition === "early" ? "early" : "late";
    const factsPosition = options.factsPosition === "early" ? "early" : "late";
    const recall = {
      candidates: 0,
      pinned: 0,
      matched: 0,
      reranked: false,
      rerankMs: 0,
      fallback: null,
    };
    const facts = loadFacts();
    const similarityById = await factSimilarities(
      text,
      withUserWordsVariants(facts.filter((fact) => isRecallable(fact) && (fact.trigger || !fact.pinned))),
      recall,
    );
    const { mentionsBlock, pinned, candidates, intents } = gatherRelatedFactsBlocks(text, {
      ...options,
      facts,
      similarityById,
    });
    // Rerank only when there are more candidates than the cap lets in;
    // otherwise, or when the reranker is off or fails, keep the candidate
    // order from factRecallCandidates.
    const cap = maxMatchedFacts(options);
    let ordered = candidates;
    if (rerankFn && candidates.length > cap) {
      const result = await rerankFn(text, candidates.map(factEmbeddingText));
      recall.reranked = result.reranked;
      recall.rerankMs = result.ms;
      if (result.reranked) {
        ordered = result.order.map((i) => candidates[i]).filter(Boolean);
      } else if (result.fallback) {
        recall.fallback = [recall.fallback, `rerank: ${result.fallback}`].filter(Boolean).join("; ");
      }
    }
    const matched = ordered.slice(0, cap);
    const factsBlock = factsBlockFor(pinned, matched);
    recall.candidates = candidates.length;
    recall.pinned = pinned.length;
    recall.matched = matched.length;

    const entries = [];
    // Issue #364: an over-budget block can truncate down to nothing (its
    // header alone carries no information), so each entry is only pushed
    // if something survived -- previously a clipped header was emitted as
    // a system message on its own.
    if (mentionsBlock) {
      const content = truncateWholeLines(mentionsBlock, maxChars);
      if (content) {
        entries.push({
          role: "system",
          position: mentionsPosition,
          content,
          truncated: content !== mentionsBlock,
        });
      }
    }
    if (factsBlock) {
      const content = truncateWholeLines(factsBlock, maxChars);
      if (content) {
        entries.push({
          role: "system",
          position: factsPosition,
          content,
          truncated: content !== factsBlock,
        });
      }
    }
    // Issue #698: not cut to maxChars -- at most MAX_INTENTS_PER_TURN lines,
    // and a reminder marked fired has to actually reach the prompt.
    if (intents.length) {
      entries.push({
        role: "system",
        position: factsPosition,
        content:
          "Standing reminders the user asked for -- this message touches on them, so work each one into your reply once, briefly and naturally:\n" +
          intents.map((fact) => `- when ${fact.trigger} comes up: ${fact.text}`).join("\n"),
        truncated: false,
      });
      markIntentsFired(intents.map(factRecallId));
    }
    recall.intents = intents.length;
    return { entries, recall };
  }

  // Issue #295 (piece 2 of #285): userAffectState tracks a decaying read on
  // the user's affect, built from the same mood signal reply-emotion.js
  // already detects for the avatar's own expression -- just applied to the
  // user's text instead of Mana's reply, and accumulated over time instead
  // of labeling one reply. manaSelfState's inputs (loneliness from session
  // gap, rutScore from rut-detection.js) are deliberately NOT stored here:
  // both are already derivable on demand from data this module (session
  // timestamps) or rut-detection.js (a live per-session score) already
  // owns, so persisting a second, potentially-stale copy would just be a
  // sync bug waiting to happen. Only the genuinely accumulated value
  // (positivity, built from many small per-turn nudges) needs its own
  // persisted, decaying state.
  const AFFECT_DECAY_HALF_LIFE_HOURS = 12;
  const AFFECT_NUDGE = 0.2;

  function loadEmotionalState() {
    const parsed = readJsonObject(emotionalStatePath);
    const userAffect = parsed?.userAffect;
    if (userAffect && typeof userAffect.positivity === "number" && userAffect.lastUpdatedAt) {
      return { userAffect };
    }
    return { userAffect: { positivity: 0, lastUpdatedAt: null } };
  }

  function decayedPositivity(userAffect, at) {
    if (!userAffect.lastUpdatedAt) return 0;
    const elapsedHours =
      (new Date(at).getTime() - new Date(userAffect.lastUpdatedAt).getTime()) / 3600000;
    if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) return userAffect.positivity;
    return userAffect.positivity * Math.pow(0.5, elapsedHours / AFFECT_DECAY_HALF_LIFE_HOURS);
  }

  // Applies decay since the last update, then nudges by AFFECT_NUDGE toward
  // whatever valence text carries (positive/negative/none), clamped to
  // [-1, 1]. Called once per turn from appendTurn -- never throws (a
  // corrupt/missing state file just resets to neutral, same as any other
  // JSON file in this store).
  function updateUserAffect(text, at) {
    const { userAffect } = loadEmotionalState();
    const decayed = decayedPositivity(userAffect, at);
    const valence = detectTextValence(text);
    const next = Math.max(-1, Math.min(1, decayed + valence * AFFECT_NUDGE));
    writeJsonObject(emotionalStatePath, {
      userAffect: { positivity: next, lastUpdatedAt: at },
    });
    return next;
  }

  // Returns the current decayed positivity without recording a new
  // observation -- for a caller (server.js's periodic reflex check) that
  // just wants to read the value, not nudge it.
  function getUserAffect(at) {
    const { userAffect } = loadEmotionalState();
    return decayedPositivity(userAffect, at || now());
  }

  function getSession(sessionId) {
    const existing = readJsonObject(filePathForSession(sessionId));
    if (!existing) {
      return null;
    }

    // sanitize any stored assistant text that may include startup banners
    try {
      const { cleanLlamaOutput } = require("./ai/local-llama-runtime");
      if (existing.summary && typeof existing.summary === "string") {
        existing.summary = cleanText(
          cleanLlamaOutput(existing.summary),
          maxSummaryChars,
        );
      }
      if (Array.isArray(existing.turns)) {
        existing.turns = existing.turns.map((t) => ({
          ...t,
          user: cleanText(t.user, 4000),
          assistant:
            t.assistant && typeof t.assistant === "string"
              ? cleanLlamaOutput(t.assistant)
              : t.assistant,
        }));
      }
    } catch (e) {
      // if cleaning util missing, fall back to trimming
      // continue silently
    }

    return {
      ...existing,
      turns: Array.isArray(existing.turns) ? existing.turns : [],
      summary: cleanText(existing.summary, maxSummaryChars),
    };
  }

  function saveSession(session) {
    writeJsonObject(filePathForSession(session.sessionId), session);
    return session;
  }

  function ensureSession(input = {}) {
    const sessionId = cleanText(input.sessionId || "default", 240);
    const existing = getSession(sessionId);
    if (existing) {
      const updated = {
        ...existing,
        name: input.name ? cleanText(input.name, 80) : existing.name || null,
        cwd: cleanText(input.cwd || existing.cwd, 1000),
        editor: cleanText(input.editor || existing.editor || "zed", 80),
        updatedAt: now(),
      };
      return saveSession(updated);
    }

    return saveSession(createEmptySession({ ...input, sessionId }, now()));
  }

  function renameSession(sessionId, name) {
    const existing = getSession(cleanText(sessionId, 240));
    if (!existing) {
      return null;
    }

    if (snapshotStore) {
      try {
        snapshotStore.recordSnapshot({
          kind: "memory-session",
          key: existing.sessionId,
          payload: existing,
          summary: `session rename: ${existing.sessionId}`,
          source: "human",
        });
      } catch (e) {
        console.warn("Session snapshot failed:", e?.message || e);
      }
    }

    return saveSession({
      ...existing,
      name: cleanText(name, 80) || null,
      updatedAt: now(),
    });
  }

  // Issue #401: a plain, user-stated goal for a session -- deliberately
  // never inferred by the model, so it's set the same way a name is (one
  // string, replace-in-place). An empty string clears it, same as
  // renameSession's own empty-name-becomes-null behavior.
  function setSessionGoal(sessionId, goal) {
    const existing = getSession(cleanText(sessionId, 240));
    if (!existing) {
      return null;
    }

    if (snapshotStore) {
      try {
        snapshotStore.recordSnapshot({
          kind: "memory-session",
          key: existing.sessionId,
          payload: existing,
          summary: `session goal change: ${existing.sessionId}`,
          source: "human",
        });
      } catch (e) {
        console.warn("Session snapshot failed:", e?.message || e);
      }
    }

    return saveSession({
      ...existing,
      goal: cleanText(goal, 500) || null,
      updatedAt: now(),
    });
  }

  // Issue #350: branch a session into a new one carrying its history, so a
  // different approach can be tried without destroying the thread that got
  // you there. Resuming needed nothing new -- a session is a file keyed by
  // id, so reopening one is just using its id again, and listSessions()
  // already enumerates them. Forking was the actual gap.
  //
  // The copy carries summary and turns, which is what lets the fork keep
  // talking with context. It deliberately does not re-index the inherited
  // turns under the new id: those exchanges happened in the original
  // session, and searchSessions() should keep attributing them there rather
  // than reporting the same conversation twice under two ids.
  function forkSession(sessionId, input = {}) {
    const source = getSession(cleanText(sessionId, 240));
    if (!source) {
      return null;
    }

    const targetId = cleanText(
      input.sessionId || `${source.sessionId}-fork-${Date.now().toString(36)}`,
      240,
    );
    if (getSession(targetId)) {
      throw new Error("fork target session already exists");
    }

    const timestamp = now();
    return saveSession({
      ...source,
      sessionId: targetId,
      name: input.name ? cleanText(input.name, 80) : `${source.name || source.sessionId} (fork)`,
      // Kept so a fork's origin stays answerable after the fact.
      forkedFrom: source.sessionId,
      forkedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      turns: Array.isArray(source.turns) ? [...source.turns] : [],
    });
  }

  function deleteSession(sessionId) {
    const filePath = filePathForSession(cleanText(sessionId, 240));
    if (!fs.existsSync(filePath)) {
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  }

  function listSessions() {
    const files = fs
      .readdirSync(sessionsDir)
      .filter((file) => file.endsWith(".json"));

    const sessions = files
      .map((file) => {
        try {
          const parsed = readJsonObject(path.join(sessionsDir, file));
          if (!parsed || !parsed.sessionId) {
            return null;
          }
          return {
            sessionId: parsed.sessionId,
            name: parsed.name || null,
            goal: parsed.goal || null,
            createdAt: parsed.createdAt || null,
            updatedAt: parsed.updatedAt || null,
            turnCount: Array.isArray(parsed.turns) ? parsed.turns.length : 0,
          };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);

    sessions.sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
    );
    return sessions;
  }

  // Paginated read of a session's turns for chat-history scrollback: turns
  // are stored oldest-first, so "the next page going back in time" is the
  // slice immediately before `before` (defaulting to the tail, i.e. the
  // most recent page). hasMore/nextBefore tell the caller whether -- and
  // where -- to fetch the next page up when the user scrolls further.
  function getSessionTurnsPage(sessionId, { before, limit = 20 } = {}) {
    const session = getSession(sessionId);
    if (!session) {
      return null;
    }
    const turns = session.turns;
    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 20));
    const end =
      before === undefined || before === null
        ? turns.length
        : Math.max(0, Math.min(turns.length, Number(before) || 0));
    const start = Math.max(0, end - boundedLimit);
    return {
      turns: turns.slice(start, end),
      hasMore: start > 0,
      nextBefore: start,
      total: turns.length,
    };
  }

  async function appendTurn(input = {}) {
    const session = ensureSession({ sessionId: input.sessionId });
    const timestamp = now();
    const turn = {
      at: timestamp,
      user: cleanText(redactSensitive(input.user), 4000),
      assistant: cleanText(redactSensitive(input.assistant), 4000),
    };
    // Optional (issue #153): only the tool-calling reply path ever has
    // these, so most turns simply omit the field rather than storing an
    // empty array on every single turn.
    if (Array.isArray(input.toolCalls) && input.toolCalls.length) {
      turn.toolCalls = input.toolCalls.map((call) => ({
        name: cleanText(call?.name, 200),
        ok: Boolean(call?.ok),
        args: redactSensitive(call?.args),
        result: call?.result,
      }));
    }

    if (!turn.user && !turn.assistant) {
      return session;
    }

    if (sessionSearchIndex) {
      try {
        sessionSearchIndex.indexTurn({ sessionId: session.sessionId, turn });
      } catch (e) {
        // Search is a nicety layered on top of the real session record
        // (saveSession below) -- never let an indexing failure break the
        // actual conversation flow.
        console.warn("Session search indexing failed:", e?.message || e);
      }

      // Issue #263: fire-and-forget, matching the compaction IIFE below --
      // appendTurn never awaits this, so a slow or unavailable embedder
      // can't add latency to the actual reply path. Embeds this turn plus
      // any earlier ones not yet embedded (a missed turn, or all history
      // after an embedding-model change); never rejects.
      if (computeEmbeddingsFn && typeof sessionSearchIndex.syncEmbeddings === "function") {
        sessionSearchIndex.syncEmbeddings(computeEmbeddingsFn, embeddingModelIdFn);
      }
    }

    const turnEntities = extractEntities(`${turn.user} ${turn.assistant}`);
    recordEntityMentions(turnEntities, session.sessionId, timestamp);
    // Issue #295: reinforces this turn's co-occurring entity pairs. Never
    // blocks the turn append -- a graph write failure only means this
    // turn's associations aren't recorded, not that memory itself broke.
    // Multi-word entities only ("Alice Smith", not "Sounds") -- extractEntities()
    // is a naive Title-Case-run heuristic (already documented above as
    // "not real NER"), and a lone sentence-initial capitalized word (an
    // assistant reply starting "Sounds great!" or "Agreed, ...") is common
    // enough to turn into real noise once it becomes a graph edge shown
    // back as an "associative" result -- entity-index.json's own mention
    // tracking is untouched by this filter, only graph reinforcement is.
    if (memoryGraph) {
      try {
        const multiWordEntities = turnEntities.filter((e) => e.includes(" "));
        memoryGraph.reinforce(multiWordEntities);
      } catch (e) {
        console.warn("Memory graph reinforcement failed:", e?.message || e);
      }
    }
    // Issue #295: nudges userAffectState from this turn's user text. Never
    // blocks the turn append, same failure-safety as the graph above.
    try {
      updateUserAffect(turn.user, timestamp);
    } catch (e) {
      console.warn("User affect update failed:", e?.message || e);
    }

    const summaryLine = summarizeTurn(
      turn.user,
      turn.assistant,
      maxSummaryChars,
    );
    const summary = truncateKeepingRecent(
      [session.summary, summaryLine].filter(Boolean).join("\n"),
      maxSummaryChars,
    );
    // Full history is kept on disk (unbounded) so the desktop UI can scroll
    // back through an entire session -- only buildPromptMemory()'s own
    // slice (below) bounds what actually reaches the AI's prompt, so
    // keeping everything here doesn't affect reply latency or cost.
    const turns = [...session.turns, turn];
    const name =
      session.name || (!session.turns.length && autoNameFromText(turn.user)) || null;

    if (snapshotStore) {
      try {
        snapshotStore.recordSnapshot({
          kind: "memory-session",
          key: session.sessionId,
          payload: session,
          summary: `turn appended: ${session.sessionId}`,
          source: "agent",
        });
      } catch (e) {
        console.warn("Session snapshot failed:", e?.message || e);
      }
    }

    const saved = saveSession({
      ...session,
      name,
      summary,
      turns,
      updatedAt: timestamp,
    });

    // If summary is long (by token estimate) and a summarizer was provided, compact in background
    try {
      const summaryTokens = await Promise.resolve(
        tokenEstimator(saved.summary || ""),
      );
      if (
        summarizeFn &&
        saved.summary &&
        summaryTokens >= Math.floor(maxSummaryTokens * 0.9)
      ) {
        // fire-and-forget async compaction
        (async () => {
          try {
            // Issue #263 part 2: an explicit cursor instead of always just
            // "the last min(10, maxRecentTurns) turns" -- if compaction has
            // been failing (summarizeFn throwing, or simply not configured
            // in some earlier session state) for longer than 10 turns, the
            // fixed-window version would silently never include the older
            // unsummarized turns in the next attempt. Still bounded by
            // maxRecentTurns so a compaction that's been broken for a very
            // long time doesn't build an unbounded prompt.
            const cursor = Number(saved.lastSummarizedTurnIndex) || 0;
            const windowStart = Math.max(
              cursor,
              saved.turns.length - maxRecentTurns,
            );
            const recentTurns = saved.turns.slice(windowStart);
            const newSummary = await summarizeFn({
              sessionId: saved.sessionId,
              summary: saved.summary,
              turns: recentTurns,
              maxSummaryTokens,
            });
            if (newSummary && typeof newSummary === "string") {
              const compacted = cleanText(newSummary, maxSummaryChars);
              const reloaded = getSession(saved.sessionId) || saved;
              if (compacted !== reloaded.summary) {
                reloaded.summary = compacted;
                reloaded.lastSummarizedTurnIndex = saved.turns.length;
                reloaded.updatedAt = now();
                saveSession(reloaded);
              }
            }
          } catch (e) {
            // don't let summarization errors affect main flow
            console.warn("ACP memory summarization failed:", e?.message || e);
          }
        })();
      }
    } catch (e) {
      console.warn("ACP memory summarization trigger failed:", e?.message || e);
    }

    return saved;
  }

  // Shared by buildPromptMemory (string, unchanged) and
  // buildPromptMemoryEntries (issue #282, structured) -- iterates parts and
  // stops once tokenEstimator says the accumulated text would exceed
  // maxPromptTokens, truncating the first part by chars if even it alone
  // doesn't fit.
  function selectPartsWithinTokenBudget(parts) {
    const selected = [];
    let accText = "";
    let truncated = false;
    for (let i = 0; i < parts.length; i++) {
      const candidate = (parts[i] || "").toString();
      const newText = (accText ? accText + "\n" : "") + candidate;
      // tokenEstimator may be async in some custom configs; prefer a synchronous fallback
      let estTokens;
      try {
        const maybe = tokenEstimator(newText);
        if (maybe && typeof maybe.then === "function") {
          // async estimator detected; fall back to char-based heuristic
          estTokens = Math.max(1, Math.ceil((newText.length || 0) / 4));
        } else {
          estTokens =
            Number(maybe) || Math.max(1, Math.ceil((newText.length || 0) / 4));
        }
      } catch (e) {
        estTokens = Math.max(1, Math.ceil((newText.length || 0) / 4));
      }

      if (estTokens > maxPromptTokens) {
        // Stop adding more; if nothing added yet, truncate candidate to fit approximately
        if (!selected.length) {
          // truncate candidate by chars to roughly fit
          const approxChars = Math.max(
            1,
            Math.floor(maxPromptTokens * 4 - (accText.length || 0)),
          );
          selected.push(candidate.slice(0, Math.max(0, approxChars)));
        }
        truncated = true;
        break;
      }
      selected.push(candidate);
      accText = newText;
    }

    return { text: selected.join("\n").trim(), truncated };
  }

  // Issue #338: the age half of the bound. A turn carrying no timestamp
  // predates this and cannot be dated -- it is kept rather than silently
  // dropped, since discarding content we simply can't evaluate is worse
  // than injecting one stale line.
  function freshTurns(session) {
    if (!maxRecentTurnAgeMs) return session.turns;
    const cutoff = Date.parse(now()) - maxRecentTurnAgeMs;
    if (Number.isNaN(cutoff)) return session.turns;
    const fresh = session.turns.filter((turn) => {
      if (!turn?.at) return true;
      const at = Date.parse(turn.at);
      return Number.isNaN(at) || at >= cutoff;
    });

    // Issue #385: a floor under the age window. #338's rule is right for
    // bulk -- a fortnight of old turns must not masquerade as the live
    // thread -- but on its own it has a cliff: come back after a long gap
    // and *every* turn is outside the window, so the verbatim block empties
    // completely. The last thing said is disproportionately useful even
    // when it is old, precisely because it is where the thread stopped.
    // Position, not age, so the newest turns are the ones kept.
    if (fresh.length >= minRecentTurns) return fresh;
    return session.turns.slice(-minRecentTurns);
  }

  // Issue #383: a skill body enters context as the result of a skill__view
  // call inside one turn. Once that turn falls out of the injected window,
  // the body is gone -- but the model's own earlier statements about having
  // consulted the skill remain in the rolling summary. It can then keep
  // reasoning as though it still holds the steps, and describe ones it no
  // longer has in front of it. Worse than never having loaded the skill,
  // because the history contains evidence that it did.
  //
  // A marker names the skill and says the content is gone, so recovery is
  // one skill__view call rather than improvisation. Deliberately one line
  // per skill: summarizing what was pruned would defeat the pruning.
  const SKILL_VIEW_TOOL = "skill__view";

  function skillNameFromCall(call) {
    const raw = call?.args?.name ?? call?.args?.skill;
    const name = cleanText(raw, 200);
    return name || null;
  }

  // Only skills whose body is *no longer anywhere* in the injected turns.
  // Viewing the same skill twice, with one view still in the window, means
  // the body is present and there is nothing to warn about.
  function prunedSkillNames(session, injectedTurns) {
    const injected = new Set(injectedTurns);
    const present = new Set();
    const pruned = new Set();
    for (const turn of session.turns || []) {
      for (const call of turn?.toolCalls || []) {
        if (call?.name !== SKILL_VIEW_TOOL) continue;
        const name = skillNameFromCall(call);
        if (!name) continue;
        (injected.has(turn) ? present : pruned).add(name);
      }
    }
    return [...pruned].filter((name) => !present.has(name));
  }

  function prunedSkillLines(session, injectedTurns) {
    return prunedSkillNames(session, injectedTurns).map(
      (name) => `- ${name}: body no longer in context; call skill__view to reload it`,
    );
  }

  function recentTurnStrings(session) {
    return freshTurns(session)
      .slice(-Math.min(5, maxRecentTurns))
      .map((turn) =>
        [
          `User: ${turn.user}`,
          turn.assistant ? `Assistant: ${turn.assistant}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
  }

  function buildPromptMemory(sessionId) {
    const session = getSession(sessionId);
    if (!session || (!session.summary && !session.turns.length)) {
      return "";
    }

    const recentTurns = recentTurnStrings(session);
    // Issue #338: with every turn aged out and no summary yet, the header
    // would be all that is left -- and "Conversation memory:" on its own
    // says nothing while still costing tokens. Same reasoning as #364's
    // dangling-header drop.
    if (!session.summary && !recentTurns.length) return "";

    const pruned = prunedSkillLines(session, freshTurns(session).slice(-Math.min(5, maxRecentTurns)));

    const parts = [];
    parts.push("Conversation memory:");
    if (session.summary) parts.push(session.summary);
    if (recentTurns.length) {
      parts.push("");
      parts.push("Recent turns:");
      for (const rt of recentTurns) {
        parts.push(rt);
      }
    }
    if (pruned.length) {
      parts.push("");
      parts.push("Skills consulted earlier, no longer loaded:");
      for (const line of pruned) {
        parts.push(line);
      }
    }

    return selectPartsWithinTokenBudget(parts).text;
  }

  // Issue #282: structured form of buildPromptMemory -- the summary and the
  // recent-turns block as two independently-positionable entries instead of
  // one joined string. Both default to "late" (right before the live user
  // message -- SillyTavern's high-salience "depth 0" equivalent, since what
  // was *just* discussed is most relevant to what's being asked now). Each
  // entry is token-bounded independently with the same budget
  // buildPromptMemory applies to the combined block.
  //
  // Issue #660: the summary used to default to "early" (right after the
  // persona), but appendTurn folds a new line into it on every turn, so an
  // early summary changed the prompt prefix every turn and stopped
  // llama-server reusing its prompt cache past the system message.
  function buildPromptMemoryEntries(sessionId, options = {}) {
    const session = getSession(sessionId);
    if (!session || (!session.summary && !session.turns.length)) {
      return { entries: [], turnsDroppedByAge: 0 };
    }

    const summaryPosition = options.summaryPosition === "early" ? "early" : "late";
    const recentTurnsPosition = options.recentTurnsPosition === "early" ? "early" : "late";

    const entries = [];
    if (session.summary) {
      const summary = selectPartsWithinTokenBudget(["Conversation memory:", session.summary]);
      if (summary.text) {
        entries.push({
          role: "system",
          position: summaryPosition,
          content: summary.text,
          truncated: summary.truncated,
        });
      }
    }

    const recentTurns = recentTurnStrings(session);
    if (recentTurns.length) {
      const recent = selectPartsWithinTokenBudget(["Recent turns:", ...recentTurns]);
      if (recent.text) {
        entries.push({
          role: "system",
          position: recentTurnsPosition,
          content: recent.text,
          truncated: recent.truncated,
        });
      }
    }

    // Issue #400: #338's age window (freshTurns) drops turns before they
    // ever reach recentTurnStrings/selectPartsWithinTokenBudget above, so
    // neither entry's own truncated flag can see it -- surfaced separately.
    const turnsDroppedByAge = session.turns.length - freshTurns(session).length;

    return { entries, turnsDroppedByAge };
  }

  // Issue #295 (round-2 scoping of #285): a second pass chained after the
  // base keyword/semantic results, not a third parallel signal computed
  // from the query string -- spreading activation needs a starting point
  // (an already-activated node) that the query alone doesn't give it. Pulls
  // entities out of the base hits, walks one hop in the graph, and turns
  // any neighbor with real mentions in entity-index.json into a candidate
  // result. Deliberately simple dedup (skip a node already surfaced this
  // call) rather than reusing session-search-index.js's text-similarity
  // diversity filter, which isn't exported and isn't needed at this scale.
  const MAX_ASSOCIATIVE_RESULTS = 5;
  // 1, not a higher bar -- an edge's weight already starts at 1.0 on its
  // first reinforcement (see memory-graph.js), and most real co-occurring
  // pairs in normal usage will only ever be mentioned together once or
  // twice. Requiring more than that before anything can surface would mean
  // the common case never shows an associative result at all.
  const ASSOCIATIVE_MIN_WEIGHT = 1;
  function associativeResultsFor(baseResults, excludeSessionId) {
    if (!memoryGraph || !baseResults.length) return [];
    const seedEntities = new Set();
    for (const r of baseResults) {
      for (const e of extractEntities(r.text)) seedEntities.add(e);
    }
    const candidates = [];
    const seenNodes = new Set();
    for (const entity of seedEntities) {
      const neighbors = memoryGraph.getNeighbors(entity, {
        minWeight: ASSOCIATIVE_MIN_WEIGHT,
        limit: MAX_ASSOCIATIVE_RESULTS,
      });
      for (const { node, weight } of neighbors) {
        if (seenNodes.has(node)) continue;
        const mentions = lookupEntity(node);
        if (!mentions.length) continue;
        const last = mentions[mentions.length - 1];
        if (excludeSessionId && last.sessionId === excludeSessionId) continue;
        seenNodes.add(node);
        candidates.push({
          sessionId: last.sessionId,
          role: "associative",
          text: `${last.display}: associatively linked (mentioned in another session around ${last.at})`,
          at: last.at,
          matchType: "associative",
          weight,
        });
      }
    }
    candidates.sort((a, b) => b.weight - a.weight);
    return candidates.slice(0, MAX_ASSOCIATIVE_RESULTS);
  }

  // Full-text (+ semantic, when computeEmbeddingsFn is wired -- issue #263
  // part 1) search across every indexed turn (see sessionSearchIndex
  // above); [] when no index was wired in (tests, or search disabled).
  async function searchSessions(params = {}) {
    if (!sessionSearchIndex) return [];
    // Issue #337: a stated time window becomes a filter, and the date
    // expression is stripped from the keyword query rather than left to run
    // through FTS -- the stored turn says "the deploy broke", not
    // "yesterday the deploy broke", so matching on the word finds nothing.
    // An explicit since/until from the caller wins over what the text says.
    const temporal =
      params?.since || params?.until ? null : parseTemporalWindow(params?.query);
    const effective = temporal
      ? {
          ...params,
          query: temporal.residualQuery,
          since: temporal.since,
          until: temporal.until,
        }
      : params;

    let queryEmbedding = null;
    if (computeEmbeddingsFn && effective?.query) {
      try {
        const [embedding] = await computeEmbeddingsFn([String(effective.query)], { query: true });
        if (Array.isArray(embedding) && embedding.length) queryEmbedding = embedding;
      } catch (e) {
        // Semantic search is additive -- keyword search below still runs
        // fine without it.
      }
    }
    let results = sessionSearchIndex.search({
      ...effective,
      queryEmbedding,
      queryModel: embeddingModelIdFn(),
    });
    // Issue #674: keyword and vector hits are interleaved with no shared
    // score (mergeResults), so a reranker orders them and only the best few
    // go back to the model. Relevance sort only -- newest/oldest keep their
    // chronological order -- and on any reranker failure all results go
    // back unchanged, as before.
    if (
      rerankFn &&
      effective?.query &&
      effective.sort !== "newest" &&
      effective.sort !== "oldest" &&
      results.length > SESSION_SEARCH_RERANKED_TOP
    ) {
      const result = await rerankFn(
        String(effective.query),
        results.map((r) => r.text),
      );
      if (result.reranked) {
        results = result.order
          .slice(0, SESSION_SEARCH_RERANKED_TOP)
          .map((i) => results[i])
          .filter(Boolean);
      }
    }
    if (!memoryGraph) return results;
    try {
      const associative = associativeResultsFor(results, params.sessionId);
      return associative.length ? [...results, ...associative] : results;
    } catch (e) {
      // Associative retrieval is additive -- keyword/semantic results above
      // still stand on their own if the graph lookup fails.
      console.warn("Associative memory graph lookup failed:", e?.message || e);
      return results;
    }
  }

  return {
    dataDir,
    sessionsDir,
    ensureSession,
    appendTurn,
    buildPromptMemory,
    buildPromptMemoryEntries,
    getSession,
    getSessionTurnsPage,
    listSessions,
    renameSession,
    setSessionGoal,
    forkSession,
    deleteSession,
    lookupEntity,
    describeEntities,
    getRelatedFacts,
    getRelatedFactsEntries,
    rememberFact,
    listFactKeys,
    listFacts,
    getFactsValidAt,
    invalidateFactByKey,
    getFactHistory,
    getFactVersion,
    archiveExpiredPendingFacts,
    setFactPinned,
    setFactPaused,
    listUntypedEntities,
    setEntityType,
    listCanonicalEntitiesOfType,
    setCanonicalAlias,
    resolveCanonicalKey,
    searchSessions,
    memoryGraph,
    getUserAffect,
  };
}

module.exports = {
  createAcpMemoryStore,
  extractEntities,
  factRecallCandidates,
  factTrust,
};
