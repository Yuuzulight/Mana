// Issue #346: a small local coder model cannot hold a large codebase in
// context, so without a structural overview it reasons about unfamiliar
// parts of a project from whatever files happen to have been read. A repo
// map is the cheap structural answer: what exists and where, without the
// bodies.
//
// tree-sitter rather than regex because a regex over source finds
// "function" inside strings and comments, and the whole value here is that
// the map is trustworthy enough to reason from.
const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const { significantWords, sharedWordCount } = require("./word-overlap");

// One parser reused across files -- construction is the expensive part and
// parse() is stateless with respect to previous calls.
let parser = null;
function getParser() {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(JavaScript);
  }
  return parser;
}

function nameOf(node) {
  const named = node.childForFieldName ? node.childForFieldName("name") : null;
  return named ? named.text : null;
}

// Top-level shape only: what a caller could reach, not every nested helper.
// A map that lists every inner arrow function is longer than the code it
// summarizes, which defeats the point.
function extractSymbols(source) {
  const tree = getParser().parse(String(source || ""));
  const symbols = [];

  const walk = (node, insideClass) => {
    for (let i = 0; i < node.namedChildCount; i += 1) {
      const child = node.namedChild(i);
      const type = child.type;

      if (type === "function_declaration" || type === "generator_function_declaration") {
        const name = nameOf(child);
        if (name) symbols.push({ kind: "function", name, line: child.startPosition.row + 1 });
        continue;
      }
      if (type === "class_declaration") {
        const name = nameOf(child);
        if (name) symbols.push({ kind: "class", name, line: child.startPosition.row + 1 });
        // One level in, for methods -- the useful part of a class.
        const body = child.childForFieldName("body");
        if (body) walk(body, true);
        continue;
      }
      if (insideClass && type === "method_definition") {
        const name = nameOf(child);
        if (name) symbols.push({ kind: "method", name, line: child.startPosition.row + 1 });
        continue;
      }
      // Exported/assigned function expressions read as declarations to a
      // human, so they belong in the map too.
      if (type === "lexical_declaration" || type === "variable_declaration") {
        for (let j = 0; j < child.namedChildCount; j += 1) {
          const decl = child.namedChild(j);
          if (decl.type !== "variable_declarator") continue;
          const value = decl.childForFieldName("value");
          if (!value) continue;
          if (value.type === "arrow_function" || value.type === "function_expression") {
            const name = nameOf(decl);
            if (name) symbols.push({ kind: "function", name, line: decl.startPosition.row + 1 });
          }
        }
        continue;
      }
      if (type === "export_statement") walk(child, insideClass);
    }
  };

  walk(tree.rootNode, false);
  return symbols;
}

// Relevance uses the same word-overlap helper the memory store already uses
// for conflict detection, rather than a second scoring notion invented for
// this. A file whose path and symbol names share significant words with the
// request is more likely to be the one being asked about.
function scoreFile(file, queryWords) {
  if (!queryWords.length) return 0;
  const haystack = significantWords(
    `${file.relativePath} ${file.symbols.map((s) => s.name).join(" ")}`,
  );
  return sharedWordCount(haystack, queryWords);
}

function formatFile(file) {
  const lines = file.symbols.map((s) => `  ${s.kind} ${s.name}:${s.line}`);
  return [`${file.relativePath}`, ...lines].join("\n");
}

// files: [{ relativePath, content }]. maxChars caps the whole map -- the
// issue's own guidance is roughly an eighth of the context window, and the
// caller knows the window, so it is a parameter rather than a guess here.
function buildRepoMap(files = [], { maxChars = 4000, relevantTo = "" } = {}) {
  const queryWords = significantWords(String(relevantTo || ""));

  const parsed = [];
  for (const file of files) {
    let symbols = [];
    try {
      symbols = extractSymbols(file.content);
    } catch (e) {
      // A file that will not parse is skipped rather than failing the map.
      // A partial map is useful; no map is not.
      continue;
    }
    if (!symbols.length) continue;
    const entry = { relativePath: file.relativePath, symbols };
    parsed.push({ ...entry, score: scoreFile(entry, queryWords) });
  }

  // Most relevant first, then stable by path so an unranked map (no query)
  // is deterministic rather than filesystem-ordered.
  parsed.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));

  const blocks = [];
  let used = 0;
  let omitted = 0;
  for (const file of parsed) {
    const block = formatFile(file);
    const cost = used ? block.length + 2 : block.length;
    // Whole files only. Half a file's symbol list reads as though the rest
    // does not exist, which is worse than saying it was left out -- the
    // same reasoning as #364's whole-line truncation.
    if (used + cost > maxChars) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
    used += cost;
  }

  const text = blocks.join("\n\n");
  return {
    text: omitted ? `${text}\n\n(${omitted} more file(s) omitted for space)` : text,
    files: blocks.length,
    omitted,
  };
}

module.exports = { extractSymbols, buildRepoMap };
