// Procedural-memory store (issue #140): each skill is a standalone,
// human-readable `.md` file with a small YAML-like frontmatter block.
// Kept as individual files (not one JSON blob like presets-store.js)
// deliberately -- skills are meant to be hand-authored/reviewed one at a
// time, and a plain .md file is something a person can open and edit
// directly.
const fs = require("node:fs");
const path = require("node:path");

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

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
      body: raw.trim(),
    };
  }
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    name: frontmatter.name || fallbackName,
    description: frontmatter.description || "",
    category: frontmatter.category || "general",
    created: frontmatter.created || null,
    lastUsed: frontmatter.lastUsed || null,
    // How many times this skill has actually been reached for again since
    // it was approved -- not a moderation signal, just makes an
    // approved-but-never-used proposal visible instead of indistinguishable
    // from one that's genuinely useful (issue: skill system review).
    useCount: Number(frontmatter.useCount) || 0,
    status: frontmatter.status || "active",
    // Issue #354: tools this skill's steps depend on. Without it a skill
    // whose tool has gone away stays status: "active" and fails only when
    // someone finally reaches for it -- and neither useCount nor lastUsed
    // exposes that, since a skill that never runs successfully simply stops
    // incrementing them.
    requires: parseRequires(frontmatter.requires),
    body: match[2].trim(),
  };
}

// Comma-separated in the frontmatter because the format is one flat
// `key: value` line per field -- a YAML list would mean parsing real YAML
// for one field.
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
function evaluateSkillAvailability(skill, isToolAvailable) {
  const requires = Array.isArray(skill?.requires) ? skill.requires : [];
  if (!requires.length || typeof isToolAvailable !== "function") {
    return { available: true, missingRequirements: [] };
  }
  const missingRequirements = requires.filter((tool) => !isToolAvailable(tool));
  return { available: missingRequirements.length === 0, missingRequirements };
}

function serializeSkillFile(skill) {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `category: ${skill.category}`,
    `created: ${skill.created}`,
    `lastUsed: ${skill.lastUsed}`,
    `useCount: ${skill.useCount || 0}`,
    `status: ${skill.status}`,
    // Omitted entirely when empty rather than written as a blank line, so
    // an existing skill file is unchanged by a round-trip through this.
    ...(Array.isArray(skill.requires) && skill.requires.length
      ? [`requires: ${skill.requires.join(", ")}`]
      : []),
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

function createSkillsStore(options = {}) {
  const skillsDir =
    options.skillsDir ||
    process.env.MANA_SKILLS_DIR ||
    path.join(__dirname, "skills");
  const archiveDir = path.join(skillsDir, ".archive");
  const now = options.now || (() => new Date().toISOString());

  function ensureDir() {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  function listSkillFiles() {
    ensureDir();
    return fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  }

  function readSkill(fileName) {
    const raw = fs.readFileSync(path.join(skillsDir, fileName), "utf8");
    return { ...parseSkillFile(raw, fileName.replace(/\.md$/, "")), fileName };
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
    return readSkill(fileName);
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
  function createSkill({ name, description, category, body, requires }) {
    ensureDir();
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("name is required");
    const cleanDescription = String(description || "").trim();
    if (!cleanDescription) throw new Error("description is required");
    const cleanBody = String(body || "").trim();
    if (!cleanBody) throw new Error("body is required");
    const cleanCategory = String(category || "general").trim() || "general";
    assertSingleLine(cleanName, "name");
    assertSingleLine(cleanDescription, "description");
    assertSingleLine(cleanCategory, "category");

    // Checked against the actual target filename, not findFileForName's
    // exact-name match -- slugify() lowercases, so "Restart SearXNG" and
    // "restart searxng" collide on disk (restart-searxng.md) even though
    // their display names differ. Catching that here is what actually
    // prevents the second create from silently overwriting the first.
    const fileName = `${slugify(cleanName)}.md`;
    if (fs.existsSync(path.join(skillsDir, fileName))) {
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
      body: cleanBody,
    };
    fs.writeFileSync(
      path.join(skillsDir, fileName),
      serializeSkillFile(skill),
      "utf8",
    );
    return { ...skill, fileName };
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
    fs.unlinkSync(path.join(skillsDir, fileName));
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
        fs.writeFileSync(
          path.join(archiveDir, fileName),
          serializeSkillFile(skill),
          "utf8",
        );
        fs.unlinkSync(path.join(skillsDir, fileName));
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
    viewSkill,
    touchSkillUsage,
    createSkill,
    updateSkill,
    deleteSkill,
    pruneStaleSkills,
  };
}

module.exports = {
  createSkillsStore,
  parseSkillFile,
  serializeSkillFile,
  slugify,
  extractSkillScript,
  extractSkillInputs,
};
