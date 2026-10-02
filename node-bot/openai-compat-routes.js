// OpenAI-compatible API routes (issue #95), moved out of server.js's
// registerRoutes() (#500). Behaviour is unchanged: same paths, same auth.
const path = require("path");
const { Readable } = require("node:stream");
const { withCrisisInstruction } = require("./utils/crisis-check");

// activeLlamaServerRuntime: deps.llamaServerRuntime || the module-level one
// (chat proxying). llamaServerRuntime: always the module-level one (model
// listing) -- kept split exactly as it was in server.js.
function registerOpenAiCompatRoutes(app, deps) {
  const { authMiddleware, activeLlamaServerRuntime, llamaServerRuntime } = deps;

  // POST /v1/chat/completions — OpenAI-compatible chat endpoint (issue #95),
  // so external tools (Obsidian Copilot, etc.) can point at Mana directly
  // instead of only talking to Mana's own bespoke routes. Proxies straight
  // through to the persistent llama-server's own OpenAI endpoint; unlike
  // runLocalAssistantReply this does not inject Mana's persona system
  // prompt, since external clients bring their own messages -- apart from
  // the crisis note (utils/crisis-check.js) when the last user message needs it.
  app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
    if (!activeLlamaServerRuntime.isEnabled()) {
      return res.status(503).json({
        error: {
          message:
            "llama-server mode is disabled; /v1/chat/completions requires MANA_LLAMA_SERVER to be enabled (see docs/API_KEYS.md).",
        },
      });
    }
    try {
      const upstream = await activeLlamaServerRuntime.proxyChatCompletion(withCrisisInstruction(req.body, deps.env || process.env));
      res.status(upstream.status);
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.type(contentType);
      if (!upstream.body) {
        return res.end();
      }
      // proxyChatCompletion already scheduled the idle-shutdown timer when
      // the request was dispatched, but that only covers the time-to-first-byte:
      // fetch() resolves once headers arrive, so a slow SSE stream (stream:
      // true) can still outlive that timer while this pipe is mid-flight,
      // killing the persistent llama-server process out from under the
      // client. Reschedule once the response is actually done so the idle
      // window is measured from real completion, not dispatch time.
      res.on("close", () => activeLlamaServerRuntime.scheduleIdleShutdown());
      Readable.fromWeb(upstream.body).pipe(res);
    } catch (e) {
      res.status(502).json({ error: { message: e?.message || String(e) } });
    }
  });

  // POST /v1/embeddings — OpenAI-compatible embeddings endpoint (issue #95),
  // backed by the same local sentence-transformers embedder
  // (tools/local_embedder.py) Mana's own memory retriever uses. See
  // docs/API_KEYS.md for USE_EMBEDDINGS/RETRIEVER_EMBEDDER_* setup.
  app.post("/v1/embeddings", authMiddleware, async (req, res) => {
    const inputRaw = req.body && req.body.input;
    const inputs = Array.isArray(inputRaw) ? inputRaw : [inputRaw];
    if (!inputs.length || inputs.some((t) => typeof t !== "string" || !t)) {
      return res.status(400).json({
        error: { message: "input must be a string or array of non-empty strings" },
      });
    }
    try {
      const retrieverIndex = require("./tools/retriever-index");
      const embeddings = await retrieverIndex.computeEmbeddings(inputs);
      if (embeddings.some((e) => !Array.isArray(e))) {
        return res.status(503).json({
          error: {
            message:
              "Local embedder unavailable. Set USE_EMBEDDINGS=1 and run node-bot/tools/local_embedder.py (see docs/API_KEYS.md).",
          },
        });
      }
      res.json({
        object: "list",
        data: embeddings.map((embedding, index) => ({
          object: "embedding",
          embedding,
          index,
        })),
        model: process.env.RETRIEVER_EMBEDDER_MODEL || "all-MiniLM-L6-v2",
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    } catch (e) {
      res.status(500).json({ error: { message: e?.message || String(e) } });
    }
  });

  // GET /v1/models — OpenAI-compatible model list (issue #95): the chat
  // model llama-server would load for the default profile, plus the
  // embedding model the local embedder serves.
  app.get("/v1/models", authMiddleware, (req, res) => {
    const data = [];
    try {
      const chatModel = llamaServerRuntime.findLlamaModel("default");
      if (chatModel) {
        data.push({
          id: path.basename(chatModel),
          object: "model",
          created: 0,
          owned_by: "mana",
        });
      }
    } catch (e) {
      // No local chat model configured/found -- omit rather than fail the whole list.
    }
    data.push({
      id: process.env.RETRIEVER_EMBEDDER_MODEL || "all-MiniLM-L6-v2",
      object: "model",
      created: 0,
      owned_by: "mana",
    });
    res.json({ object: "list", data });
  });
}

module.exports = { registerOpenAiCompatRoutes };
