const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Issue #422: acp-test-runner.js ran allowlisted test commands directly
// against the live workspace -- a test with side effects (writes temp
// files, mutates fixtures) could corrupt the actual working tree mid-review.
// Same exclusion set as zed-integration.js's DEFAULT_INSPECTOR_EXCLUDES --
// heavy/generated directories that either shouldn't be duplicated (build
// output, VCS metadata) or can't usefully be duplicated (node_modules is
// junctioned instead, see below).
const DEFAULT_SCRATCH_EXCLUDES = new Set([
  ".git",
  ".next",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp",
]);

// Finds every directory literally named "node_modules" under root, at any
// depth (REPO_ROOT is typically the monorepo root, one level above the
// actual node-bot/node_modules -- a top-level-only check would miss it
// entirely). Does not descend into a found node_modules (nested dependency
// trees don't need their own separate junction -- a junction to the outer
// one already makes everything under it resolvable) or into any other
// excluded directory (no point walking .git/dist/etc. looking for one).
function findNodeModulesDirs(root, excludes, readdirSync) {
  const found = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules") {
        found.push(path.join(dir, entry.name));
        continue;
      }
      if (excludes.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  }
  walk(root);
  return found;
}

// Copies sourceRoot into a fresh temp directory, excluding heavy/generated
// directories, and junctions every node_modules found (at any depth) back
// to the real one rather than copying it -- tests need real installed
// dependencies to actually run, and re-copying a potentially multi-GB
// dependency tree on every call would defeat the point of this being a
// cheap per-call safety measure. Tests aren't expected to mutate their own
// dependencies, so sharing this directory back to the live tree doesn't
// reintroduce the risk this issue is about (a test run corrupting *source*
// files/fixtures). Verified directly (not assumed) that a recursive rmSync
// on the returned scratch directory only removes each junction link, never
// the real node_modules contents, before relying on that in
// removeScratchWorkspaceCopy.
function createScratchWorkspaceCopy(sourceRoot, options = {}) {
  const excludes = options.excludes || DEFAULT_SCRATCH_EXCLUDES;
  const mkdtemp =
    options.mkdtemp ||
    (() => fs.mkdtempSync(path.join(os.tmpdir(), "mana-test-scratch-")));
  const cp = options.cp || fs.cpSync;
  const symlink = options.symlink || fs.symlinkSync;
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const readdirSync = options.readdirSync || fs.readdirSync;

  const scratchDir = mkdtemp();
  cp(sourceRoot, scratchDir, {
    recursive: true,
    filter: (src) => !excludes.has(path.basename(src)),
  });

  for (const sourceNodeModules of findNodeModulesDirs(sourceRoot, excludes, readdirSync)) {
    const relative = path.relative(sourceRoot, sourceNodeModules);
    const scratchNodeModules = path.join(scratchDir, relative);
    // cpSync's filter never visits a directory that contains only a
    // node_modules subfolder and nothing else copyable, so the parent
    // may not exist in the scratch copy yet.
    mkdirSync(path.dirname(scratchNodeModules), { recursive: true });
    symlink(sourceNodeModules, scratchNodeModules, "junction");
  }

  return scratchDir;
}

// Best-effort: a leftover temp dir under os.tmpdir() is a nuisance, not a
// correctness problem, and a Windows file-lock from an antivirus scan or a
// lingering test process must never fail the test result the caller
// already has in hand.
function removeScratchWorkspaceCopy(scratchDir, options = {}) {
  const rm = options.rm || fs.rmSync;
  try {
    rm(scratchDir, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }
}

module.exports = {
  DEFAULT_SCRATCH_EXCLUDES,
  findNodeModulesDirs,
  createScratchWorkspaceCopy,
  removeScratchWorkspaceCopy,
};
