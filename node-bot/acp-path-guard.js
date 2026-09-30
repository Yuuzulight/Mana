// #1004: the one containment check for the coding agent's file tools
// (Pipeline B's resolveWithinRepo, the editor workspace in
// zed-integration.js). A path must be inside the root both as written and
// as Windows would really open it (#1001's canonical: links, 8.3 names,
// trailing dots, case), so a junction inside the root can't lead out.
const path = require("node:path");
const { canonical } = require("./protected-paths");

function inside(target, root) {
  const rel = path.relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function isInsideRoot(targetPath, rootPath) {
  return (
    inside(path.resolve(targetPath), path.resolve(rootPath)) &&
    inside(canonical(targetPath), canonical(rootPath))
  );
}

module.exports = { isInsideRoot };
