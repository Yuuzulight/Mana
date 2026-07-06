#!/usr/bin/env node
// Simple directory scanner CLI that prints JSON list of files (relative path, size, mtime)
// Usage: node tools/dir_scanner.js --path <dir> [--maxDepth N] [--ext .js,.py] [--exclude dirs]

const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { path: '.', maxDepth: 10, exts: null, exclude: [] };
  for (let i=0;i<args.length;i++){
    const a = args[i];
    if (a === '--path' && args[i+1]) { out.path = args[++i]; continue; }
    if (a === '--maxDepth' && args[i+1]) { out.maxDepth = Number(args[++i])||0; continue; }
    if (a === '--ext' && args[i+1]) { out.exts = args[++i].split(',').map(s=>s.trim().toLowerCase()).filter(Boolean); continue; }
    if (a === '--exclude' && args[i+1]) { out.exclude = args[++i].split(',').map(s=>s.trim()).filter(Boolean); continue; }
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

function scanDir(root, opts) {
  const results = [];
  const base = path.resolve(root);
  function walk(curr, depth) {
    if (depth < 0) return;
    let entries;
    try { entries = fs.readdirSync(curr, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(curr, ent.name);
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (isExcluded(rel, opts.exclude)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          results.push({ path: rel + '/', size: 0, mtime: stat.mtimeMs, isDir: true });
          walk(full, depth-1);
        } else if (stat.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (opts.exts && opts.exts.length && !opts.exts.includes(ext)) continue;
          results.push({ path: rel, size: stat.size, mtime: stat.mtimeMs, isDir: false });
        }
      } catch (e) {
        // ignore
      }
    }
  }
  walk(base, opts.maxDepth);
  return results;
}

if (require.main === module) {
  const opts = parseArgs();
  const list = scanDir(opts.path, opts);
  console.log(JSON.stringify(list));
}

module.exports = { scanDir };
