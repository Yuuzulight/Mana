const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

function defaultCommandResolver(command) {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [command], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });

  if (result.status !== 0) {
    return null;
  }

  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || null;
}

function normalizePositiveInteger(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return number;
}

function buildZedOpenTarget({ targetPath, line, column } = {}) {
  const cleanPath = typeof targetPath === "string" ? targetPath.trim() : "";
  if (!cleanPath) {
    throw new Error("path is required");
  }

  if (!fs.existsSync(cleanPath)) {
    throw new Error("path does not exist");
  }

  const normalizedLine = normalizePositiveInteger(line, "line");
  const normalizedColumn = normalizePositiveInteger(column, "column");
  if (!normalizedLine) {
    return cleanPath;
  }

  return normalizedColumn
    ? `${cleanPath}:${normalizedLine}:${normalizedColumn}`
    : `${cleanPath}:${normalizedLine}`;
}

function createZedIntegration(options = {}) {
  const env = options.env || process.env;
  const commandResolver = options.commandResolver || defaultCommandResolver;
  const spawnProcess = options.spawn || spawn;

  function getStatus() {
    const configuredBin = typeof env.ZED_BIN === "string" ? env.ZED_BIN.trim() : "";
    if (configuredBin) {
      if (fs.existsSync(configuredBin)) {
        return {
          available: true,
          command: configuredBin,
          source: "ZED_BIN",
          message: "Zed CLI is configured.",
        };
      }

      return {
        available: false,
        command: configuredBin,
        source: "ZED_BIN",
        message: "ZED_BIN is configured, but the file does not exist.",
      };
    }

    const pathCommand = commandResolver("zed");
    if (pathCommand) {
      return {
        available: true,
        command: pathCommand,
        source: "PATH",
        message: "Zed CLI is available on PATH.",
      };
    }

    return {
      available: false,
      command: null,
      source: "none",
      message: "Zed CLI was not found. Add zed to PATH or set ZED_BIN.",
    };
  }

  function open({ targetPath, line, column } = {}) {
    const status = getStatus();
    if (!status.available) {
      return Promise.reject(new Error(status.message));
    }

    const target = buildZedOpenTarget({ targetPath, line, column });
    return new Promise((resolve, reject) => {
      const child = spawnProcess(status.command, [target], {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });

      child.once("error", reject);
      child.once("spawn", () => {
        if (typeof child.unref === "function") {
          child.unref();
        }
        resolve({ opened: true, command: status.command, target });
      });
    });
  }

  return {
    getStatus,
    open,
  };
}

module.exports = {
  buildZedOpenTarget,
  createZedIntegration,
  defaultCommandResolver,
};
