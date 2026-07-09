#!/usr/bin/env node
// Simple directory scanner CLI that prints JSON list of files (relative path, size, mtime)
// Supports pagination and a lightweight index to speed repeated scans.
// Usage: node tools/dir_scanner.js --path <dir> [--maxDepth N] [--ext .js,.py] [--exclude dirs] [--limit N] [--offset N] [--useIndex 1]

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const INDEX_PATH = path.join(__dirname, "..", "data", "dir_index.json");
function ensureIndexDir() {
  try {
    fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  } catch (e) {}
}

function loadIndex() {
  try {
    if (!fs.existsSync(INDEX_PATH)) return {};
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8") || "{}");
  } catch (e) {
    return {};
  }
}
function saveIndex(idx) {
  try {
    ensureIndexDir();
    fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2), "utf8");
  } catch (e) {}
}

function computeFingerprint(files) {
  // files: array of {path,size,mtime}
  const sorted = files
    .map((f) => `${f.path}\0${f.size}\0${f.mtime}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(sorted).digest("hex");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    path: ".",
    maxDepth: 10,
    exts: null,
    exclude: [],
    limit: null,
    offset: 0,
    useIndex: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--path" && args[i + 1]) {
      out.path = args[++i];
      continue;
    }
    if (a === "--maxDepth" && args[i + 1]) {
      out.maxDepth = Number(args[++i]) || 0;
      continue;
    }
    if (a === "--ext" && args[i + 1]) {
      out.exts = args[++i]
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }
    if (a === "--exclude" && args[i + 1]) {
      out.exclude = args[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (a === "--limit" && args[i + 1]) {
      out.limit = Math.max(0, Number(args[++i]) || 0);
      continue;
    }
    if (a === "--offset" && args[i + 1]) {
      out.offset = Math.max(0, Number(args[++i]) || 0);
      continue;
    }
    if (a === "--useIndex" && args[i + 1]) {
      out.useIndex = String(args[++i]) === "1";
      continue;
    }
  }
  return out;
}

function isExcluded(p, excludes) {
  for (const ex of excludes) {
    if (!ex) continue;
    if (p.includes(ex)) return true;
  }
  return false;
}

function scanDirRecursive(root, opts) {
  const results = [];
  const base = path.resolve(root);
  function walk(curr, depth) {
    if (depth < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(curr, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(curr, ent.name);
      const rel = path.relative(base, full).split(path.sep).join("/");
      if (isExcluded(rel, opts.exclude)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          results.push({
            path: rel + "/",
            size: 0,
            mtime: stat.mtimeMs,
            isDir: true,
          });
          walk(full, depth - 1);
        } else if (stat.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (opts.exts && opts.exts.length && !opts.exts.includes(ext))
            continue;
          results.push({
            path: rel,
            size: stat.size,
            mtime: stat.mtimeMs,
            isDir: false,
          });
        }
      } catch (e) {
        // ignore
      }
    }
  }
  walk(base, opts.maxDepth);
  return results;
}

function buildIndexForRoot(root, opts) {
  // Build a comprehensive index and fingerprint of files (path,size,mtime)
  const resolved = path.resolve(root);
  let dirStat = null;
  try {
    dirStat = fs.statSync(resolved);
  } catch (e) {}
  const dirMtime = dirStat ? dirStat.mtimeMs : Date.now();
  const files = scanDirRecursive(root, opts);
  const fingerprint = computeFingerprint(
    files.map((f) => ({
      path: f.path,
      size: f.size || 0,
      mtime: f.mtime || 0,
    })),
  );
  return { scannedAt: Date.now(), dirMtime, fingerprint, files };
}

function paginate(list, offset = 0, limit = null) {
  const total = list.length;
  if (offset >= total)
    return { items: [], offset, limit: limit || total, total };
  if (limit === null || limit <= 0)
    return { items: list.slice(offset), offset, limit: null, total };
  return { items: list.slice(offset, offset + limit), offset, limit, total };
}

function scanDir(root, opts) {
  // opts: {path, maxDepth, exts, exclude, limit, offset, useIndex}
  const resolvedRoot = path.resolve(root);
  const idxKey = resolvedRoot;
  let list = null;
  let fingerprint = null;
  if (opts.useIndex) {
    const idx = loadIndex();
    const existing = idx[idxKey];
    try {
      const st = fs.statSync(resolvedRoot);
      const dirMtime = st.mtimeMs;
      if (existing && existing.dirMtime === dirMtime && existing.fingerprint) {
        // likely unchanged
        list = existing.files;
        fingerprint = existing.fingerprint;
      } else {
        const built = buildIndexForRoot(resolvedRoot, opts);
        idx[idxKey] = built;
        saveIndex(idx);
        list = built.files;
        fingerprint = built.fingerprint;
      }
    } catch (e) {
      // fallback to fresh scan
      list = scanDirRecursive(resolvedRoot, opts);
      fingerprint = computeFingerprint(
        list.map((f) => ({
          path: f.path,
          size: f.size || 0,
          mtime: f.mtime || 0,
        })),
      );
    }
  } else {
    list = scanDirRecursive(resolvedRoot, opts);
    fingerprint = computeFingerprint(
      list.map((f) => ({
        path: f.path,
        size: f.size || 0,
        mtime: f.mtime || 0,
      })),
    );
  }

  // Apply extension/exclude filters again to be safe
  if (opts.exts && opts.exts.length) {
    list = list.filter(
      (i) => i.isDir || opts.exts.includes(path.extname(i.path).toLowerCase()),
    );
  }
  if (opts.exclude && opts.exclude.length) {
    list = list.filter((i) => !isExcluded(i.path, opts.exclude));
  }

  // Sort deterministic
  list.sort((a, b) => a.path.localeCompare(b.path));

  // Pagination
  const offset = Math.max(0, Number(opts.offset || 0));
  const limit =
    opts.limit && Number(opts.limit) > 0 ? Number(opts.limit) : null;
  const total = list.length;
  const items =
    limit === null ? list.slice(offset) : list.slice(offset, offset + limit);
  let nextToken = null;
  const nextOffset = offset + items.length;
  if (nextOffset < total) {
    const tokenObj = {
      root: resolvedRoot,
      offset: nextOffset,
      limit: limit,
      fingerprint,
    };
    nextToken = Buffer.from(JSON.stringify(tokenObj), "utf8").toString(
      "base64",
    );
  }

  // Backwards-compatible return value:
  // - older callers expect an array of items
  // - newer callers expect an object { items, total, nextToken }
  // To satisfy both, return the items array but attach metadata properties
  // so callers can treat the result as an array or inspect .total/.nextToken.
  const out = items;
  try {
    Object.defineProperty(out, "total", {
      value: total,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(out, "nextToken", {
      value: nextToken,
      enumerable: false,
      writable: false,
    });
  } catch (e) {
    // ignore failures attaching properties
  }
  return out;
}

if (require.main === module) {
  const opts = parseArgs();
  const list = scanDir(opts.path, opts);
  console.log(JSON.stringify(list));
}

module.exports = { scanDir, buildIndexForRoot, loadIndex };
