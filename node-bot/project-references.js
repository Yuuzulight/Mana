const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { wrapUntrusted } = require('./ai/untrusted-content');
const { searchEntries, tokenize, termFreq } = require('./tools/retriever-index');
const { extractDocument, chunkDocument } = require('../plugins/document-reader/document-extract');

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text', '.json', '.js', '.ts', '.tsx', '.jsx', '.cs', '.py', '.html', '.css', '.yaml', '.yml', '.toml', '.xml', '.csv']);
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'bin', 'obj', '.venv', '__pycache__']);
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_CHARS = 2 * 1024 * 1024;
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

function createProjectReferences({ projectsStore, approvalGate, extract = extractDocument }) {
  async function attach(projectId, filePath, expected = null) {
    if (!projectsStore.getProject(projectId)) throw new Error('Project not found');
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0') || filePath.length > 32768) throw new Error('Invalid reference path');
    const canonical = await fs.realpath(path.resolve(filePath));
    const stat = await fs.stat(canonical);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('Choose a file or folder');
    const kind = stat.isDirectory() ? 'folder' : 'file';
    if (expected && (canonical !== expected.canonical || kind !== expected.kind)) throw new Error('Reference target changed; request approval again');
    const extension = path.extname(canonical).toLowerCase();
    if (stat.isFile() && !TEXT_EXTENSIONS.has(extension) && !DOCUMENT_EXTENSIONS.has(extension)) throw new Error('Unsupported reference format');
    if (stat.isFile() && stat.size > MAX_BYTES) throw new Error('Reference file exceeds 64MB');
    // Resolve the path first, then update the latest state synchronously.
    const project = projectsStore.getProject(projectId);
    if (!project) throw new Error('Project was deleted');
    const references = project.references || [];
    if (references.some(ref => ref.path === canonical && ref.authorized)) return project;
    const retained = references.filter(ref => ref.path !== canonical);
    if (retained.length >= 20) throw new Error('A project can link at most 20 files or folders');
    return projectsStore.upsertProject({ id: projectId, references: [...retained, { id: randomUUID(), path: canonical, label: path.basename(canonical), kind, authorized: true }] });
  }

  approvalGate.registerExecutor('project-reference-link', ({ projectId, filePath, expected }) => attach(projectId, filePath, expected));

  async function requestLink(projectId, filePath, sessionId) {
    if (!projectsStore.getProject(projectId)) throw new Error('Project not found');
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0') || filePath.length > 32768) throw new Error('An absolute reference path is required');
    const canonical = await fs.realpath(filePath);
    const stat = await fs.stat(canonical);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('Choose a file or folder');
    const expected = { canonical, kind: stat.isDirectory() ? 'folder' : 'file' };
    return approvalGate.requestApproval('project-reference-link', {
      summary: `Link live project reference: ${filePath}`,
      payload: { projectId, filePath, expected }, forceReview: true,
      details: { projectId, filePath, canonical, kind: expected.kind, sessionId, access: 'Ongoing read access; folder links include future files' },
    });
  }

  function remove(projectId, referenceId) {
    const project = projectsStore.getProject(projectId);
    if (!project) throw new Error('Project not found');
    return projectsStore.upsertProject({ id: projectId, references: project.references.filter(ref => ref.id !== referenceId) });
  }

  async function search(sessionId, query) {
    const project = projectsStore.projectForSession(sessionId);
    if (!project) return { results: [], warnings: [] };
    const warnings = [];
    const candidates = [];
    const seen = new Set();
    let remainingBytes = MAX_BYTES;
    let remainingChars = MAX_CHARS;
    async function visit(file, root, ref) {
      if (candidates.length >= MAX_FILES || seen.size >= 10000) return;
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) return;
      if (file === root && ((ref.kind === 'folder' && !stat.isDirectory()) || (ref.kind !== 'folder' && !stat.isFile()))) throw new Error('Reference type changed; select it again');
      const canonical = await fs.realpath(file);
      if (!inside(root, canonical) || seen.has(canonical)) return;
      seen.add(canonical);
      if (stat.isDirectory()) {
        const directory = await fs.opendir(canonical);
        try {
          for await (const entry of directory) {
            if (candidates.length >= MAX_FILES || seen.size >= 10000) break;
            if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
              try { await visit(path.join(canonical, entry.name), root, ref); }
              catch (error) { warnings.push(`${ref.label}: ${error.message}`); }
            }
          }
        } finally { await directory.close().catch(() => {}); }
      } else if (stat.isFile() && (TEXT_EXTENSIONS.has(path.extname(canonical).toLowerCase()) || DOCUMENT_EXTENSIONS.has(path.extname(canonical).toLowerCase()))) {
        candidates.push({ file: canonical, root, ref });
      }
    }
    for (const ref of project.references || []) {
      if (!ref.authorized) { warnings.push(`${ref.label}: select this legacy reference again to authorize live access`); continue; }
      try {
        // The originally authorized canonical root must not become a link to elsewhere.
        if (await fs.realpath(ref.path) !== ref.path) throw new Error('Reference target changed; select it again');
        const rootStat = await fs.stat(ref.path);
        if ((ref.kind === 'folder' && !rootStat.isDirectory()) || (ref.kind !== 'folder' && !rootStat.isFile())) throw new Error('Reference type changed; select it again');
        await visit(ref.path, ref.path, ref);
      } catch (error) { warnings.push(`${ref.label}: ${error.message}`); }
    }
    let top = [];
    for (const candidate of candidates) {
      if (remainingBytes <= 0 || remainingChars <= 0) break;
      let handle;
      try {
        if (await fs.realpath(candidate.root) !== candidate.root || !inside(candidate.root, await fs.realpath(candidate.file))) continue;
        const expected = await fs.stat(candidate.file);
        handle = await fs.open(candidate.file, 'r');
        const before = await handle.stat();
        if (identity(expected) !== identity(before)) throw new Error('File changed before reading');
        if (!before.isFile() || before.size > remainingBytes) { warnings.push(`${candidate.ref.label}: file exceeds remaining indexing budget`); continue; }
        const buffer = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) throw new Error('File changed while reading');
          offset += bytesRead;
        }
        if (identity(before) !== identity(await handle.stat())) throw new Error('File changed while reading');
        if (await fs.realpath(candidate.root) !== candidate.root || !inside(candidate.root, await fs.realpath(candidate.file))) throw new Error('Reference target changed while reading');
        remainingBytes -= buffer.length;
        const extension = path.extname(candidate.file).toLowerCase();
        const text = (TEXT_EXTENSIONS.has(extension) ? buffer.toString('utf8') : (await extract(buffer, { filename: path.basename(candidate.file) })).text || '').slice(0, remainingChars);
        remainingChars -= text.length;
        const entries = chunkDocument(text, { maxChars: 1600, chunkSize: 1600, overlap: 200 }).map((snippet, index) => ({
          id: `${candidate.file}:${index}`, path: candidate.file, snippet,
          label: candidate.ref.kind === 'folder' ? `${candidate.ref.label}/${path.relative(candidate.root, candidate.file)}` : candidate.ref.label,
          tf: termFreq(tokenize(snippet)),
        }));
        const byId = new Map(entries.map(entry => [entry.id, entry]));
        const hits = searchEntries(query, entries, 5).map(hit => ({ ...hit, snippet: byId.get(hit.id).snippet, label: byId.get(hit.id).label }));
        top = [...top, ...hits].sort((a, b) => b.score - a.score).slice(0, 5);
      } catch (error) { warnings.push(`${candidate.ref.label}: ${error.message}`); }
      finally { await handle?.close(); }
    }
    if (candidates.length >= MAX_FILES || seen.size >= 10000 || remainingChars <= 0 || remainingBytes <= 0) warnings.push('Project indexing limit reached; narrow the linked folder');
    // A project may have been moved, deleted, or unlinked during extraction.
    const current = projectsStore.projectForSession(sessionId);
    if (current?.id !== project.id) return { results: [], warnings: [] };
    const authorized = new Set((current.references || []).filter(ref => ref.authorized).map(ref => ref.path));
    top = top.filter(hit => (project.references || []).some(ref => authorized.has(ref.path) && inside(ref.path, hit.path)));
    return { results: top, warnings: warnings.slice(0, 20) };
  }

  function toolSource(sessionId) {
    const schemas = projectsStore.projectForSession(sessionId) ? ['search', 'link'].map(action => ({ type: 'function', function: {
      name: `project_references__${action}`,
      description: action === 'search' ? 'Search current live references of this chat\'s project.' : 'Request user approval to link a live file or folder to this chat\'s project. Approval grants ongoing read access.',
      parameters: { type: 'object', properties: action === 'search' ? { query: { type: 'string' } } : { path: { type: 'string' } }, required: [action === 'search' ? 'query' : 'path'] },
    } })) : [];
    return {
      listToolSchemas: () => schemas,
      isKnownToolName: name => schemas.some(schema => schema.function.name === name),
      async executeTool(name, args = {}) {
        const project = projectsStore.projectForSession(sessionId);
        if (!project) throw new Error('This chat no longer belongs to a project');
        if (name === 'project_references__search') {
          if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 4000) throw new Error('A search query of at most 4000 characters is required');
          return wrapUntrusted('project references', JSON.stringify(await search(sessionId, args.query)));
        }
        if (name === 'project_references__link') return JSON.stringify(await requestLink(project.id, args.path, sessionId));
        throw new Error('Unknown project reference tool');
      },
    };
  }

  return { attach, requestLink, remove, search, toolSource };
}

module.exports = { createProjectReferences };
