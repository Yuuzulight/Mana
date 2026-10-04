const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require('node:crypto');

const MAX_NAME = 120;
const MAX_INSTRUCTIONS = 8000;
const MAX_REFERENCES = 20;

function cleanText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanBlock(value, max) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim()
    .slice(0, max);
}

function projectIdFrom(name) {
  const base = cleanText(name, MAX_NAME)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `project-${Date.now().toString(36)}`;
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) throw new Error('Project data is empty');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read project data: ${error.message}`);
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

function normalizeReference(ref = {}) {
  const label = cleanText(ref.label || path.basename(String(ref.path || "")), MAX_NAME);
  const filePath = String(ref.path || "").trim();
  if (!filePath) return null;
  return { id: ref.id || randomUUID(), label: label || path.basename(filePath), path: filePath, kind: ref.kind || 'file', authorized: ref.authorized === true };
}

function createProjectsStore(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, "data");
  const filePath = options.filePath || path.join(dataDir, "projects.json");
  const now = options.now || (() => new Date().toISOString());
  const validId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,119}$/.test(id) && !['constructor', 'prototype'].includes(id);

  function state() {
    const parsed = readJson(filePath, {});
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid project data');
    for (const key of ['projects', 'sessions']) {
      if (parsed[key] !== undefined && (!parsed[key] || typeof parsed[key] !== 'object' || Array.isArray(parsed[key]))) throw new Error('Invalid project data');
    }
    for (const [id, project] of Object.entries(parsed.projects || {})) {
      if (!validId(id) || !project || project.id !== id || typeof project.name !== 'string' || (project.references !== undefined && !Array.isArray(project.references))) throw new Error('Invalid project data');
    }
    return {
      projects: Object.assign(Object.create(null), parsed.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects) ? parsed.projects : {}),
      sessions: Object.assign(Object.create(null), parsed.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions) ? parsed.sessions : {}),
    };
  }

  function save(next) {
    writeJson(filePath, next);
    return next;
  }

  function listProjects() {
    return Object.values(state().projects).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function getProject(projectId) {
    if (!validId(projectId)) return null;
    return state().projects[String(projectId || "")] || null;
  }

  function upsertProject(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid project');
    if (input.id !== undefined && !validId(input.id)) throw new Error('Invalid project ID');
    if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > MAX_NAME)) throw new Error('Project name must be at most 120 characters');
    if (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > MAX_INSTRUCTIONS)) throw new Error('Instructions must be at most 8000 characters');
    const current = state();
    const existing = input.id ? current.projects[String(input.id)] : null;
    let id = existing?.id || input.id || projectIdFrom(input.name);
    if (!validId(id)) id = `project-${randomUUID()}`;
    if (!input.id && current.projects[id]) id = `${id.slice(0, 80)}-${randomUUID()}`;
    const name = cleanText(input.name ?? existing?.name, MAX_NAME);
    if (!name) throw new Error("name is required");
    const references = (Array.isArray(input.references) ? input.references : existing?.references || [])
      .map(normalizeReference)
      .filter(Boolean)
      .slice(0, MAX_REFERENCES);
    const project = {
      id,
      name,
      instructions: cleanBlock(input.instructions ?? existing?.instructions, MAX_INSTRUCTIONS),
      references,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
    };
    current.projects[id] = project;
    save(current);
    return project;
  }

  function deleteProject(projectId) {
    if (!validId(projectId)) return false;
    const current = state();
    const id = String(projectId || "");
    if (!current.projects[id]) return false;
    delete current.projects[id];
    for (const [sessionId, assigned] of Object.entries(current.sessions)) {
      if (assigned === id) current.sessions[sessionId] = null;
    }
    save(current);
    return true;
  }

  function assignSession(sessionId, projectId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.trim() !== sessionId || sessionId.length > 240) throw new Error('Invalid session ID');
    if (projectId !== null && projectId !== undefined && projectId !== '' && !validId(projectId)) throw new Error('Invalid project ID');
    const current = state();
    const cleanSessionId = sessionId;
    if (!cleanSessionId) throw new Error("sessionId is required");
    const id = cleanText(projectId, 120);
    if (!id) {
      current.sessions[cleanSessionId] = null;
      save(current);
      return null;
    }
    if (!current.projects[id]) throw new Error("project not found");
    current.sessions[cleanSessionId] = id;
    save(current);
    return current.projects[id];
  }

  function projectForSession(sessionId) {
    const current = state();
    const visited = new Set();
    let source = typeof sessionId === 'string' && sessionId.length <= 240 ? sessionId : '';
    while (source && !visited.has(source) && visited.size < 100) {
      visited.add(source);
      if (Object.hasOwn(current.sessions, source)) return current.projects[current.sessions[source]] || null;
      source = options.getSession?.(source)?.forkedFrom;
    }
    return null;
  }

  function promptBlockForSession(sessionId) {
    const project = projectForSession(sessionId);
    if (!project) return "";
    const parts = [`Project: ${project.name}`];
    if (project.instructions) parts.push(`Standing instructions:\n${project.instructions}`);
    return parts.join("\n\n");
  }

  return {
    assignSession,
    deleteProject,
    getProject,
    listProjects,
    projectForSession,
    promptBlockForSession,
    upsertProject,
  };
}

module.exports = { createProjectsStore };
