// Procedural-memory store (issue #140): each skill is a standalone,
// human-readable `.md` file with a small YAML-like frontmatter block,
// mirroring Hermes Agent's SKILL.md convention. Kept as individual files
// (not one JSON blob like presets-store.js) deliberately -- skills are meant
// to be hand-authored/reviewed one at a time, and a plain .md file is
// something a person can open and edit directly.
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
      status: "active",
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
    status: frontmatter.status || "active",
    body: match[2].trim(),
  };
}

function serializeSkillFile(skill) {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `category: ${skill.category}`,
    `created: ${skill.created}`,
    `lastUsed: ${skill.lastUsed}`,
    `status: ${skill.status}`,
    "---",
    "",
    skill.body,
    "",
  ].join("\n");
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
  function listSkills() {
    return listSkillFiles()
      .map((fileName) => {
        try {
          const skill = readSkill(fileName);
          return {
            name: skill.name,
            description: skill.description,
            category: skill.category,
            status: skill.status,
            lastUsed: skill.lastUsed,
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
  function createSkill({ name, description, category, body }) {
    ensureDir();
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("name is required");
    const cleanDescription = String(description || "").trim();
    if (!cleanDescription) throw new Error("description is required");
    const cleanBody = String(body || "").trim();
    if (!cleanBody) throw new Error("body is required");
    if (findFileForName(cleanName)) {
      throw new Error(`a skill named "${cleanName}" already exists`);
    }

    const timestamp = now();
    const skill = {
      name: cleanName,
      description: cleanDescription,
      category: String(category || "general").trim() || "general",
      created: timestamp,
      lastUsed: timestamp,
      status: "active",
      body: cleanBody,
    };
    const fileName = `${slugify(cleanName)}.md`;
    fs.writeFileSync(
      path.join(skillsDir, fileName),
      serializeSkillFile(skill),
      "utf8",
    );
    return { ...skill, fileName };
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
    pruneStaleSkills,
  };
}

module.exports = {
  createSkillsStore,
  parseSkillFile,
  serializeSkillFile,
  slugify,
};
