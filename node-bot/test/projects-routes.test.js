const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createProjectsStore } = require('../projects-store');
const { registerProjectRoutes } = require('../routes/projects');
const { withServer } = require('./helpers');

test('project routes authenticate reads and writes, assign chats, and reject direct file paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-project-routes-'));
  try {
    const app = express();
    app.use(express.json());
    const projectsStore = createProjectsStore({ dataDir: dir });
    registerProjectRoutes(app, {
      projectsStore,
      checkAdminAuth(req, res) {
        if (req.get('authorization') === 'Bearer test') return true;
        res.status(401).json({ error: 'Unauthorized' });
        return false;
      },
    });
    await withServer(app, async base => {
      const headers = { authorization: 'Bearer test', 'content-type': 'application/json' };
      for (const [method, url] of [['GET', '/projects'], ['POST', '/projects'], ['DELETE', '/projects/alpha'], ['PUT', '/sessions/chat/project'], ['GET', '/sessions/chat/project']]) {
        assert.equal((await fetch(base + url, { method })).status, 401);
      }
      const create = await fetch(base + '/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'Alpha' }) });
      assert.equal(create.status, 200);
      const project = await create.json();
      const assign = await fetch(base + '/sessions/chat/project', { method: 'PUT', headers, body: JSON.stringify({ projectId: project.id }) });
      assert.equal((await assign.json()).project.id, project.id);
      for (const references of [[{ path: 'C:\\private.txt' }], { path: 'C:\\private.txt' }, null]) {
        assert.equal((await fetch(base + '/projects', { method: 'POST', headers, body: JSON.stringify({ name: 'Bad', references }) })).status, 400);
      }
      assert.equal(projectsStore.listProjects().length, 1);
      const remove = await fetch(base + `/projects/${project.id}`, { method: 'DELETE', headers });
      assert.equal((await remove.json()).deleted, true);
      assert.equal(projectsStore.projectForSession('chat'), null);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only a local authenticated picker bypasses the agent link approval workflow', async () => {
  const app = express();
  app.use(express.json());
  const calls = [];
  registerProjectRoutes(app, {
    projectsStore: {}, checkAdminAuth: () => true,
    isLocalAdminRequest: req => req.get('x-picker-test') === 'local',
    projectReferences: {
      attach: (...args) => { calls.push(['picker', ...args]); return { id: 'alpha' }; },
      requestLink: (...args) => { calls.push(['approval', ...args]); return { status: 'pending' }; },
    },
  });
  await withServer(app, async base => {
    const body = JSON.stringify({ path: 'C:\\Notes', sessionId: 'chat' });
    const headers = { 'content-type': 'application/json' };
    assert.equal((await fetch(base + '/projects/alpha/references/picker', { method: 'POST', headers, body })).status, 400);
    assert.equal(calls.length, 0);
    const agent = await fetch(base + '/projects/alpha/references', { method: 'POST', headers, body });
    assert.equal((await agent.json()).status, 'pending');
    await fetch(base + '/projects/alpha/references/picker', { method: 'POST', headers: { ...headers, 'x-picker-test': 'local' }, body });
    assert.deepEqual(calls.map(call => call[0]), ['approval', 'picker']);
  });
});
