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

  async function appendTurn(input = {}) {
    const session = ensureSession({ sessionId: input.sessionId });
    const timestamp = now();
    const turn = {
      at: timestamp,
      user: cleanText(input.user, 4000),
      assistant: cleanText(input.assistant, 4000),
    };

    if (!turn.user && !turn.assistant) {
      return session;
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
    const turns = [...session.turns, turn].slice(-maxRecentTurns);
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

  return {
    dataDir,
    sessionsDir,
    ensureSession,
    appendTurn,
    buildPromptMemory,
    getSession,
    listSessions,
    renameSession,
    deleteSession,
    lookupEntity,
  };
}

module.exports = {
  createAcpMemoryStore,
  extractEntities,
};
