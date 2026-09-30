"use strict";

// Plugins live outside node-bot, so a bare require("some-package") from
// plugins/ never finds node-bot's node_modules. Every package a plugin
// loads must resolve from the plugin's own folder.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { builtinModules } = require("module");

const PLUGINS = path.join(__dirname, "..", "..", "plugins");

// Not checked: the Obsidian plugin gets `obsidian` from the Obsidian app.
const SKIP_DIRS = new Set(["node_modules", "test", "obsidian-plugin"]);

// Known broken, tracked separately. Remove an entry once it's fixed.
const KNOWN = new Set([
  "document-reader/document-reader.js pdf-parse", // not a node-bot dependency yet
]);

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : jsFiles(path.join(dir, entry.name));
    return entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : [];
  });
}

function isBuiltin(name) {
  return name.startsWith("node:") || builtinModules.includes(name.split("/")[0]);
}

test("every package a plugin requires resolves from the plugin's folder", () => {
  const broken = [];
  for (const file of jsFiles(PLUGINS)) {
    const source = fs.readFileSync(file, "utf8");
    for (const [, name] of source.matchAll(/require\(\s*["']([^"'.][^"']*)["']\s*\)/g)) {
      if (isBuiltin(name)) continue;
      const key = `${path.relative(PLUGINS, file).split(path.sep).join("/")} ${name}`;
      if (KNOWN.has(key)) continue;
      try {
        require.resolve(name, { paths: [path.dirname(file)] });
      } catch {
        broken.push(key);
      }
    }
  }
  assert.deepEqual(broken, [], "point these at ../../node-bot/node_modules/<package>");
});

test("the discord bot's packages resolve", () => {
  const dir = path.join(PLUGINS, "discord-bot");
  for (const name of ["@discordjs/voice", "prism-media", "discord.js"]) {
    assert.ok(require.resolve(`../../node-bot/node_modules/${name}`, { paths: [dir] }));
  }
});
