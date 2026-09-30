// #1121: the chat rail's Terminal tool reads the commands Mana runs
// (terminal-feed.js). Read-only plus Stop; nothing can be started here.
// Every route needs my admin key: command lines and output can carry
// paths and project details.
const KEY = "terminal";

function registerTerminalRoutes(app, context = {}) {
  const feed = context.terminalFeed;
  const checkAdminAuth = context.checkAdminAuth;

  app.get("/terminal/runs", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json({ runs: feed.list() });
  });

  app.get("/terminal/runs/:id", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    const run = feed.get(req.params.id);
    if (!run) return res.status(404).json({ error: "no such run" });
    return res.json(run);
  });

  // Live events, one JSON object per line (same framing as /reply/stream):
  // {type:"start", run}, {type:"output", id, text}, {type:"end", id, exitCode, durationMs}.
  app.get("/terminal/stream", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    const unsubscribe = feed.subscribe((event) => res.write(JSON.stringify(event) + "\n"));
    res.on("close", unsubscribe);
  });

  // The editor's coding agent (mana-acp-agent.js, its own process) reports
  // the commands it runs here. A record only; nothing is started.
  app.post("/terminal/events", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    feed.ingest(req.body || {});
    return res.json({ ok: true });
  });

  // Goes through the stop path of whatever ran it: the chat tool loop's Stop
  // (the running command finishes, no later tool call runs) or self-work's.
  app.post("/terminal/runs/:id/stop", (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    return res.json(feed.stop(req.params.id));
  });
}

const terminalCapability = { key: KEY, registerRoutes: registerTerminalRoutes };

module.exports = { registerTerminalRoutes, terminalCapability };
