const path = require("node:path");

function pathImpl(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function parseAllowedPathList(value = "", platform = process.platform) {
  const p = pathImpl(platform);
  const separator = platform === "win32" ? ";" : ":";
  return String(value || "")
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => p.resolve(item));
}

function isInsideRoot(targetPath, rootPath, platform = process.platform) {
  const p = pathImpl(platform);
  const resolvedTarget = p.resolve(targetPath);
  const resolvedRoot = p.resolve(rootPath);
  const relativePath = p.relative(resolvedRoot, resolvedTarget);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !p.isAbsolute(relativePath))
  );
}

function createAcpPathGuard({
  workspacePath,
  allowedPaths = "",
  platform = process.platform,
} = {}) {
  const p = pathImpl(platform);
  const workspaceRoot = workspacePath ? p.resolve(workspacePath) : null;
  const allowedRoots = parseAllowedPathList(allowedPaths, platform);

  function resolveAllowedPath(targetPath) {
    if (!targetPath || typeof targetPath !== "string") {
      throw new Error("path is required");
    }

    const fullPath =
      workspaceRoot && !p.isAbsolute(targetPath)
        ? p.resolve(workspaceRoot, targetPath)
        : p.resolve(targetPath);

    if (workspaceRoot && isInsideRoot(fullPath, workspaceRoot, platform)) {
      return {
        allowed: true,
        fullPath,
        rootPath: workspaceRoot,
        rootType: "workspace",
      };
    }

    const matchedRoot = allowedRoots.find((root) =>
      isInsideRoot(fullPath, root, platform),
    );
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
