// Issue #914: list the characters and switch the active one -- from the
// tray (POST /characters/active) or from chat ("let Evil Mana talk"), where
// the new character's handoff line is the reply, spoken in her voice.
const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");
const { handoffLine } = require("../characters");

const KEY = "characters";

// What a client needs: no persona or voice, only the model the launcher loads.
const summary = (c) => ({ id: c.id, name: c.name, live2dModel: c.live2dModel });

function createCharactersCapability(characters) {
  return {
    key: KEY,
    registerRoutes(app) {
      app.get("/characters", (req, res) => {
        try {
          return res.json({ active: characters.active().id, characters: characters.list().map(summary) });
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
            handoff: character.id === previous.id ? null : handoffLine(character, previous),
          });
        } catch (e) {
          if (e instanceof ValidationError) return sendValidationError(res, e);
          console.error(e);
          return res.status(500).json({ error: String(e) });
        }
      });
    },
    onUserInput(input) {
      const target = characters.findSwitchRequest(input.text);
      if (!target) return null;
      const { character, previous } = characters.setActive(target.id);
      return { reply: handoffLine(character, previous) };
    },
  };
}

module.exports = { createCharactersCapability };
