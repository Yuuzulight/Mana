// Issue #935: two-way sync between Mana's remembered facts
// (acp-memory-store.js) and her Obsidian vault (MANA_VAULT_DIR).
//
// Every fact (standing intents included -- an intent is a fact with a
// trigger, so its note just carries a `trigger:` line) is one note:
//   Facts/<key>.md           active
//   Facts/Pending/<key>.md   waiting for the user's OK (approved only in Mana)
//   Facts/Archived/<key>.md  archived or superseded
// A YAML header (status, pinned; trigger/paused for intents; since/source
// are informational) and the fact text as the body. Forgotten ("stale")
// facts have no note.
//
// One sync() does both directions, vault first so the user's edit wins a
// conflict (Mana's value is already in facts-log.jsonl and the fact's own
// history). vault-sync.json (in the memory dir) remembers the hash of every
// note Mana wrote: a note that still matches is Mana's own write (the loop
// guard) and is never read back as an edit; one that differs is the user's.
// A note Mana wrote that is gone was deleted by the user, which archives
// the fact.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FOLDERS = { active: "Facts", pending: "Facts/Pending", archived: "Facts/Archived" };
const FOLDER_STATUS = { facts: "active", "facts/pending": "pending", "facts/archived": "archived" };
// A note bigger than this is skipped (Doctor names it), never read in.
const MAX_NOTE_BYTES = 8 * 1024;
// rememberFact keeps 500 characters; a longer note is skipped rather than
// silently cut.
const MAX_TEXT_CHARS = 500;
const DEBOUNCE_MS = 1500;
// An archived note the user deleted: kept deleted, not written again.
const DELETED = "deleted";
// Views/ and Journal/: Mana writes these, the user only reads them.
const VIEWS_MARKER = "> Written by Mana from her memory: edits here are overwritten. Edit facts in Facts/ instead.";
const VIEWS_REFRESH_MS = 5 * 60 * 1000;
// A journal entry is a short diary paragraph, never a transcript.
const JOURNAL_MAX_CHARS = 1200;
const JOURNAL_SESSION_CHARS = 1500;
const SOURCE_LABELS = {
  user_stated: "you told me",
  model_inferred: "I picked it up in chat",
  tool_derived: "something I read",
  system: "Mana",
  vault_edit: "your vault",
};

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// YYYY-MM-DD in local time ("since" is the user's day, not UTC's).
function localDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hash(content) {
  return crypto.createHash("sha1").update(content).digest("hex");
}

