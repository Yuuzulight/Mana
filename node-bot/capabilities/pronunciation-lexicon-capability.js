// Item 2: user-editable CRUD surface for the pronunciation lexicon -- same
// shape as presets-capability.js (a plain list/add/patch/delete over its
// own JSON store).
const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");

const KEY = "pronunciationLexicon";

function registerPronunciationLexiconRoutes(app, context = {}) {
  const pronunciationLexiconStore = context.pronunciationLexiconStore;

  app.get("/pronunciation-lexicon", (req, res) => {
    try {
      return res.json({ words: pronunciationLexiconStore.listWords() });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });

  app.post("/pronunciation-lexicon", (req, res) => {
    try {
      const word = requireString(req.body?.word, "word");
      const replacement = requireString(req.body?.replacement, "replacement");
      const entry = pronunciationLexiconStore.addWord({ word, replacement });
      return res.status(201).json(entry);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.patch("/pronunciation-lexicon/:id", (req, res) => {
    try {
      const id = requireString(req.params?.id, "id");
      const updates = {};
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "word")) {
        updates.word = requireString(req.body.word, "word");
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "replacement")) {
        updates.replacement = requireString(req.body.replacement, "replacement");
      }
      const entry = pronunciationLexiconStore.updateWord(id, updates);
      if (!entry) {
        return res.status(404).json({ error: "pronunciation entry not found" });
      }
      return res.json(entry);
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(400).json({ error: e.message || String(e) });
    }
  });

  app.delete("/pronunciation-lexicon/:id", (req, res) => {
    try {
      const id = requireString(req.params?.id, "id");
      const deleted = pronunciationLexiconStore.removeWord(id);
      if (!deleted) {
        return res.status(404).json({ error: "pronunciation entry not found" });
      }
      return res.json({ deleted: true, id });
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendValidationError(res, e);
      }
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  });
}

const pronunciationLexiconCapability = {
  key: KEY,
  registerRoutes: registerPronunciationLexiconRoutes,
  getHealth: (context = {}) => {
    const pronunciationLexiconStore = context.pronunciationLexiconStore;
    const count = pronunciationLexiconStore ? pronunciationLexiconStore.listWords().length : 0;
    return {
      status: "configured",
      configured: true,
      message: `Pronunciation lexicon has ${count} word override(s).`,
      count,
    };
  },
};

module.exports = {
  registerPronunciationLexiconRoutes,
  pronunciationLexiconCapability,
};
