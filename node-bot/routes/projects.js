function registerProjectRoutes(app, { projectsStore, projectReferences, checkAdminAuth, isLocalAdminRequest }) {
  function route(method, url, handler) {
    app[method](url, async (req, res) => {
      if (!checkAdminAuth(req, res)) return;
      try { res.json(await handler(req)); }
      catch (error) { res.status(400).json({ error: error.message }); }
    });
  }
  route('get', '/projects', () => ({ projects: projectsStore.listProjects() }));
  route('post', '/projects', req => {
    if (req.body?.references !== undefined && (!Array.isArray(req.body.references) || req.body.references.length)) throw new Error('Attach reference files through the import workflow');
    return projectsStore.upsertProject({ id: req.body?.id, name: req.body?.name, instructions: req.body?.instructions });
  });
  route('delete', '/projects/:id', req => ({ deleted: projectsStore.deleteProject(req.params.id) }));
  route('put', '/sessions/:id/project', req => ({ sessionId: req.params.id, project: projectsStore.assignSession(req.params.id, req.body?.projectId ?? null) }));
  route('get', '/sessions/:id/project', req => ({ sessionId: req.params.id, project: projectsStore.projectForSession(req.params.id) }));
  if (projectReferences) {
    route('post', '/projects/:id/references', req => projectReferences.requestLink(req.params.id, req.body?.path, req.body?.sessionId));
    route('post', '/projects/:id/references/picker', req => {
      if (!isLocalAdminRequest?.(req)) throw new Error('Local authenticated picker access is required');
      return projectReferences.attach(req.params.id, req.body?.path);
    });
    route('delete', '/projects/:id/references/:referenceId', req => projectReferences.remove(req.params.id, req.params.referenceId));
    route('get', '/sessions/:id/project/search', req => {
      if (typeof req.query.q !== 'string' || !req.query.q.trim() || req.query.q.length > 4000) throw new Error('A search query of at most 4000 characters is required');
      return projectReferences.search(req.params.id, req.query.q);
    });
  }
}

module.exports = { registerProjectRoutes };
