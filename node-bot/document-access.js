const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BYTES = 64 * 1024 * 1024;
const GRANT_TTL_MS = 5 * 60 * 1000;
const MAX_REQUESTS = 16;
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

function createDocumentAccess({ approvalGate, fileSystem = fs, now = Date.now } = {}) {
  const requests = new Map();
  const byKey = new Map();

  function forget(record) {
    requests.delete(record.nonce);
    byKey.delete(record.key);
  }

  approvalGate.registerExecutor('document-read', async ({ nonce } = {}) => {
    const record = requests.get(nonce);
    if (!record || record.approved) throw new Error('Document approval is no longer pending');
    const canonical = await fileSystem.realpath(record.filePath);
    const stat = await fileSystem.stat(canonical);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Document must be a file no larger than 64MB');
    record.approved = { canonical, identity: fingerprint(stat), size: stat.size, expires: now() + GRANT_TTL_MS };
    return { ok: true, fileName: path.basename(canonical), purpose: record.purpose };
  });

  async function authorize(filePath, { sessionId = '', purpose = 'chat' } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.length > 32768 || filePath.includes('\0')) {
      throw new Error('A valid document path is required');
    }
    if (typeof sessionId !== 'string' || sessionId.length > 256 || typeof purpose !== 'string') throw new Error('Invalid document approval scope');
    const normalized = path.resolve(filePath.trim());
    const key = JSON.stringify([sessionId, purpose, normalized]);
    const pending = new Set(approvalGate.listPending().map(entry => entry.id));
    for (const record of requests.values()) {
      if (record.approved ? record.approved.expires <= now() : record.requestId && !pending.has(record.requestId)) forget(record);
    }
    const existing = byKey.get(key);
    if (existing?.approved) {
      forget(existing);
      const grant = existing.approved;
      // Validate the opened file, not just its name, so replacing an approved
      // path or symlink cannot redirect the grant to different content.
      const handle = await fileSystem.open(grant.canonical, 'r');
      try {
        if (fingerprint(await handle.stat()) !== grant.identity) throw new Error('Document changed; approval is required again');
        const buffer = Buffer.alloc(grant.size);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) throw new Error('Document changed while reading');
          offset += bytesRead;
        }
        if (fingerprint(await handle.stat()) !== grant.identity) throw new Error('Document changed while reading');
        return { status: 'approved', buffer, filename: path.basename(grant.canonical), sourceLabel: grant.canonical };
      } finally {
        await handle.close();
      }
    }
    if (existing) return { status: 'pending', requestId: existing.requestId };
    if (requests.size >= MAX_REQUESTS) throw new Error('Too many pending document approvals');
    const record = { nonce: randomUUID(), key, filePath: normalized, purpose };
    requests.set(record.nonce, record);
    byKey.set(key, record);
    try {
      const result = await approvalGate.requestApproval('document-read', {
        summary: `Read document for ${purpose}: ${normalized}`,
        payload: { nonce: record.nonce },
        forceReview: true,
        details: { filePath: normalized, sessionId, purpose },
      });
      record.requestId = result.requestId;
      if (result.status !== 'pending') forget(record);
      return result;
    } catch (error) {
      forget(record);
      throw error;
    }
  }

  return { authorize };
}

module.exports = { createDocumentAccess };
