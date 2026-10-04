const { requireString, optionalString } = require('../request-validation');

function registerChatModelRoutes(app, { modelManagement, acpMemoryStore, checkAdminAuth }) {
  app.get('/models/chat', (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const sessionId = optionalString(req.query.sessionId, 'sessionId');
      if (sessionId.length > 240) throw new Error('Invalid sessionId');
      const session = sessionId ? acpMemoryStore.getSession(sessionId) : null;
      res.json({ models: modelManagement.getChatModels(), selected: session?.chatModel || 'automatic' });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/models/chat', (req, res) => {
    if (!checkAdminAuth(req, res)) return;
    try {
      const sessionId = requireString(req.body?.sessionId, 'sessionId');
      const model = requireString(req.body?.model, 'model');
      modelManagement.resolveChatModel(model);
      acpMemoryStore.setSessionChatModel(sessionId, model);
      res.json({ selected: model });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
}

module.exports = { registerChatModelRoutes };
