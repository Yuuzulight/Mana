// Issue #914: each character's relationship notes and milestones -- listed,
// edited and removed from the launcher's Settings, and forgotten from chat
// ("forget that", "forget the note about pizza"). Only my own message
// counts: this is an input hook, never something the model or a page can
// trigger.
const {
  ValidationError,
  requireString,
  sendValidationError,
} = require("../request-validation");
const { findForgetRequest } = require("../relationship-store");

const KEY = "relationship";

// characters: the character store; storeFor(id): that character's
// relationship store.
function createRelationshipCapability(characters, storeFor) {
  // The route's character, or a 404 sent (null).
  function characterOf(req, res) {
    const character = characters.get(String(req.params.id || "").toLowerCase());
    if (!character) res.status(404).json({ error: "unknown character" });
    return character;
  }

  const handle = (fn) => (req, res) => {
    try {
      return fn(req, res);
    } catch (e) {
      if (e instanceof ValidationError) return sendValidationError(res, e);
      console.error(e);
      return res.status(500).json({ error: String(e) });
    }
  };

  return {
    key: KEY,
    registerRoutes(app) {
      app.get(
        "/characters/relationships",
        handle((req, res) =>
          res.json({
            characters: characters.list().map((c) => ({
              id: c.id,
              name: c.name,
              notes: storeFor(c.id).list(),
              milestones: storeFor(c.id).milestones(),
            })),
          }),
        ),
      );

      app.put(
        "/characters/:id/relationship/notes/:noteId",
        handle((req, res) => {
          const character = characterOf(req, res);
          if (!character) return undefined;
          const note = storeFor(character.id).update(req.params.noteId, requireString(req.body?.text, "text"));
          return note ? res.json({ note }) : res.status(404).json({ error: "unknown note" });
        }),
      );

      app.delete(
        "/characters/:id/relationship/notes/:noteId",
        handle((req, res) => {
          const character = characterOf(req, res);
          if (!character) return undefined;
          const removed = storeFor(character.id).remove(req.params.noteId);
          return removed ? res.json({ removed }) : res.status(404).json({ error: "unknown note" });
        }),
      );

      // {text?, date? ("YYYY-MM-DD")}
      app.put(
        "/characters/:id/relationship/milestones/:milestoneId",
        handle((req, res) => {
          const character = characterOf(req, res);
          if (!character) return undefined;
          const { text, date } = req.body || {};
          if (text === undefined && date === undefined) throw new ValidationError("text or date is required");
          if (text !== undefined) requireString(text, "text");
          if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new ValidationError("date must be YYYY-MM-DD");
          const milestone = storeFor(character.id).updateMilestone(req.params.milestoneId, { text, date });
          return milestone ? res.json({ milestone }) : res.status(404).json({ error: "unknown milestone, or not a real date" });
        }),
      );

      app.delete(
        "/characters/:id/relationship/milestones/:milestoneId",
        handle((req, res) => {
          const character = characterOf(req, res);
          if (!character) return undefined;
          const removed = storeFor(character.id).removeMilestone(req.params.milestoneId);
          return removed ? res.json({ removed }) : res.status(404).json({ error: "unknown milestone" });
        }),
      );
    },
    onUserInput(input) {
      const request = findForgetRequest(input.text);
      if (!request) return null;
      const removed = storeFor(characters.active().id).forget(request.query);
      if (!removed.length) {
        // A bare "forget that" with no fresh note may mean something else
        // (a memory fact): the reply handles it as usual.
        return request.query ? { reply: "I don't have a note or milestone about that." } : null;
      }
      return { reply: `Okay, I forgot: ${removed.map((n) => `"${n.text}"`).join(", ")}` };
    },
  };
}

module.exports = { createRelationshipCapability };
