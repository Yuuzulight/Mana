const { spawn } = require("node:child_process");

const DEFAULT_ALLOWED_COMMANDS = [
  "npm test",
  "npm run test",
  "node --test",
  "node --check",
];
const DISALLOWED_PATTERN =
  /\b(rm|del|erase|rmdir|remove-item|move-item|mv|git\s+reset|git\s+checkout|git\s+clean|format)\b/i;

function parseCommandLine(commandLine) {
  const parts = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(commandLine || ""))) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return {
    command: parts[0] || "",
    args: parts.slice(1),
  };
}

function normalizeCommand(commandLine) {
  return String(commandLine || "").trim().replace(/\s+/g, " ");
}

function isDisallowedCommand(commandLine) {
  return DISALLOWED_PATTERN.test(normalizeCommand(commandLine));
}

function createAcpTestRunner(options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const allowedCommands = new Set(
    (options.allowedCommands || DEFAULT_ALLOWED_COMMANDS).map(normalizeCommand),
  );
  const timeoutMs = Number(options.timeoutMs || 120000);

  function assertAllowed(commandLine) {
    const normalized = normalizeCommand(commandLine);
    if (!normalized || isDisallowedCommand(normalized) || !allowedCommands.has(normalized)) {
      throw new Error(`test command is not allowed: ${commandLine}`);
    }
    return normalized;
  }

  function run(commandLine, { cwd } = {}) {
    let normalized;
    try {
      normalized = assertAllowed(commandLine);
    } catch (error) {
      return Promise.reject(error);
    }
    const parsed = parseCommandLine(normalized);
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawnImpl(parsed.command, parsed.args, {
        cwd,
        shell: false,
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (typeof child.kill === "function") child.kill();
        reject(new Error(`test command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          command: normalized,
          exitCode,
          ok: exitCode === 0,
          stdout,
          stderr,
        });
      });
    });
  }

  return {
    allowedCommands: [...allowedCommands],
    assertAllowed,
    run,
    timeoutMs,
  };
}

module.exports = {
  DEFAULT_ALLOWED_COMMANDS,
  createAcpTestRunner,
  isDisallowedCommand,
  parseCommandLine,
};
