// Procedural-memory store (issue #140): each skill is a standalone,
// human-readable `.md` file with a small YAML-like frontmatter block.
// Kept as individual files (not one JSON blob like presets-store.js)
// deliberately -- skills are meant to be hand-authored/reviewed one at a
// time, and a plain .md file is something a person can open and edit
// directly.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { resolveExecutable } = require("./ai/tool-risk");

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Issue #664: SKILL.md (OpenClaw/AgentSkills) frontmatter is YAML with
// nested fields, e.g. `metadata: {"openclaw": {"requires": {"bins": [...]}}}`
// or the same thing as an indented block. Mana's own flat `key: value`
// files are a subset of this, and scalars stay strings (no number/bool
// coercion), so they parse exactly as before.
// ponytail: a YAML subset, not a YAML parser -- block maps, "- " lists,
// |/> block scalars, quoted scalars, JSON flow (single- or multi-line,
// trailing commas allowed). Anchors, tags, inline comments and unquoted
// flow maps are out; swap in the `yaml` package if a real skill needs them.
function parseFlow(text) {
  for (const candidate of [text, text.replace(/,(\s*[}\]])/g, "$1")]) {
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // try the next form
    }
  }
  return undefined;
}

function parseScalar(raw) {
  const value = raw.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return parseFlow(value) ?? value;
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  if (/^[{[]/.test(value)) {
    const flow = parseFlow(value);
    if (flow !== undefined) return flow;
    // YAML's unquoted flow list, `[uv, git]`
    if (/^\[[^[\]{}]*\]$/.test(value)) {
      return value.slice(1, -1).split(",").map((v) => v.trim()).filter(Boolean).map(parseScalar);
    }
  }
  return value;
}

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
  const indentOf = (line) => line.length - line.trimStart().length;
  const isItem = (line) => /^-(\s|$)/.test(line.trimStart());
  let i = 0;

  // Whatever is nested under `key:` -- a multi-line JSON flow, a
  // deeper-indented block, or a "- " list (YAML allows that at the key's
  // own indent).
  function child(indent) {
    if (i >= lines.length) return "";
    const next = lines[i];
    if (indentOf(next) > indent && /^[{[]/.test(next.trim())) {
      const start = i;
      while (i < lines.length && indentOf(lines[i]) > indent) i++;
      const text = lines.slice(start, i).join("\n");
      return parseFlow(text) ?? text.trim();
    }
    if (indentOf(next) > indent || (indentOf(next) === indent && isItem(next))) {
      return block(indentOf(next));
    }
    return "";
  }

  function blockScalar(indent, folded) {
    const start = i;
    while (i < lines.length && indentOf(lines[i]) > indent) i++;
    return lines.slice(start, i).map((l) => l.trim()).join(folded ? " " : "\n");
  }

  function block(indent) {
    const list = isItem(lines[i]);
    const out = list ? [] : {};
    while (i < lines.length && indentOf(lines[i]) === indent && isItem(lines[i]) === list) {
      const line = lines[i++].trim();
      if (list) {
        const item = line.replace(/^-\s*/, "");
        out.push(item ? parseScalar(item) : child(indent));
        continue;
      }
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const rest = line.slice(idx + 1).trim();
      if (/^[|>][+-]?$/.test(rest)) out[key] = blockScalar(indent, rest[0] === ">");
      else if (!rest) out[key] = child(indent);
      else {
        out[key] = parseScalar(rest);
        // A plain scalar wrapped onto deeper-indented lines (a long
        // description, typically) continues there.
        if (!/^["'{[]/.test(rest) && i < lines.length && indentOf(lines[i]) > indent) {
          out[key] = `${out[key]} ${blockScalar(indent, true)}`;
        }
      }
    }
    return out;
  }

  const result = {};
  while (i < lines.length) {
    // A stray indented or list line at the top level is skipped rather
    // than failing the whole skill.
    if (indentOf(lines[i]) !== 0 || isItem(lines[i])) {
      i++;
      continue;
    }
    Object.assign(result, block(0));
  }
  return result;
}

// Mana's own fields; everything else in the frontmatter (license,
// metadata, homepage, ...) is carried through untouched as `extra`, so a
// usage bump or a Settings edit never strips an imported skill's metadata.
const KNOWN_FIELDS = [
  "name", "description", "category", "created", "lastUsed",
  "useCount", "status", "requires", "permission",
];

function asText(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Written raw when it reads back identically (every value Mana itself
// writes), JSON-quoted otherwise -- a JSON string is a valid YAML scalar,
// and objects come out as the single-line JSON OpenClaw's own docs use.
function formatValue(value) {
  if (typeof value === "string" && !/[\r\n]/.test(value) && value === value.trim() && !/^[|>][+-]?$/.test(value) && parseScalar(value) === value) {
    return value;
  }
  return JSON.stringify(value);
}

function parseSkillFile(raw, fallbackName) {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return {
      name: fallbackName,
      description: "",
      category: "general",
      created: null,
      lastUsed: null,
      useCount: 0,
      status: "active",
      requires: [],
      permission: DEFAULT_PERMISSION,
      body: raw.trim(),
    };
  }
  const frontmatter = parseFrontmatter(match[1]);
  const extra = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!KNOWN_FIELDS.includes(key)) extra[key] = value;
  }
  return {
    name: asText(frontmatter.name) || fallbackName,
    // Single-line like every Mana description; a SKILL.md may use a
    // multi-line `|` block for it.
    description: asText(frontmatter.description).replace(/\s*\n\s*/g, " "),
    category: asText(frontmatter.category) || "general",
    created: asText(frontmatter.created) || null,
    lastUsed: asText(frontmatter.lastUsed) || null,
    // How many times this skill has actually been reached for again since
    // it was approved -- not a moderation signal, just makes an
    // approved-but-never-used proposal visible instead of indistinguishable
    // from one that's genuinely useful (issue: skill system review).
    useCount: Number(frontmatter.useCount) || 0,
    status: asText(frontmatter.status) || "active",
    // Issue #354: tools this skill's steps depend on. Without it a skill
    // whose tool has gone away stays status: "active" and fails only when
    // someone finally reaches for it -- and neither useCount nor lastUsed
    // exposes that, since a skill that never runs successfully simply stops
    // incrementing them.
    requires: parseRequires(
      Array.isArray(frontmatter.requires) ? frontmatter.requires.join(",") : asText(frontmatter.requires),
    ),
    // Issue #355: whether *this invocation* needs confirming, which is a
    // different question from whether the skill was allowed to exist.
    // Approving a skill says the instructions are safe to keep; it does not
    // follow that every future run of them is safe to perform unwatched.
    permission: normalizePermission(frontmatter.permission),
    // Only present when there is any, so a Mana skill parses exactly as it
    // did before SKILL.md support.
    ...(Object.keys(extra).length ? { extra } : {}),
    body: match[2].trim(),
  };
}

// Comma-separated in the frontmatter because the format is one flat
// `key: value` line per field -- a YAML list would mean parsing real YAML
// for one field.
// "always" keeps today's behaviour, which is what every existing skill was
// written and approved against -- flipping the default to "confirm" would
// silently make every one of them start interrupting, a surprising outcome
// for a change that only adds a field. Effectful skills opt in.
const PERMISSIONS = ["always", "confirm"];
const DEFAULT_PERMISSION = "always";

function normalizePermission(value) {
  const clean = String(value || "").trim();
  return PERMISSIONS.includes(clean) ? clean : DEFAULT_PERMISSION;
}

// Issue #356: a real check, run by the JavaScript engine itself, rather
// than a model re-reading the code it just wrote. Self-review by the
// generating model is weak verification -- whatever it got wrong while
// writing, it tends to consider fine while checking, because the same
// distribution is doing both.
//
// What is actually verifiable about a generated skill is narrower than
// "run its tests": a skill belongs to no test suite, and running node-bot's
// own suite would exercise Mana, not the skill. What can be checked
// deterministically is that the script parses -- and today nothing does
// that until the worker compiles it at run time, so a skill with a syntax
// error can be approved, stored, and only fail when someone finally reaches
// for it.
//
// Compiled exactly the way script-runner-worker.js will compile it, wrapper
// included, so this validates the same text that actually runs. Compiling
// is not executing: no sandbox, no tools, no side effects.
function verifySkillScript(body) {
  const code = extractSkillScript(body);
  if (!code) return { ok: true, checked: false };
  try {
    new vm.Script(`(async () => {
${code}
})()`, {
      filename: "mana-generated-script.js",
    });
    return { ok: true, checked: true };
  } catch (e) {
    return { ok: false, checked: true, error: e.message || String(e) };
  }
}

function parseRequires(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// A skill is unavailable when something it declared it needs is not there.
// Reported rather than hidden: "this exists but cannot run right now, and
// here is what is missing" is far more useful than a skill silently not
// being offered.
function evaluateSkillAvailability(skill, isToolAvailable, host = HOST) {
  const requires = Array.isArray(skill?.requires) ? skill.requires : [];
  const missingRequirements = [
    ...(typeof isToolAvailable === "function" ? requires.filter((tool) => !isToolAvailable(tool)) : []),
    ...missingHostRequirements(skill, host),
  ];
  return { available: missingRequirements.length === 0, missingRequirements };
}

// Issue #664: what a SKILL.md says it needs from the machine, in OpenClaw's
// own gating fields -- metadata.openclaw.{os, requires.bins, requires.anyBins,
// requires.env} (clawdbot is that key's older name, still on ClawHub).
// requires.config points into OpenClaw's own config file, which has no
// meaning here, so it is not checked.
const HOST = {
  platform: process.platform,
  env: process.env,
  hasBin: (bin) =>
    Boolean(
      resolveExecutable(bin, "", {
        env: process.env,
        platform: process.platform,
        cwd: () => process.cwd(),
        existsSync: fs.existsSync,
        statSync: fs.statSync,
      }),
    ),
};

function missingHostRequirements(skill, host) {
  const metadata = skill?.extra?.metadata;
  const gate = metadata && typeof metadata === "object"
    ? metadata.openclaw || metadata.clawdbot
    : null;
  if (!gate || typeof gate !== "object") return [];
  const needs = gate.requires && typeof gate.requires === "object" ? gate.requires : {};
  const list = (value) => (Array.isArray(value) ? value : value ? [value] : []).map(String);
  const missing = [];
  const os = list(gate.os);
  if (os.length && !os.includes(host.platform)) missing.push(`os: ${os.join(" or ")}`);
  for (const bin of list(needs.bins)) if (!host.hasBin(bin)) missing.push(`bin: ${bin}`);
  const anyBins = list(needs.anyBins);
  if (anyBins.length && !anyBins.some((bin) => host.hasBin(bin))) {
    missing.push(`bin: ${anyBins.join(" or ")}`);
  }
  for (const name of list(needs.env)) if (!host.env[name]) missing.push(`env: ${name}`);
  return missing;
}

function serializeSkillFile(skill) {
  return [
    "---",
    `name: ${formatValue(skill.name)}`,
    `description: ${formatValue(skill.description)}`,
    `category: ${formatValue(skill.category)}`,
    `created: ${formatValue(skill.created)}`,
    `lastUsed: ${formatValue(skill.lastUsed)}`,
    `useCount: ${skill.useCount || 0}`,
    `status: ${formatValue(skill.status)}`,
    // Omitted entirely when empty rather than written as a blank line, so
    // an existing skill file is unchanged by a round-trip through this.
    ...(Array.isArray(skill.requires) && skill.requires.length
      ? [`requires: ${skill.requires.join(", ")}`]
      : []),
    ...(skill.permission && skill.permission !== DEFAULT_PERMISSION
      ? [`permission: ${skill.permission}`]
      : []),
    ...Object.entries(skill.extra || {}).map(([key, value]) => `${key}: ${formatValue(value)}`),
    "---",
    "",
    skill.body,
    "",
  ].join("\n");
}

// name/description/category are written raw into a line-based frontmatter
// block (no escaping -- see serializeSkillFile), so a newline here would
// inject bogus frontmatter keys or corrupt the file's own "---" delimiters
// on next parse. Rejected outright rather than silently stripped, since
// these fields are meant to be short single-line values regardless of
// where they came from (a form, the idle-proposal LLM, a model tool call).
function assertSingleLine(value, fieldName) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${fieldName} cannot contain line breaks`);
  }
}

// A skill body can optionally embed one ```skill-script fenced block --
// deterministic code for the procedure's mechanical part, so skill__run
// (ai/skill-tool-source.js) can execute it directly through
// tools/script-runner.js's sandbox instead of the model re-deriving the same
// steps by reasoning through prose every single time. Pure convention (a
// specific fence tag inside the existing body text), not a new stored
// field -- a skill with no such block is just a prose-only skill, same as
// before this existed.
const SKILL_SCRIPT_RE = /```skill-script\r?\n([\s\S]*?)```/;

function extractSkillScript(body) {
  const match = SKILL_SCRIPT_RE.exec(String(body || ""));
  return match ? match[1].trim() : null;
}

// Issue #278: a "recipe"-shaped skill optionally declares named inputs
// (like a function signature) instead of only being retrieved by
// description-similarity -- same convention as ```skill-script (a specific
// fence tag inside the existing body, not a new frontmatter field or
// storage format). Each line is `name: description`; malformed lines are
// skipped rather than failing the whole skill, matching this codebase's
// general "degrade gracefully on user/model-authored text" posture.
const SKILL_INPUTS_RE = /```skill-inputs\r?\n([\s\S]*?)```/;

function extractSkillInputs(body) {
  const match = SKILL_INPUTS_RE.exec(String(body || ""));
  if (!match) return [];
  const inputs = [];
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const description = line.slice(idx + 1).trim();
    if (name) inputs.push({ name, description });
  }
  return inputs;
}

function slugify(name) {
  return (
    String(name || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "skill"
  );
}

const SKILL_MD = "SKILL.md";

// "<folder>/SKILL.md" -> "<folder>"; null for a single-file skill.
function skillFolderOf(fileName) {
  return fileName.endsWith(`/${SKILL_MD}`) ? fileName.slice(0, -SKILL_MD.length - 1) : null;
}

// Relative "/"-separated paths of every file under dir. Dot-entries (.git,
// .env) and symlinks are skipped: neither belongs in a skill, and a
// symlink could point anywhere.
function listFolderFiles(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFolderFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// Issue #664: everything an import shows the approver, read once so the
// approval covers these exact bytes (see importSkill). Bounded because the
// whole thing sits in the pending-approval queue until someone decides.
const MAX_IMPORT_FILES = 200;
const MAX_IMPORT_BYTES = 512 * 1024;
const SCRIPT_RE = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|ps1|psm1|bat|cmd|vbs|rb|pl|php|exe|dll)$/i;

function readSkillFolder(dir) {
  const root = path.resolve(String(dir || ""));
  if (!fs.existsSync(path.join(root, SKILL_MD))) throw new Error(`no ${SKILL_MD} in ${root}`);
  return describeSkillImport(listFolderFiles(root), (rel) => fs.readFileSync(path.join(root, rel)), path.basename(root));
}

// Shared by folder and zip import. readData(rel, budget) returns a file's
// bytes; budget is how many may still fit, so a zip entry can stop inflating
// there instead of unpacking a zip bomb.
function describeSkillImport(paths, readData, fallbackName) {
  if (paths.length > MAX_IMPORT_FILES) throw new Error(`skill folder has more than ${MAX_IMPORT_FILES} files`);
  let total = 0;
  const files = paths.map((rel) => {
    const data = readData(rel, MAX_IMPORT_BYTES - total);
    total += data.length;
    if (total > MAX_IMPORT_BYTES) throw new Error(`skill folder is larger than ${MAX_IMPORT_BYTES / 1024} KB`);
    const encoding = data.includes(0) ? "base64" : "utf8";
    return { path: rel, encoding, content: data.toString(encoding) };
  });
  const skillFile = files.find((file) => file.path === SKILL_MD);
  if (!skillFile || skillFile.encoding !== "utf8") throw new Error(`${SKILL_MD} is not readable text`);
  const skill = parseSkillFile(skillFile.content, fallbackName);
  return {
    name: skill.name,
    description: skill.description,
    files,
    scripts: paths.filter((rel) => rel.startsWith("scripts/") || SCRIPT_RE.test(rel)),
    // Everything the skill declares it needs, found by checking it against
    // a host that has nothing.
    requires: [
      ...skill.requires.map((tool) => `tool: ${tool}`),
      ...missingHostRequirements(skill, { platform: "", env: {}, hasBin: () => false }),
    ],
  };
}

// The central directory of a zip: entry name -> { method, compressed }.
// Stored (0) and deflated (8) entries only -- what every common zipper
// writes. No zip64 (a skill is at most 512 KB anyway), no encryption.
function readZipEntries(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no zip directory");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("damaged zip directory");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const localOffset = buffer.readUInt32LE(offset + 42);
    // Windows PowerShell's Compress-Archive writes "\" separators.
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/");
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error("it's encrypted");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("damaged zip entry");
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    entries.set(name, { method, compressed: buffer.subarray(start, start + size) });
  }
  return entries;
}

// #664 (Q21): a zipped skill folder -- SKILL.md at the top, or inside one
// top-level folder (how GitHub and most zippers pack a folder). Read in
// memory, never unpacked to disk: only an approved import writes files
// (importSkill), and the same dot-entry, count and size rules as a folder
// apply. A path that tries to leave the folder refuses the whole zip.
const MAX_ZIP_BYTES = 16 * MAX_IMPORT_BYTES;

function readSkillZip(zipPath) {
  const file = path.resolve(String(zipPath || ""));
  if (fs.statSync(file).size > MAX_ZIP_BYTES) throw new Error(`zip is larger than ${MAX_ZIP_BYTES / 1024 / 1024} MB`);
  let entries;
  try {
    entries = readZipEntries(fs.readFileSync(file));
  } catch (e) {
    throw new Error(`${path.basename(file)} isn't a zip Mana can read (${e.message})`);
  }
  const names = [...entries.keys()];
  const unsafe = names.find((name) => name.startsWith("/") || name.includes(":") || name.split("/").includes(".."));
  if (unsafe) throw new Error(`zip entry "${unsafe}" points outside the skill folder`);
  const kept = names.filter((name) => !name.startsWith("__MACOSX/") && !name.split("/").some((seg) => seg.startsWith(".")));
  const tops = new Set(kept.map((name) => name.split("/")[0]));
  const prefix = kept.includes(SKILL_MD) ? "" : tops.size === 1 && kept.includes(`${[...tops][0]}/${SKILL_MD}`) ? `${[...tops][0]}/` : null;
  if (prefix === null) throw new Error(`no ${SKILL_MD} at the top of ${path.basename(file)}`);
  const paths = kept.filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
  const readData = (rel, budget) => {
    const { method, compressed } = entries.get(prefix + rel);
    if (method === 0) return compressed;
    if (method !== 8) throw new Error(`zip entry "${rel}" uses an unsupported compression method`);
    try {
      return zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(budget, 0) + 1 });
    } catch (e) {
      if (e.code === "ERR_BUFFER_TOO_LARGE") throw new Error(`skill folder is larger than ${MAX_IMPORT_BYTES / 1024} KB`);
      throw new Error(`zip entry "${rel}" is damaged (${e.message})`);
    }
  };
  return describeSkillImport(paths, readData, prefix ? prefix.slice(0, -1) : path.basename(file, path.extname(file)));
}

function createSkillsStore(options = {}) {
  const skillsDir =
    options.skillsDir ||
    process.env.MANA_SKILLS_DIR ||
    path.join(__dirname, "skills");
  const archiveDir = path.join(skillsDir, ".archive");
  const now = options.now || (() => new Date().toISOString());
  // #426 sub-project 1: optional, same as acp-memory-store.js -- absence is
  // a silent no-op so existing construction sites keep working unchanged.
  const snapshotStore = options.snapshotStore || null;

  if (snapshotStore) {
    snapshotStore.registerRestorer("skill", async (fileName, fileContent) => {
      // #475 review: back up the file as it stands right before a restore
      // overwrites it, so the restore itself is undoable.
      const fullPath = path.join(skillsDir, fileName);
      if (fs.existsSync(fullPath)) {
        try {
          snapshotStore.recordSnapshot({
            kind: "skill",
            key: fileName,
            payload: fs.readFileSync(fullPath, "utf8"),
            summary: `pre-restore backup: ${fileName}`,
            source: "system",
          });
        } catch (e) {
          console.warn("pre-restore skill backup failed:", e?.message || e);
        }
      }
      fs.writeFileSync(fullPath, fileContent, "utf8");
      return { fileName };
    });
  }

  function ensureDir() {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Issue #664: both layouts -- Mana's single `<name>.md` files, and a
  // SKILL.md folder (`<name>/SKILL.md` plus its scripts/, references/,
  // assets/), listed as "<name>/SKILL.md". Dot-folders (.archive) and
  // symlinked folders are not skills.
  function listSkillFiles() {
    ensureDir();
    const files = [];
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(entry.name);
      else if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        fs.existsSync(path.join(skillsDir, entry.name, SKILL_MD))
      ) {
        files.push(`${entry.name}/${SKILL_MD}`);
      }
    }
    return files;
  }

  function readSkill(fileName) {
    const raw = fs.readFileSync(path.join(skillsDir, fileName), "utf8");
    return { ...parseSkillFile(raw, skillFolderOf(fileName) || fileName.replace(/\.md$/, "")), fileName };
  }

  // Issue #393: skills are plain files, so one can arrive without ever
  // going through createSkill -- hand-written, copied in, or restored from
  // a backup. parseSkillFile falls back to defaults for those rather than
  // failing, which keeps them usable but leaves them invisible to the
  // managed flow: no real created date, no useCount, and a filename that
  // may not match the name inside.
  //
  // Reports rather than fixes. A file the user wrote by hand is theirs, and
  // rewriting it unasked is the wrong default -- adoptSkill() is the
  // explicit action.
  function listUnmanagedSkills() {
    const unmanaged = [];
    for (const fileName of listSkillFiles()) {
      let skill;
      try {
        skill = readSkill(fileName);
      } catch (e) {
        unmanaged.push({ fileName, name: null, reasons: ["unreadable"] });
        continue;
      }

      const reasons = [];
      // No `created` means parseSkillFile never found frontmatter at all.
      // (A SKILL.md copied in by hand has frontmatter, just not Mana's.)
      if (!skill.created) reasons.push(skillFolderOf(fileName) ? "no created date" : "no frontmatter");
      if (!skill.description) reasons.push("no description");
      const expected = skillFolderOf(fileName)
        ? `${slugify(skill.name)}/${SKILL_MD}`
        : `${slugify(skill.name)}.md`;
      if (fileName !== expected) reasons.push(`filename does not match name (expected ${expected})`);

      if (reasons.length) unmanaged.push({ fileName, name: skill.name, reasons });
    }
    return unmanaged;
  }

  // Brings one file into the managed shape without touching its body --
  // the instructions are the part the user cared about, and this only
  // fills in the bookkeeping around them. Deliberately does not rename the
  // file: findFileForName resolves by parsed name, so a mismatched filename
  // is untidy rather than broken, and renaming risks breaking whatever
  // pointed at the old path.
  function adoptSkill(name) {
    const fileName = findFileForName(name);
    if (!fileName) return null;
    const skill = readSkill(fileName);
    const timestamp = now();
    const adopted = {
      ...skill,
      description: skill.description || `Adopted from ${fileName}`,
      category: skill.category || "general",
      created: skill.created || timestamp,
      lastUsed: skill.lastUsed || timestamp,
      useCount: Number(skill.useCount) || 0,
      status: skill.status || "active",
    };
    fs.writeFileSync(path.join(skillsDir, fileName), serializeSkillFile(adopted), "utf8");
    return { ...adopted, fileName };
  }

  function findFileForName(name) {
    return listSkillFiles().find((fileName) => {
      try {
        return readSkill(fileName).name === name;
      } catch (e) {
        return false;
      }
    });
  }

  // The cheap call: name/description/category/status only, no body -- this
  // is what stays affordable to keep around even as the skill count grows.
  // options.isToolAvailable: issue #354. Passed in rather than imported so
  // this store keeps knowing nothing about the tool registry -- it only
  // knows what each skill declared it needs.
  function listSkills({ isToolAvailable } = {}) {
    return listSkillFiles()
      .map((fileName) => {
        try {
          const skill = readSkill(fileName);
          const availability = evaluateSkillAvailability(skill, isToolAvailable);
          return {
            name: skill.name,
            description: skill.description,
            category: skill.category,
            status: skill.status,
            lastUsed: skill.lastUsed,
            useCount: skill.useCount,
            requires: skill.requires,
            hasScript: Boolean(extractSkillScript(skill.body)),
            ...availability,
          };
        } catch (e) {
          return null;
        }
      })
      .filter((skill) => skill && skill.status !== "archived")
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // The expensive call: full body, only invoked once a skill is actually
  // going to be used -- also bumps lastUsed (and un-stales it, since being
  // reached for again is exactly what "not actually stale" means) so the
  // idle prune pass below doesn't archive something in active use.
  function viewSkill(name, { touch = true } = {}) {
    const fileName = findFileForName(name);
    if (!fileName) return null;
    // Touch (which writes the updated lastUsed/status to disk) before the
    // read, not after -- otherwise this returns the stale pre-touch copy.
    if (touch) touchSkillUsage(name);
    const skill = readSkill(fileName);
    const folder = skillFolderOf(fileName);
    if (!folder) return skill;
    // Issue #664: where a SKILL.md's scripts/references actually live, so
    // whoever reads the instructions can find the files they mention.
    const dir = path.join(skillsDir, folder);
    return { ...skill, dir, files: listFolderFiles(dir) };
  }

  function touchSkillUsage(name) {
    const fileName = findFileForName(name);
    if (!fileName) return false;
    const skill = readSkill(fileName);
    skill.lastUsed = now();
    skill.useCount = (skill.useCount || 0) + 1;
    if (skill.status === "stale") skill.status = "active";
    fs.writeFileSync(
      path.join(skillsDir, fileName),
      serializeSkillFile(skill),
      "utf8",
    );
    return true;
  }

  // The write path (issue #140 scope): a human (or Mana, with a human
  // actually invoking this) adding a new skill after a task went well.
  // Deliberately no agent-autonomous write loop here -- that's explicitly
  // out of scope until the read/prune path is proven, and any future
  // approval-gate work (issue #152) sits in front of whoever calls this,
  // not inside it.
  function createSkill({ name, description, category, body, requires, permission }) {
    ensureDir();
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("name is required");
    const cleanDescription = String(description || "").trim();
    if (!cleanDescription) throw new Error("description is required");
    const cleanBody = String(body || "").trim();
    if (!cleanBody) throw new Error("body is required");
    const cleanCategory = String(category || "general").trim() || "general";

    // Blocking, not advisory. A skill that cannot parse is not a skill, and
    // storing it only defers the failure to whoever reaches for it next.
    const verified = verifySkillScript(cleanBody);
    if (!verified.ok) {
      throw new Error(`skill-script does not parse: ${verified.error}`);
    }
    assertSingleLine(cleanName, "name");
    assertSingleLine(cleanDescription, "description");
    assertSingleLine(cleanCategory, "category");

    // Checked against the actual target filename, not findFileForName's
    // exact-name match -- slugify() lowercases, so "Restart SearXNG" and
    // "restart searxng" collide on disk (restart-searxng.md) even though
    // their display names differ. Catching that here is what actually
    // prevents the second create from silently overwriting the first.
    const fileName = `${slugify(cleanName)}.md`;
    if (slugTaken(slugify(cleanName))) {
      throw new Error(`a skill named "${cleanName}" already exists`);
    }

    const timestamp = now();
    const skill = {
      name: cleanName,
      description: cleanDescription,
      category: cleanCategory,
      created: timestamp,
      lastUsed: timestamp,
      useCount: 0,
      status: "active",
      requires: parseRequires(
        Array.isArray(requires) ? requires.join(",") : requires,
      ),
      permission: normalizePermission(permission),
      body: cleanBody,
    };
    fs.writeFileSync(
      path.join(skillsDir, fileName),
      serializeSkillFile(skill),
      "utf8",
    );
    return { ...skill, fileName };
  }

  // Either layout counts: "foo.md" and "foo/SKILL.md" would be two skills
  // fighting over one name.
  function slugTaken(slug) {
    return fs.existsSync(path.join(skillsDir, `${slug}.md`)) || fs.existsSync(path.join(skillsDir, slug));
  }

  // Issue #664: the executor behind a "skill-import" approval. It runs only
  // after a human approved the exact files readSkillFolder() captured, so a
  // folder changed after the review cannot swap in something else. It
  // writes files and nothing more -- no script in the skill is run, by this
  // or on import at all.
  // Q20 (#664): how Mana may use an imported (SKILL.md folder) skill --
  // "free", "each" (ask every time) or "first" (ask once per skill, the
  // default) -- set in Settings > Skills. Kept with the skills in a dot-file
  // (never listed as a skill), with the skills approved under "first".
  const IMPORTED_SKILL_USE_MODES = ["free", "each", "first"];
  const settingsPath = path.join(skillsDir, ".mana-skills.json");
  // "each": one approved use, taken by the next one. In memory: a restart
  // just asks again.
  const approvedOnce = new Set();

  function readSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeSettings(settings) {
    ensureDir();
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  }

  function getImportedSkillUse() {
    const mode = readSettings().importedSkillUse;
    return IMPORTED_SKILL_USE_MODES.includes(mode) ? mode : "first";
  }

  function setImportedSkillUse(mode) {
    if (!IMPORTED_SKILL_USE_MODES.includes(mode)) {
      throw new Error(`importedSkillUse must be one of ${IMPORTED_SKILL_USE_MODES.join(", ")}`);
    }
    writeSettings({ ...readSettings(), importedSkillUse: mode });
  }

  // Whether Mana may use this imported skill right now without asking.
  // takeOnce: consume an "each" approval (a real use, not a check).
  function mayUseImportedSkill(name, { takeOnce = false } = {}) {
    const mode = getImportedSkillUse();
    const key = String(name).toLowerCase();
    if (mode === "free") return true;
    if (mode === "first" && (readSettings().useApproved || []).includes(key)) return true;
    if (!approvedOnce.has(key)) return false;
    if (takeOnce) approvedOnce.delete(key);
    return true;
  }

  // The user approved a use: remembered for good under "first", once
  // under "each".
  function approveImportedSkillUse(name) {
    const key = String(name).toLowerCase();
    if (getImportedSkillUse() === "first") {
      const settings = readSettings();
      const approved = new Set(settings.useApproved || []);
      approved.add(key);
      writeSettings({ ...settings, useApproved: [...approved] });
    } else {
      approvedOnce.add(key);
    }
  }

  function importSkill({ files } = {}) {
    ensureDir();
    const list = Array.isArray(files) ? files : [];
    const decode = (file) =>
      Buffer.from(String(file?.content ?? ""), file?.encoding === "base64" ? "base64" : "utf8");
    const skillFile = list.find((file) => file?.path === SKILL_MD);
    if (!skillFile) throw new Error(`${SKILL_MD} is required`);
    const skill = parseSkillFile(decode(skillFile).toString("utf8"), "");
    if (!skill.name.trim()) throw new Error("name is required");
    if (!skill.description) throw new Error("description is required");
    assertSingleLine(skill.name, "name");
    const verified = verifySkillScript(skill.body);
    if (!verified.ok) throw new Error(`skill-script does not parse: ${verified.error}`);

    const folder = slugify(skill.name);
    if (slugTaken(folder)) throw new Error(`a skill named "${skill.name}" already exists`);
    const dir = path.join(skillsDir, folder);
    const timestamp = now();
    try {
      for (const file of list) {
        const target = path.resolve(dir, String(file?.path ?? ""));
        if (!target.startsWith(dir + path.sep)) throw new Error(`unsafe path in skill: ${file?.path}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
          target,
          file === skillFile
            ? serializeSkillFile({ ...skill, created: timestamp, lastUsed: timestamp, useCount: 0, status: "active" })
            : decode(file),
        );
      }
    } catch (e) {
      // Half an import is worse than none: it would block a retry by name.
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    return readSkill(`${folder}/${SKILL_MD}`);
  }

  // Direct human edit via Settings (issue #262 follow-up) -- deliberately
  // NOT approval-gated like createSkill: a Settings form submission already
  // IS the human decision the approval gate exists to require for
  // agent-authored content. Only updates fields actually provided; renaming
  // is out of scope here to avoid file-rename bookkeeping.
  function updateSkill(name, { description, body, category } = {}) {
    const fileName = findFileForName(name);
    if (!fileName) return null;
    const skill = readSkill(fileName);

    if (snapshotStore) {
      try {
        snapshotStore.recordSnapshot({
          kind: "skill",
          key: fileName,
          payload: serializeSkillFile(skill),
          summary: `skill update: ${skill.name}`,
          source: "human",
        });
      } catch (e) {
        console.warn("Skill snapshot failed:", e?.message || e);
      }
    }

    if (description !== undefined) {
      const cleanDescription = String(description).trim();
      assertSingleLine(cleanDescription, "description");
      skill.description = cleanDescription;
    }
    if (body !== undefined) {
      skill.body = String(body).trim();
    }
    if (category !== undefined) {
      // null is an explicit "clear it back to the default" request (see
      // skills-capability.js's PATCH route), distinct from omitting the
      // field entirely (the `category !== undefined` guard above) -- both
      // land here as the empty-string fallback either way.
      const cleanCategory = category === null ? "" : String(category).trim();
      assertSingleLine(cleanCategory, "category");
      skill.category = cleanCategory || "general";
    }
    fs.writeFileSync(
      path.join(skillsDir, fileName),
      serializeSkillFile(skill),
      "utf8",
    );
    return { ...skill, fileName };
  }

  // Direct human delete via Settings -- permanent, unlike pruneStaleSkills'
  // archive-to-.archive/ path below (that's idle cleanup of things nobody
  // chose to remove; this is someone explicitly choosing to).
  function deleteSkill(name) {
    const fileName = findFileForName(name);
    if (!fileName) return false;
    const folder = skillFolderOf(fileName);
    // A SKILL.md folder goes whole -- its scripts are no use without it.
    if (folder) {
      fs.rmSync(path.join(skillsDir, folder), { recursive: true });
      // Q20: a later import under the same name is asked about afresh.
      const settings = readSettings();
      const key = String(name).toLowerCase();
      if ((settings.useApproved || []).includes(key)) {
        writeSettings({ ...settings, useApproved: settings.useApproved.filter((n) => n !== key) });
      }
    } else fs.unlinkSync(path.join(skillsDir, fileName));
    return true;
  }

  // Deterministic, no-LLM pass (issue #140 acceptance criterion): skills
  // unused past staleDays get flagged stale (still listed, still usable --
  // and touchSkillUsage un-stales them the moment they're used again);
  // skills unused past archiveDays move out to .archive/ entirely so the
  // cheap index doesn't grow forever with things nobody's touched in months.
  function pruneStaleSkills({ staleDays = 30, archiveDays = 90 } = {}) {
    ensureDir();
    const nowMs = Date.parse(now());
    const staleMs = staleDays * 24 * 60 * 60 * 1000;
    const archiveMs = archiveDays * 24 * 60 * 60 * 1000;
    const result = { staled: [], archived: [] };

    for (const fileName of listSkillFiles()) {
      let skill;
      try {
        skill = readSkill(fileName);
      } catch (e) {
        continue;
      }
      const lastUsedMs = Date.parse(skill.lastUsed || skill.created || "");
      if (!Number.isFinite(lastUsedMs)) continue;
      const ageMs = nowMs - lastUsedMs;

      if (ageMs >= archiveMs) {
        fs.mkdirSync(archiveDir, { recursive: true });
        skill.status = "archived";
        const folder = skillFolderOf(fileName);
        if (folder) {
          // The whole folder moves, scripts and references with it.
          fs.writeFileSync(path.join(skillsDir, fileName), serializeSkillFile(skill), "utf8");
          fs.rmSync(path.join(archiveDir, folder), { recursive: true, force: true });
          fs.renameSync(path.join(skillsDir, folder), path.join(archiveDir, folder));
        } else {
          fs.writeFileSync(
            path.join(archiveDir, fileName),
            serializeSkillFile(skill),
            "utf8",
          );
          fs.unlinkSync(path.join(skillsDir, fileName));
        }
        result.archived.push(skill.name);
      } else if (ageMs >= staleMs && skill.status !== "stale") {
        skill.status = "stale";
        fs.writeFileSync(
          path.join(skillsDir, fileName),
          serializeSkillFile(skill),
          "utf8",
        );
        result.staled.push(skill.name);
      }
    }
    return result;
  }

  return {
    skillsDir,
    listSkills,
    listUnmanagedSkills,
    adoptSkill,
    viewSkill,
    touchSkillUsage,
    createSkill,
    importSkill,
    getImportedSkillUse,
    setImportedSkillUse,
    mayUseImportedSkill,
    approveImportedSkillUse,
    updateSkill,
    deleteSkill,
    pruneStaleSkills,
  };
}

module.exports = {
  verifySkillScript,
  createSkillsStore,
  parseSkillFile,
  serializeSkillFile,
  evaluateSkillAvailability,
  readSkillFolder,
  readSkillZip,
  slugify,
  extractSkillScript,
  extractSkillInputs,
};
