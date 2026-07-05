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
    cwd: cleanText(input.cwd, 1000),
    editor: cleanText(input.editor || "zed", 80),
    createdAt: now,
    updatedAt: now,
    summary: "",
    turns: [],
  };
}

function summarizeTurn(user, assistant, maxSummaryChars) {
  const userText = cleanText(user, 500);
  const assistantText = cleanText(assistant, 500);
  if (!userText && !assistantText) {
    return "";
  }

  return `- User: ${userText}${assistantText ? ` Assistant: ${assistantText}` : ""}`;
}

function createAcpMemoryStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.MANA_ACP_MEMORY_DIR ||
    path.join(__dirname, "data", "acp-memory");
  const sessionsDir = path.join(dataDir, "sessions");
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
        cwd: cleanText(input.cwd || existing.cwd, 1000),
        editor: cleanText(input.editor || existing.editor || "zed", 80),
        updatedAt: now(),
      };
      return saveSession(updated);
    }

    return saveSession(createEmptySession({ ...input, sessionId }, now()));
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
    const saved = saveSession({
      ...session,
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

  async function buildPromptMemory(sessionId) {
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
      const estTokens = await Promise.resolve(tokenEstimator(newText));
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
  };
}

module.exports = {
  createAcpMemoryStore,
};
