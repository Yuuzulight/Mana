const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Issue #226: index.html loads several renderer scripts as sibling classic
// <script src> tags (not ES modules), which share one top-level lexical
// scope for const/let -- that's *why* session-sidebar.js/sidebar-nav.js can
// reference things like appendChatMessage as bare identifiers without
// importing them. The same sharing means a duplicate top-level const/let of
// the same name in two of these files is a silent, whole-script-killing
// SyntaxError at runtime ("Identifier has already been declared") that
// `node --check` never catches, since each file is valid JS on its own --
// exactly what happened with `ipcRenderer` in renderer.js/backend-config.js.
// This scans the real files index.html actually loads and fails if any two
// declare the same top-level identifier.

const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const INDEX_HTML = path.join(RENDERER_DIR, "index.html");

function localSiblingScripts() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  // Only same-directory, non-vendor scripts run in the shared classic-script
  // scope this bug affects -- ../assets/, ../node_modules/, etc. are vendor
  // bundles (already their own IIFEs/UMDs), not part of this app's own
  // shared-scope file group.
  return srcs.filter((src) => !src.startsWith("../"));
}

// Matches this codebase's actual top-level declaration styles:
// `const NAME = ...`, `let NAME = ...`, `const { a, b } = ...`.
function topLevelDeclaredNames(source) {
  const names = [];
  const lines = source.split("\n");
  for (const line of lines) {
    const destructured = line.match(/^const\s*\{\s*([^}]+)\}\s*=/);
    if (destructured) {
      destructured[1].split(",").forEach((part) => {
        const name = part.split(":")[0].trim();
        if (name) names.push(name);
      });
      continue;
    }
    const simple = line.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (simple) names.push(simple[1]);
  }
  return names;
}

test("no two sibling renderer scripts declare the same top-level const/let", () => {
  const scripts = localSiblingScripts();
  assert.ok(scripts.length >= 2, "expected at least the known sibling scripts in index.html");

  const declaredIn = new Map(); // name -> [files]
  for (const src of scripts) {
    const filePath = path.join(RENDERER_DIR, src);
    if (!fs.existsSync(filePath)) continue; // not every listed script need exist in a stripped test env
    const source = fs.readFileSync(filePath, "utf8");
    for (const name of topLevelDeclaredNames(source)) {
      if (!declaredIn.has(name)) declaredIn.set(name, []);
      declaredIn.get(name).push(src);
    }
  }

  const collisions = [...declaredIn.entries()].filter(([, files]) => new Set(files).size > 1);
  assert.deepEqual(
    collisions,
    [],
    `these identifiers are declared as top-level const/let in more than one sibling script (shared scope -- causes a SyntaxError that kills the whole script): ${JSON.stringify(collisions)}`,
  );
});
