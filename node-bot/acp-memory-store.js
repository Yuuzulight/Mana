const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function significantWords(text) {
  return [
    ...new Set(
      String(text || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    ),
  ];
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
    const hits = factWords.filter((w) => words.includes(w));
    if (hits.length >= Math.min(MIN_CONFLICT_WORD_HITS, factWords.length)) return fact;
  }
  return null;
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
  const factsPath = path.join(dataDir, "facts.json");
  // ponytail: fixed cap, not age-based pruning -- revisit if explicit
  // facts genuinely need trimming by more than "keep the most recent N".
  const maxFacts = 500;
  // ponytail: fixed cap per entity, not age-based pruning -- revisit if a
  // heavily-recurring entity's mention list needs trimming by more than
  // "keep the most recent N".
  const maxMentionsPerEntity = 100;
  const now = options.now || (() => new Date().toISOString());
  const maxRecentTurns = Math.max(1, Number(options.maxRecentTurns || 20));
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
      .filter((f) => f.status === "active")
      .map((f) => ({ key: f.key, preview: cleanText(f.text, 80) }));
  }

  function saveFacts(facts) {
    writeJsonObject(factsPath, { facts });
  }

  // action: "insert" (default) always creates a new fact. "patch" updates
  // the existing active fact with this key if one exists, otherwise falls
  // back to insert (nothing to patch yet). "remove" marks an existing
  // active fact as stale (soft delete -- preserves history, matches this
  // store's general append-safe philosophy elsewhere) and is a no-op if
  // nothing with that key exists. "archive" (issue #277) marks a fact
  // still-true-but-no-longer-worth-automatically-surfacing: distinct from
  // "stale" (no longer true) -- an archived fact is excluded from
  // getRelatedFacts' automatic key-match surfacing and listFactKeys' tool
  // description, but never deleted.
  const MAX_FACT_HISTORY = 5;
  function rememberFact({ sessionId, key, text, action } = {}) {
    const cleanKey = cleanText(key, 200);
    if (!cleanKey) {
      throw new Error("key is required");
    }
    const normalizedAction = ["insert", "patch", "remove", "archive"].includes(action)
      ? action
      : "insert";
    const facts = loadFacts();
    const existing = facts.find(
      (f) => f.status === "active" && f.key.toLowerCase() === cleanKey.toLowerCase(),
    );
    const timestamp = now();

    if (normalizedAction === "remove" || normalizedAction === "archive") {
      if (!existing) {
        return { ok: true, action: normalizedAction, key: cleanKey, found: false };
      }
      existing.status = normalizedAction === "remove" ? "stale" : "archived";
      existing.updatedAt = timestamp;
      saveFacts(facts);
      return { ok: true, action: normalizedAction, key: cleanKey, found: true };
    }

    const cleanTextValue = cleanText(text, 500);
    if (!cleanTextValue) {
      throw new Error("text is required for insert/patch");
    }

    if (existing && normalizedAction === "patch") {
      // Issue #273: keep a bounded correction history instead of silently
      // discarding the prior value -- "what did I used to think was true"
      // stays inspectable, matching the self-healing-memory pattern this
      // issue is built around.
      const history = Array.isArray(existing.history) ? existing.history : [];
      history.push({ text: existing.text, updatedAt: existing.updatedAt });
      existing.history = history.slice(-MAX_FACT_HISTORY);
      existing.text = cleanTextValue;
      existing.updatedAt = timestamp;
      saveFacts(facts);
      return { ok: true, action: "patch", key: cleanKey, text: cleanTextValue };
    }

    // insert -- either explicitly requested, or "patch" with nothing yet
    // to patch.
    const conflict = findConflictingFact(facts, cleanKey, cleanTextValue);
    facts.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      key: cleanKey,
      text: cleanTextValue,
      sessionId: cleanText(sessionId || "default", 240),
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    saveFacts(facts.slice(-maxFacts));
    return {
      ok: true,
      action: "insert",
      key: cleanKey,
      text: cleanTextValue,
      ...(conflict
        ? { possibleConflict: { key: conflict.key, preview: cleanText(conflict.text, 80) } }
        : {}),
    };
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
  function getRelatedFacts(text, options = {}) {
    const excludeSessionId = options.excludeSessionId;
    const maxEntities = Math.max(
      1,
      Number(
        options.maxEntities || process.env.MANA_RELATED_FACTS_MAX_ENTITIES || 3,
      ),
    );
    const maxChars = Math.max(
      50,
      Number(
        options.maxChars || process.env.MANA_RELATED_FACTS_MAX_CHARS || 300,
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

    const lowerText = String(text || "").toLowerCase();
    const factLines = [];
    for (const fact of loadFacts()) {
      if (fact.status !== "active") continue;
      if (!lowerText.includes(fact.key.toLowerCase())) continue;
      factLines.push(`- ${fact.key}: ${fact.text}`);
    }

    const blocks = [];
    if (mentionLines.length) {
      blocks.push(`Related from other sessions:\n${mentionLines.join("\n")}`);
    }
    if (factLines.length) {
      blocks.push(`Remembered:\n${factLines.join("\n")}`);
    }
    if (!blocks.length) return "";

    const block = blocks.join("\n\n");
    return block.length > maxChars ? block.slice(0, maxChars).trim() : block;
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

    return saveSession({
      ...existing,
      name: cleanText(name, 80) || null,
      updatedAt: now(),
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
      user: cleanText(input.user, 4000),
      assistant: cleanText(input.assistant, 4000),
    };
    // Optional (issue #153): only the tool-calling reply path ever has
    // these, so most turns simply omit the field rather than storing an
    // empty array on every single turn.
    if (Array.isArray(input.toolCalls) && input.toolCalls.length) {
      turn.toolCalls = input.toolCalls.map((call) => ({
        name: cleanText(call?.name, 200),
        ok: Boolean(call?.ok),
        args: call?.args,
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
    }

    recordEntityMentions(
      extractEntities(`${turn.user} ${turn.assistant}`),
      session.sessionId,
      timestamp,
    );

    const summaryLine = summarizeTurn(
      turn.user,
      turn.assistant,
      maxSummaryChars,
    );
    const summary = cleanText(
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
            const recentTurns = saved.turns.slice(
              -Math.min(10, maxRecentTurns),
            );
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

  function buildPromptMemory(sessionId) {
    const session = getSession(sessionId);
    if (!session || (!session.summary && !session.turns.length)) {
      return "";
    }

    const recentTurns = session.turns
      .slice(-Math.min(5, maxRecentTurns))
      .map((turn) =>
        [
          `User: ${turn.user}`,
          turn.assistant ? `Assistant: ${turn.assistant}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );

    // Build token-bounded block: iterate parts and stop when tokenEstimator exceeds maxPromptTokens
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

    const selected = [];
    let accText = "";
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
        break;
      }
      selected.push(candidate);
      accText = newText;
    }

    const block = selected.join("\n").trim();
    return block;
  }

  // Full-text search across every indexed turn (see sessionSearchIndex
  // above); [] when no index was wired in (tests, or search disabled).
  function searchSessions(params = {}) {
    if (!sessionSearchIndex) return [];
    return sessionSearchIndex.search(params);
  }

  return {
    dataDir,
    sessionsDir,
    ensureSession,
    appendTurn,
    buildPromptMemory,
    getSession,
    getSessionTurnsPage,
    listSessions,
    renameSession,
    deleteSession,
    lookupEntity,
    getRelatedFacts,
    rememberFact,
    listFactKeys,
    searchSessions,
  };
}

module.exports = {
  createAcpMemoryStore,
  extractEntities,
};
