// Issue #272: ambient screen-sensing, off by default. A client (see
// windows-launcher's periodic glance loop) POSTs a screenshot on an
// interval; this route runs it through the same local vision model
// /vision/describe already uses, extracts a short text summary, and
// discards the image the moment the vision call returns -- the image
// string never gets assigned anywhere outside this request handler's own
// stack, let alone written to disk. Only the derived summary text (and
// only when the attention gate decides it's worth surfacing) leaves this
// module.
const { SUMMARY_PROMPT, createAttentionGate } = require("./screen-sensing");

function registerScreenSensingRoutes(app, deps = {}) {
  const runVisionReply = deps.runVisionReply;
  // One shared gate for the process's lifetime (created once here, not per
  // request) -- its whole point is comparing this glance against the
  // previous one.
  const attentionGate = deps.attentionGate || createAttentionGate();

  app.post("/screen-sensing/glance", async (req, res) => {
    const image = req.body?.image;
    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "image is required" });
    }
    const gamingModeActive = Boolean(req.body?.gamingModeActive);

    try {
      const rawSummary = await runVisionReply(SUMMARY_PROMPT, [image]);
      const summary = String(rawSummary || "").trim();
      const decision = attentionGate.decide(summary, { gamingModeActive });
      return res.json({
        shouldSurface: decision.shouldSurface,
        reason: decision.reason,
        ...(decision.shouldSurface ? { summary } : {}),
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message || String(e) });
    }
  });
}

module.exports = {
  key: "screenSensing",
  name: "Screen Sensing",
  category: "Vision",
  defaultEnabled: false,
  description:
    "Periodically glances at the screen (only while enabled and driven by an opt-in client-side timer), summarizes it with the local vision model, and discards the image immediately -- an attention gate skips near-duplicate glances, gaming mode, and enforces a cooldown between interruptions, only surfacing a proactive message when something genuinely worth mentioning changed.",
  registerRoutes: registerScreenSensingRoutes,
  createAttentionGate,
  SUMMARY_PROMPT,
  getHealth: () => ({
    status: "configured",
    configured: true,
    message: "Screen sensing is available (uses the same local vision model as /vision/describe).",
  }),
};
