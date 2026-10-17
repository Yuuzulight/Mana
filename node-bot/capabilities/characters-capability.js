// Issue #914: list the characters and switch the active one -- from the
// tray (POST /characters/active) or from chat ("let Evil Mana talk"), where
// the new character's handoff line is the reply, spoken in her voice.
// Group mode (a partner replying too) is toggled the same two ways:
// POST /characters/group or "group mode on" / "let Evil Mana join".
const rateLimit = require("express-rate-limit");
const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");
const { CharacterError, handoffLine } = require("../characters");
const { stripEmotionTags } = require("../utils/emotion-tags");

const KEY = "characters";

// #1426: server.js's app-wide limiter already covers these, but CodeQL
// can't see through registerRoutes, so the editor's admin routes carry
// their own (as memory-facts-capability.js's do).
const adminCharactersRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.MANA_RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
});

// What a client needs: no persona or voice, only the model the launcher loads.
const summary = (c) => ({ id: c.id, name: c.name, live2dModel: c.live2dModel });

function createCharactersCapability(characters) {
  return {
    key: KEY,
    registerRoutes(app, context = {}) {
      // #1426: Settings' character editor -- the prompts themselves, so
      // admin-only, unlike the list above.
      const admin = (req, res) => (context.checkAdminAuth ? context.checkAdminAuth(req, res) : true);
      const fail = (res, e) => {
        if (e instanceof CharacterError) return res.status(400).json({ error: e.message });
        console.error(e);
        return res.status(500).json({ error: String(e) });
      };
      const id = (req) => String(req.params.id || "").trim().toLowerCase();

      app.get("/admin/characters", adminCharactersRateLimiter, (req, res) => {
        if (!admin(req, res)) return;
        try {
          return res.json({ active: characters.active().id, characters: characters.editable() });
        } catch (e) {
          return fail(res, e);
        }
      });

      app.post("/admin/characters", adminCharactersRateLimiter, (req, res) => {
        if (!admin(req, res)) return;
        try {
          return res.json({ character: summary(characters.saveCharacter(null, req.body || {})) });
        } catch (e) {
          return fail(res, e);
        }
      });

      app.put("/admin/characters/:id", adminCharactersRateLimiter, (req, res) => {
        if (!admin(req, res)) return;
        try {
          const saved = characters.saveCharacter(id(req), req.body || {});
          if (!saved) return res.status(404).json({ error: "unknown character" });
          return res.json({ character: summary(saved) });
        } catch (e) {
          return fail(res, e);
        }
      });

      // A built-in's prompt back to the original.
      app.post("/admin/characters/:id/reset", adminCharactersRateLimiter, (req, res) => {
        if (!admin(req, res)) return;
        try {
          const reset = characters.resetPrompt(id(req));
          if (!reset) return res.status(400).json({ error: "only a built-in character's prompt can be reset" });
          return res.json({ character: summary(reset) });
        } catch (e) {
          return fail(res, e);
        }
      });

      // A character I added, with her notes and milestones; built-ins stay.
      app.delete("/admin/characters/:id", adminCharactersRateLimiter, (req, res) => {
        if (!admin(req, res)) return;
        try {
          if (!characters.removeCharacter(id(req))) {
            return res.status(characters.get(id(req)) ? 400 : 404).json({ error: characters.get(id(req)) ? "built-in characters can't be deleted" : "unknown character" });
          }
          return res.json({ ok: true });
        } catch (e) {
          return fail(res, e);
        }
      });

      app.get("/characters", (req, res) => {
        try {
          return res.json({
            active: characters.active().id,
            characters: characters.list().map(summary),
            group: characters.groupState(),
          });
        } catch (e) {
          console.error(e);
          return res.status(500).json({ error: String(e) });
        }
      });

      app.post("/characters/active", (req, res) => {
        try {
          const switched = characters.setActive(requireString(req.body?.id, "id"));
          if (!switched) return res.status(404).json({ error: "unknown character" });
          const { character, previous } = switched;
          return res.json({
            character: summary(character),
            // The launcher speaks this as is, so a tag in a custom handoff line
            // ("[sad] ...") would be read out; it goes, and the launcher's own
            // handoff emotion stays. ponytail: pass the tag's emotion along if wanted.
            handoff: character.id === previous.id ? null : stripEmotionTags(handoffLine(character, previous)).text,
          });
        } catch (e) {
          if (e instanceof ValidationError) return sendValidationError(res, e);
          console.error(e);
          return res.status(500).json({ error: String(e) });
        }
      });

      // Group mode on or off: {on, partner}. partner is optional (the last
      // one, else the first character who isn't active).
      app.post("/characters/group", (req, res) => {
        try {
          if (typeof req.body?.on !== "boolean") throw new ValidationError("on must be true or false");
          const partner = req.body?.partner == null ? null : requireString(req.body.partner, "partner");
          const group = characters.setGroup(req.body.on, partner);
          if (!group) return res.status(404).json({ error: "unknown partner, or it's the active character" });
          return res.json({ group });
        } catch (e) {
          if (e instanceof ValidationError) return sendValidationError(res, e);
          console.error(e);
          return res.status(500).json({ error: String(e) });
        }
      });
    },
    onUserInput(input) {
      const groupRequest = characters.findGroupRequest(input.text);
      if (groupRequest) {
        if (!groupRequest.on) {
          characters.setGroup(false);
          return { reply: "Okay, just me again~" };
        }
        const group = characters.setGroup(true, groupRequest.partner);
        const partner = group && characters.get(group.partner);
        return { reply: partner ? `Okay, ${partner.name} is joining us~` : "There's nobody else to bring in yet." };
      }
      const target = characters.findSwitchRequest(input.text);
      if (!target) return null;
      const { character, previous } = characters.setActive(target.id);
      return { reply: handoffLine(character, previous) };
    },
  };
}

module.exports = { createCharactersCapability };