// Key -> filename. Characters Windows or Obsidian links can't take (and
// "%", the escape itself) become %XX, so the name decodes back to the key
// and never holds a path separator. A leading dot (hidden, or ".."), a
// trailing dot/space and device names (CON, NUL...) are escaped too.
// ponytail: a key over 120 characters is cut and tagged with a hash; such
// a note still binds to its fact through the rendered name.
function noteName(key) {
  const escape = (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  let name = String(key).replace(/[<>:"/\\|?*#^[\]%\u0000-\u001f]/g, escape);
  name = name.replace(/^\./, escape).replace(/[. ]$/, escape);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = escape(name[0]) + name.slice(1);
  if (name.length > 120) name = `${name.slice(0, 110)}~${hash(String(key)).slice(0, 8)}`;
  return name;
}

function keyFromName(name) {
  try {
    return cleanText(decodeURIComponent(name));
  } catch (e) {
    return cleanText(name);
  }
}

function statusOf(fact) {
  if (fact.status === "pending") return "pending";
  if (fact.status === "archived" || (fact.status === "active" && fact.invalidatedAt)) return "archived";
  return fact.status === "active" ? "active" : null;
}

function renderNote(fact) {
  const lines = ["---", `status: ${statusOf(fact)}`, `pinned: ${Boolean(fact.pinned)}`];
  if (fact.trigger) lines.push(`trigger: ${JSON.stringify(fact.trigger)}`, `paused: ${Boolean(fact.paused)}`);
  lines.push(`since: ${localDate(fact.validFrom || fact.createdAt)}`);
  const source = SOURCE_LABELS[fact.origin?.kind];
  if (source) lines.push(`source: ${source}${fact.unverifiedSource ? " (unverified)" : ""}`);
  lines.push("---", "", fact.text, "");
  return lines.join("\n");
}

function parseScalar(raw) {
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return undefined;
    }
  }
  if (raw.startsWith("'")) {
    return raw.length > 1 && raw.endsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : undefined;
  }
  if (/^(true|yes)$/i.test(raw)) return true;
  if (/^(false|no)$/i.test(raw)) return false;
  return raw;
}

// Just enough YAML for the header Mana writes: `key: scalar` lines.
// Indented or "- " lines (a tags list Obsidian added) are skipped; any
// other line makes the header broken.
function parseNote(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(content);
  if (!match) return { error: "missing or broken YAML header" };
  const header = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || /^(\s|-\s|#)/.test(line)) continue;
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    const value = kv ? parseScalar(kv[2].trim()) : undefined;
    if (value === undefined) return { error: `broken YAML header line "${line.slice(0, 60)}"` };
    header[kv[1].toLowerCase()] = value;
  }
  return { header, body: cleanText(match[2]) };
}

// options.store: the acp memory store. options.vaultDir: the vault root.
// options.approvalGate: optional -- a brand-new note is stored pending
// either way; with a gate it also asks for the user's OK (toast / Settings >
// Approvals). options.watch: false in tests (sync() by hand).
// options.buildViews: () => [{rel: "Views/...md", body}], the read-only
// views. For the journal: options.runModel, (prompt, maxTokens) => reply
// or null from a model that's already loaded (never loads one), and
// options.isGaming.
function createMemoryVault(options = {}) {
  const store = options.store;
  const vaultDir = path.resolve(options.vaultDir);
  const approvalGate = options.approvalGate || null;
  const statePath = path.join(store.dataDir, "vault-sync.json");
  const log = options.log || ((message) => console.log(`Memory vault: ${message}`));
  const status = { vaultDir, writable: null, notes: 0, skipped: [], lastSyncAt: null, error: null };
  let timer = null;
  let watcher = null;
  let viewsTimer = null;
  let lastJournalAt = null;

  const full = (rel) => path.join(vaultDir, rel);
  // Views and the journal never create the vault either (see sync()).
  const vaultExists = () => fs.existsSync(vaultDir) && fs.statSync(vaultDir).isDirectory();

  function loadState() {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (state.vaultDir === vaultDir && state.notes && typeof state.notes === "object") return state;
    } catch (e) {
      // Missing or unreadable: start over (notes already there are adopted).
    }
    return { vaultDir, notes: {} };
  }

  function saveState(state) {
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
    fs.renameSync(tmp, statePath);
  }

  // Only .md files directly in the three folders; dot/~ files (Obsidian's
  // and editors' temp files) are ignored.
  function scanNotes() {
    const notes = new Map();
    for (const folder of Object.values(FOLDERS)) {
      let entries = [];
      try {
        entries = fs.readdirSync(full(folder), { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !/\.md$/i.test(entry.name) || /^[.~]/.test(entry.name)) continue;
        const rel = `${folder}/${entry.name}`;
        const note = { id: rel.toLowerCase(), rel, folder, name: entry.name.slice(0, -3), content: null, hash: null };
        try {
          if (fs.statSync(full(rel)).size > MAX_NOTE_BYTES) {
            note.error = `bigger than ${MAX_NOTE_BYTES / 1024} KB`;
          } else {
            note.content = fs.readFileSync(full(rel), "utf8");
            note.hash = hash(note.content);
          }
        } catch (e) {
          note.error = `unreadable (${e.code || e.message})`;
        }
        notes.set(note.id, note);
      }
    }
    return notes;
  }

  // The fact a note belongs to: same rendered filename, preferring the one
  // whose status matches the note's folder, then a live one, then the newest.
  function bindFact(note, facts) {
    const name = note.name.toLowerCase();
    const matches = facts
      .filter((f) => statusOf(f) && noteName(f.key).toLowerCase() === name)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const folderStatus = FOLDER_STATUS[note.folder.toLowerCase()];
    return (
      matches.find((f) => statusOf(f) === folderStatus) ||
      matches.find((f) => statusOf(f) !== "archived") ||
      matches[0] ||
      null
    );
  }

  function requestOk(key, text) {
    if (!approvalGate) return;
    approvalGate
      .requestApproval("memory-vault-note", {
        summary: `Remember "${key}" from your vault: ${text}`,
        payload: { key, action: "confirm", source: "vault", expectedVersions: [{ key, version: store.getFactVersion(key) }] },
        scanText: text,
        // A new note always needs the user's own OK: no grant, always-allow
        // or Guardian verdict skips it.
        forceReview: true,
      })
      .catch((e) => log(`couldn't ask about "${key}": ${e?.message || e}`));
  }

  // Returns {key} when the note was taken in (Mana may now rewrite or move
  // it), or a string saying why it was skipped.
  function applyNote(note, facts) {
    if (note.error) return note.error;
    const parsed = parseNote(note.content);
    if (parsed.error) return parsed.error;
    const { header, body } = parsed;
    if (!body) return "empty note";
    if (body.length > MAX_TEXT_CHARS) return `text longer than ${MAX_TEXT_CHARS} characters`;
    const origin = { kind: "vault_edit" };
    const trigger = typeof header.trigger === "string" ? cleanText(header.trigger) : "";
    const fact = bindFact(note, facts);

    if (!fact) {
      const key = keyFromName(note.name);
      if (!key) return "no fact key in the filename";
      store.rememberFact({
        key,
        text: body,
        source: "vault",
        origin,
        ...(trigger ? { trigger, triggerUserWords: trigger } : {}),
      });
      log(`new note "${note.rel}" is waiting for your OK in Mana.`);
      requestOk(key, body);
      return { key };
    }

    const current = statusOf(fact);
    const headerStatus = ["active", "archived", "pending"].includes(header.status) ? header.status : current;
    const folderStatus = FOLDER_STATUS[note.folder.toLowerCase()];
    // An edited status line wins; otherwise the folder the note is in now
    // (moved in or out of Archived/).
    const wanted = headerStatus !== current ? headerStatus : folderStatus;
    const textChanged = body !== fact.text;
    const triggerChanged = Boolean(fact.trigger && trigger && trigger !== fact.trigger);

    if (current === "archived" && wanted === "active") {
      if (!store.restoreFact(fact, origin).restored) {
        log(`can't restore "${fact.key}": another fact already has that key.`);
        return { key: fact.key };
      }
    } else if (current !== "active") {
      if (wanted !== current) {
        log(`ignored the status change on "${note.rel}"${current === "pending" ? ": pending facts are approved only in Mana" : ""}.`);
      }
      if (current === "archived") {
        if (textChanged) log(`ignored the edit to archived "${note.rel}": move it back into Facts/ first.`);
        return { key: fact.key };
      }
    }

    if (textChanged || triggerChanged) {
      store.rememberFact({
        key: fact.key,
        text: body,
        action: "patch",
        source: "vault",
        origin,
        // A vault edit never vouches for text Mana couldn't trace to the
        // user; only confirming in Mana clears that.
        ...(fact.unverifiedSource ? { unverifiedSource: true } : {}),
        ...(triggerChanged ? { trigger, triggerUserWords: trigger } : {}),
      });
      if (current === "pending") requestOk(fact.key, body);
    }
    if (current === "pending") return { key: fact.key };
    if (typeof header.pinned === "boolean" && header.pinned !== Boolean(fact.pinned)) {
      store.setFactPinned(fact.key, header.pinned);
    }
    if (fact.trigger && typeof header.paused === "boolean" && header.paused !== Boolean(fact.paused)) {
      store.setFactPaused(fact.key, header.paused);
    }
    if (wanted === "archived" && current === "active") {
      store.rememberFact({ key: fact.key, action: "archive", source: "vault", origin });
    } else if (wanted === "pending" && current === "active") {
      log(`ignored the status change on "${note.rel}": a fact can't go back to pending.`);
    }
    return { key: fact.key };
  }

  // A note Mana wrote is gone: archive its fact (never a hard delete).
  // Returns true for a deleted archived note, which then stays deleted.
  // A fact whose other note was just taken in was moved, not deleted.
  function applyDeletion(id, facts, takenKeys) {
    const slash = id.lastIndexOf("/");
    const note = { folder: id.slice(0, slash), name: id.slice(slash + 1, -3) };
    const fact = bindFact(note, facts);
    if (!fact || takenKeys.has(fact.key.toLowerCase())) return false;
    if (statusOf(fact) === "archived") return note.folder === FOLDERS.archived.toLowerCase();
    store.rememberFact({ key: fact.key, action: "archive", source: "vault", origin: { kind: "vault_edit" } });
    log(`"${id}" was deleted, so "${fact.key}" is archived (move its note back into Facts/ to restore it).`);
    return false;
  }

  function desiredNotes(facts) {
    const desired = new Map();
    const oldestFirst = [...facts].sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));
    for (const fact of oldestFirst) {
      const noteStatus = statusOf(fact);
      if (!noteStatus) continue;
      const rel = `${FOLDERS[noteStatus]}/${noteName(fact.key)}.md`;
      desired.set(rel.toLowerCase(), { rel, content: renderNote(fact) });
    }
    return desired;
  }

  function writeNote(rel, content) {
    const target = full(rel);
    // noteName never yields a separator; this is the backstop.
    if (!Object.values(FOLDERS).some((f) => path.dirname(target) === full(f))) throw new Error(`unsafe note path ${rel}`);
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp`);
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, target);
  }

  function sync() {
    const result = { applied: 0, written: 0, removed: 0, skipped: [] };
    try {
      // Never creates the vault itself: a typo in MANA_VAULT_DIR shouldn't
      // leave a stray one behind (Doctor shows the error instead).
      if (!fs.statSync(vaultDir).isDirectory()) throw new Error(`${vaultDir} is not a folder`);
      // No Facts/ folder (first start, or a new vault): start fresh rather
      // than read every missing note as a deletion.
      const fresh = !fs.existsSync(full(FOLDERS.active));
      for (const folder of Object.values(FOLDERS)) fs.mkdirSync(full(folder), { recursive: true });
      const state = fresh ? { vaultDir, notes: {} } : loadState();
      const onDisk = scanNotes();
      const taken = new Set();
      const takenKeys = new Set();

      // Vault -> Mana.
      for (const note of onDisk.values()) {
        if (note.hash && note.hash === state.notes[note.id]) continue;
        let outcome;
        try {
          outcome = applyNote(note, store.listFacts());
        } catch (e) {
          outcome = e?.message || String(e);
        }
        if (typeof outcome === "string") {
          result.skipped.push({ file: note.rel, reason: outcome });
          continue;
        }
        taken.add(note.id);
        takenKeys.add(outcome.key.toLowerCase());
        result.applied += 1;
      }
      for (const [id, noteHash] of Object.entries(state.notes)) {
        if (onDisk.has(id) || noteHash === DELETED) continue;
        if (applyDeletion(id, store.listFacts(), takenKeys)) {
          state.notes[id] = DELETED;
        } else {
          delete state.notes[id];
        }
        result.applied += 1;
      }

      // Mana -> vault. A note the user changed that couldn't be taken in
      // (broken header...) is left alone until they fix it.
      const desired = desiredNotes(store.listFacts());
      const ours = (id) => {
        const note = onDisk.get(id);
        return !note || taken.has(id) || (note.hash && note.hash === state.notes[id]);
      };
      for (const [id, want] of desired) {
        if ((state.notes[id] === DELETED && !onDisk.has(id)) || !ours(id)) continue;
        if (onDisk.get(id)?.content !== want.content) {
          writeNote(want.rel, want.content);
          result.written += 1;
        }
        state.notes[id] = hash(want.content);
      }
      for (const id of new Set([...Object.keys(state.notes), ...taken])) {
        if (desired.has(id)) continue;
        if (state.notes[id] !== DELETED && onDisk.has(id) && ours(id)) {
          fs.unlinkSync(full(onDisk.get(id).rel));
          result.removed += 1;
        }
        delete state.notes[id];
      }
      saveState(state);

      const known = new Set(status.skipped.map((s) => s.file));
      for (const s of result.skipped) if (!known.has(s.file)) log(`skipped "${s.file}": ${s.reason}.`);
      Object.assign(status, {
        writable: true,
        notes: desired.size,
        skipped: result.skipped,
        lastSyncAt: new Date().toISOString(),
        error: null,
      });
    } catch (e) {
      status.error = e?.message || String(e);
      if (["EACCES", "EPERM", "EROFS", "ENOENT"].includes(e?.code)) status.writable = false;
      log(`sync failed: ${status.error}`);
    }
    watch();
    return result;
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(sync, DEBOUNCE_MS);
    timer.unref?.();
  }

  // Facts/ and its two subfolders, .md files only. (Re)started after each
  // sync, so a Facts/ folder deleted and recreated is watched again.
  function watch() {
    if (options.watch === false || watcher) return;
    try {
      watcher = fs.watch(full(FOLDERS.active), { recursive: true }, (event, filename) => {
        const parts = filename ? String(filename).split(/[\\/]/) : null;
        const inScope =
          !parts ||
          (/\.md$/i.test(parts[parts.length - 1]) &&
            (parts.length === 1 || (parts.length === 2 && /^(pending|archived)$/i.test(parts[0]))));
        if (inScope) schedule();
      });
      watcher.on("error", (e) => {
        log(`watcher stopped: ${e?.message || e}`);
        watcher.close();
        watcher = null;
      });
    } catch (e) {
      watcher = null;
    }
  }

  // Rewrites each view whose content changed (an edit of the user's
  // included) and removes old ones -- only files starting with the marker.
  function refreshViews() {
    if (!options.buildViews || !vaultExists()) return;
    try {
      const desired = new Map();
      for (const view of options.buildViews()) {
        const target = full(view.rel);
        if (path.relative(full("Views"), target).startsWith("..")) throw new Error(`unsafe view path ${view.rel}`);
        desired.set(target.toLowerCase(), { target, content: `${VIEWS_MARKER}\n\n${view.body}` });
      }
      for (const { target, content } of desired.values()) {
        let current = null;
        try {
          current = fs.readFileSync(target, "utf8");
        } catch (e) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
        }
        if (current !== content) fs.writeFileSync(target, content, "utf8");
      }
      for (const dir of [full("Views"), full("Views/Entities")]) {
        let names = [];
        try {
          names = fs.readdirSync(dir).filter((name) => /\.md$/i.test(name));
        } catch (e) {
          continue;
        }
        for (const name of names) {
          const file = path.join(dir, name);
          if (!desired.has(file.toLowerCase()) && fs.readFileSync(file, "utf8").startsWith(VIEWS_MARKER)) {
            fs.unlinkSync(file);
          }
        }
      }
    } catch (e) {
      log(`views not refreshed: ${e?.message || e}`);
    }
  }

  // Appends a short diary entry about what happened since the last one
  // today to Journal/YYYY-MM-DD.md, linking the facts it touched. Called at
  // session end (idle). Skipped while gaming, when nothing happened, and
  // when no model is already loaded. Returns whether it wrote one.
  async function writeJournal() {
    if (!options.runModel || options.isGaming?.() || !vaultExists()) return false;
    try {
      const nowDate = new Date();
      const day = localDate(nowDate.toISOString());
      const rel = `Journal/${day}.md`;
      const startOfDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).toISOString();
      let since = lastJournalAt;
      if (!since) {
        try {
          since = fs.statSync(full(rel)).mtime.toISOString();
        } catch (e) {
          since = startOfDay;
        }
      }
      if (since < startOfDay) since = startOfDay;
      const facts = store.listFacts().filter((f) => statusOf(f) && String(f.updatedAt || "") > since);
      const summaries = store
        .listSessions()
        .filter((s) => String(s.updatedAt || "") > since)
        .slice(0, 3)
        .map((s) => String(store.getSession(s.sessionId)?.summary || "").slice(-JOURNAL_SESSION_CHARS))
        .filter(Boolean);
      if (!facts.length && !summaries.length) return false;

      const prompt = [
        "You are Mana. Write a short private diary entry (2-4 sentences, first person) about your time with the user since your last entry today.",
        "Don't quote the conversation and don't list everything; reply with the entry only.",
        summaries.length ? `\nWhat we talked about (summaries):\n${summaries.join("\n\n")}` : "",
        facts.length ? `\nFacts I remembered or changed:\n${facts.map((f) => `- ${f.key}: ${f.text}`).join("\n")}` : "",
      ].join("\n");
      const reply = cleanText(await options.runModel(prompt, 300)).slice(0, JOURNAL_MAX_CHARS);
      if (!reply) return false;

      const links = [...new Set(facts.map((f) => `[[${noteName(f.key)}]]`))];
      const entry = `## ${nowDate.toTimeString().slice(0, 5)}\n\n${reply}\n${links.length ? `\nFacts: ${links.join(", ")}\n` : ""}\n`;
      fs.mkdirSync(full("Journal"), { recursive: true });
      if (!fs.existsSync(full(rel))) fs.writeFileSync(full(rel), `# ${day}\n\n`, "utf8");
      fs.appendFileSync(full(rel), entry, "utf8");
      lastJournalAt = nowDate.toISOString();
      return true;
    } catch (e) {
      log(`journal not written: ${e?.message || e}`);
      return false;
    }
  }

  function start() {
    store.onFactsChanged(schedule);
    sync();
    refreshViews();
    viewsTimer = setInterval(refreshViews, VIEWS_REFRESH_MS);
    viewsTimer.unref?.();
  }

  function stop() {
    clearTimeout(timer);
    clearInterval(viewsTimer);
    if (watcher) watcher.close();
    watcher = null;
  }

  return { start, stop, sync, refreshViews, writeJournal, getStatus: () => ({ ...status }) };
}

module.exports = { VIEWS_MARKER, createMemoryVault, noteName, keyFromName, parseNote, renderNote };
