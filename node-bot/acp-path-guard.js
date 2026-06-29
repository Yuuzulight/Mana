const path = require("node:path");

function parseAllowedPathList(value = "", platform = process.platform) {
  const separator = platform === "win32" ? ";" : ":";
  return String(value || "")
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function isInsideRoot(targetPath, rootPath) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootPath);
  const relativePath = path.relative(resolvedRoot, resolvedTarget);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function createAcpPathGuard({
  workspacePath,
  allowedPaths = "",
  platform = process.platform,
} = {}) {
  const workspaceRoot = workspacePath ? path.resolve(workspacePath) : null;
  const allowedRoots = parseAllowedPathList(allowedPaths, platform);

  function resolveAllowedPath(targetPath) {
    if (!targetPath || typeof targetPath !== "string") {
      throw new Error("path is required");
    }

    const fullPath =
      workspaceRoot && !path.isAbsolute(targetPath)
        ? path.resolve(workspaceRoot, targetPath)
        : path.resolve(targetPath);

    if (workspaceRoot && isInsideRoot(fullPath, workspaceRoot)) {
      return {
        allowed: true,
        fullPath,
        rootPath: workspaceRoot,
        rootType: "workspace",
      };
    }

    const matchedRoot = allowedRoots.find((root) => isInsideRoot(fullPath, root));
    if (matchedRoot) {
      return {
        allowed: true,
        fullPath,
        rootPath: matchedRoot,
        rootType: "allowed",
      };
    }

    throw new Error("path is outside the active workspace and allowed roots");
  }

  return {
    allowedRoots,
    resolveAllowedPath,
    workspaceRoot,
  };
}

module.exports = {
  createAcpPathGuard,
  isInsideRoot,
  parseAllowedPathList,
};
