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
// the fact (after MISSING_GRACE_MS), or renamed, which renames it.
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
// A note Mana wrote that's gone is archived only when two syncs this far
// apart found it missing (applyDeletion); until then applyDeletion WAITs.
const MISSING_GRACE_MS = 30 * 1000;
const WAIT = "wait";
// A sync this often whatever the watcher does (poll()): the fallback when
// it's down, and a catch-up for events it missed.
const POLL_MS = 60 * 1000;
// The header fields Mana writes (renderNote); any other key is the user's.
const OWN_FIELDS = new Set(["status", "pinned", "trigger", "paused", "since", "source"]);
// An archived note the user deleted: kept deleted, not written again.
const DELETED = "deleted";
// Views/ and Journal/: Mana writes these, the user only reads them.
const VIEWS_MARKER = "> Written by Mana from her memory: edits here are overwritten. Edit facts in Facts/ instead.";
const VIEWS_REFRESH_MS = 5 * 60 * 1000;
// #1389: the read-only hygiene walk behind getStatus().findings never visits
// more than this many entries, goes deeper than this, or lists more findings.
const HYGIENE_MAX_ENTRIES = 1000;
const HYGIENE_MAX_DEPTH = 4;
const HYGIENE_MAX_FINDINGS = 50;
// Folders the user keeps on purpose as history: never looked into.
const HYGIENE_SKIP_DIRS = new Set(["legacy", "reference"]);
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

// A sync tool's conflict copy of a note: Syncthing's ".sync-conflict-",
// Obsidian Sync's / Dropbox's "(conflicted copy ...)", and OneDrive's
// "Name-PCNAME" / "Name 2" -- those two only when "Name" is a fact's note,
// since they're also ordinary names.
function isConflictCopy(name, facts) {
  if (/\.sync-conflict-|\(.*conflict(ed)? copy/i.test(name)) return true;
  const bases = [];
  const numbered = / \d+$/.exec(name);
  if (numbered) bases.push(name.slice(0, numbered.index));
  for (let i = name.indexOf("-"); i > 0; i = name.indexOf("-", i + 1)) {
    if (/^(?=.*[A-Z])[A-Z0-9-]+$/.test(name.slice(i + 1))) bases.push(name.slice(0, i));
  }
  if (!bases.length) return false;
  const names = new Set(facts.filter(statusOf).map((f) => noteName(f.key).toLowerCase()));
  return bases.some((base) => names.has(base.toLowerCase()));
}

function statusOf(fact) {
  if (fact.status === "pending") return "pending";
  if (fact.status === "archived" || (fact.status === "active" && fact.invalidatedAt)) return "archived";
  return fact.status === "active" ? "active" : null;
}

// `kept`: the note already on disk (parseNote's result), if any. Its header
// lines that aren't Mana's stay, and so does its body's layout while the
// body still says the same as the fact (the fact's text has single spaces).
function renderNote(fact, kept = {}) {
  const lines = ["---", `status: ${statusOf(fact)}`, `pinned: ${Boolean(fact.pinned)}`];
  if (fact.trigger) lines.push(`trigger: ${JSON.stringify(fact.trigger)}`, `paused: ${Boolean(fact.paused)}`);
  lines.push(`since: ${localDate(fact.validFrom || fact.createdAt)}`);
  const source = SOURCE_LABELS[fact.origin?.kind];
  if (source) lines.push(`source: ${source}${fact.unverifiedSource ? " (unverified)" : ""}`);
  const body = kept.rawBody && cleanText(kept.rawBody) === fact.text ? kept.rawBody : fact.text;
  lines.push(...(kept.extra || []), "---", "", body, "");
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

// Just enough YAML for the header Mana writes: `key: scalar` lines for her
// own fields. Every other key (tags, aliases, a plugin's), with its
// indented / "- " / blank lines, and comments go to `extra` as written, so
// the note keeps them. Any other line makes the header broken. A UTF-8 BOM
// (Notepad) is fine. `body` is the text as a fact (single spaces);
// `rawBody` keeps its line breaks.
function parseNote(content) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(content);
  if (!match) return { error: "missing or broken YAML header" };
  const header = {};
  const extra = [];
  let keeping = false;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || /^(\s|-(\s|$))/.test(line)) {
      if (keeping) extra.push(line);
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    keeping = line.startsWith("#") || Boolean(kv && !OWN_FIELDS.has(kv[1].toLowerCase()));
    if (keeping) {
      extra.push(line);
      continue;
    }
    const value = kv ? parseScalar(kv[2].trim()) : undefined;
    if (value === undefined) return { error: `broken YAML header line "${line.slice(0, 60)}"` };
    header[kv[1].toLowerCase()] = value;
  }
  while (extra.length && !extra[extra.length - 1].trim()) extra.pop();
  const rawBody = String(match[2] || "").replace(/\r\n/g, "\n").replace(/^([ \t]*\n)+/, "").trimEnd();
  return { header, extra, body: cleanText(rawBody), rawBody };
}

// options.store: the acp memory store. options.vaultDir: the vault root.
// options.approvalGate: optional -- a brand-new note is stored pending
// either way; with a gate it also asks for the user's OK (toast / Settings >
// Approvals). options.watch: false in tests (sync() by hand); options.now,
// a clock for tests.
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
  const now = options.now || Date.now;
  let timer = null;
  let watcher = null;
  let viewsTimer = null;
  let lastJournalAt = null;
  let started = false;
  let pollTimer = null;
  let watchedIno = null;
  // Note id -> when a sync first found Mana's note missing (applyDeletion).
  const missingSince = new Map();

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

  // A new note or a pin change always needs the user's own OK: no grant,
  // always-allow or Guardian verdict skips it.
  function ask(actionType, key, request) {
    if (!approvalGate) return;
    approvalGate
      .requestApproval(actionType, { ...request, forceReview: true })
      .catch((e) => log(`couldn't ask about "${key}": ${e?.message || e}`));
  }

  function requestOk(key, text) {
    ask("memory-vault-note", key, {
      summary: `Remember "${key}" from your vault: ${text}`,
      payload: { key, action: "confirm", source: "vault", expectedVersions: [{ key, version: store.getFactVersion(key) }] },
      scanText: text,
    });
  }

  // Returns {key} when the note was taken in (Mana may now rewrite or move
  // it), or a string saying why it was skipped. missing: ids of Mana's notes
  // that are gone from disk (a rename's old name).
  function applyNote(note, facts, missing) {
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
      if (isConflictCopy(note.name, facts)) return "a sync-conflict copy, ignored";
      // Same text as an active fact whose note just went missing: the note
      // was renamed, so the fact is (instead of archive + a new pending one).
      const renamed =
        note.folder === FOLDERS.active &&
        facts.find(
          (f) => statusOf(f) === "active" && f.text === body && missing.has(`${FOLDERS.active}/${noteName(f.key)}.md`.toLowerCase()),
        );
      if (renamed && store.renameFact(renamed, key, origin).renamed) {
        log(`"${renamed.key}" was renamed to "${key}" in the vault.`);
        return applyNote(note, store.listFacts(), new Set());
      }
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
    // A pinned fact is in every prompt, so pinning is asked about like a new
    // note (executor in server.js); the note shows the current pin until
    // then. Unpinning only takes it out of the prompt: applied directly.
    if (header.pinned === false && fact.pinned) {
      store.setFactPinned(fact.key, false);
    } else if (header.pinned === true && !fact.pinned) {
      ask("memory-vault-pin", fact.key, {
        summary: `Pin "${fact.key}" from your vault: ${fact.text}`,
        payload: { key: fact.key, pinned: true },
      });
      log(`pinning "${note.rel}" is waiting for your OK in Mana.`);
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

  // A note Mana wrote is gone: archive its fact (never a hard delete), once
  // it's been missing for two syncs MISSING_GRACE_MS apart (a sync tool
  // replacing the file, an editor's delete-and-rewrite); until then WAIT.
  // Returns true for a deleted archived note, which then stays deleted.
  // A fact whose other note was just taken in was moved, not deleted.
  function applyDeletion(id, facts, takenKeys) {
    const slash = id.lastIndexOf("/");
    const note = { folder: id.slice(0, slash), name: id.slice(slash + 1, -3) };
    const fact = bindFact(note, facts);
    if (!fact || takenKeys.has(fact.key.toLowerCase())) return false;
    if (!missingSince.has(id)) missingSince.set(id, now());
    if (now() - missingSince.get(id) < MISSING_GRACE_MS) return WAIT;
    if (statusOf(fact) === "archived") return note.folder === FOLDERS.archived.toLowerCase();
    store.rememberFact({ key: fact.key, action: "archive", source: "vault", origin: { kind: "vault_edit" } });
    log(`"${id}" was deleted, so "${fact.key}" is archived (move its note back into Facts/ to restore it).`);
    return false;
  }

  // onDisk: the scanned notes, whose own header lines and layout a
  // rewrite keeps (renderNote) -- from the note at the same path, or one of
  // the same name in another folder (the fact moved).
  function desiredNotes(facts, onDisk) {
    const parsed = new Map();
    for (const note of onDisk.values()) {
      const p = note.content === null ? null : parseNote(note.content);
      if (!p || p.error) continue;
      parsed.set(note.id, p);
      if (!parsed.has(note.name.toLowerCase())) parsed.set(note.name.toLowerCase(), p);
    }
    const desired = new Map();
    const oldestFirst = [...facts].sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));
    for (const fact of oldestFirst) {
      const noteStatus = statusOf(fact);
      if (!noteStatus) continue;
      const name = noteName(fact.key);
      const rel = `${FOLDERS[noteStatus]}/${name}.md`;
      const kept = parsed.get(rel.toLowerCase()) || parsed.get(name.toLowerCase());
      desired.set(rel.toLowerCase(), { rel, content: renderNote(fact, kept) });
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
      const state = fresh ? { ...loadState(), notes: {} } : loadState();
      const onDisk = scanNotes();
      const taken = new Set();
      const takenKeys = new Set();
      const missing = new Set(Object.keys(state.notes).filter((id) => !onDisk.has(id) && state.notes[id] !== DELETED));
      const waiting = new Set();

      // Vault -> Mana.
      for (const note of onDisk.values()) {
        if (note.hash && note.hash === state.notes[note.id]) continue;
        let outcome;
        try {
          outcome = applyNote(note, store.listFacts(), missing);
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
      for (const id of missing) {
        const deleted = applyDeletion(id, store.listFacts(), takenKeys);
        if (deleted === WAIT) {
          waiting.add(id);
          continue;
        }
        if (deleted) {
          state.notes[id] = DELETED;
        } else {
          delete state.notes[id];
        }
        result.applied += 1;
      }
      for (const id of missingSince.keys()) if (!waiting.has(id)) missingSince.delete(id);

      // Mana -> vault. A note the user changed that couldn't be taken in
      // (broken header...) is left alone until they fix it, and one that's
      // waiting out its grace isn't written back.
      const desired = desiredNotes(store.listFacts(), onDisk);
      const ours = (id) => {
        const note = onDisk.get(id);
        return !note || taken.has(id) || (note.hash && note.hash === state.notes[id]);
      };
      for (const [id, want] of desired) {
        if ((state.notes[id] === DELETED && !onDisk.has(id)) || !ours(id) || waiting.has(id)) continue;
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
    // A missing note is looked at again once its grace is up.
    if (started && missingSince.size) schedule(MISSING_GRACE_MS + DEBOUNCE_MS);
    return result;
  }

  function schedule(delay = DEBOUNCE_MS) {
    clearTimeout(timer);
    timer = setTimeout(sync, delay);
    timer.unref?.();
  }

  // Facts/ and its two subfolders, .md files only. (Re)started after each
  // sync, so a Facts/ folder deleted and recreated is watched again.
  function watch() {
    if (options.watch === false || watcher || !started) return;
    try {
      const w = fs.watch(full(FOLDERS.active), { recursive: true }, (event, filename) => {
        const parts = filename ? String(filename).split(/[\\/]/) : null;
        const inScope =
          !parts ||
          (/\.md$/i.test(parts[parts.length - 1]) &&
            (parts.length === 1 || (parts.length === 2 && /^(pending|archived)$/i.test(parts[0]))));
        if (inScope) schedule();
      });
      w.on("error", (e) => {
        log(`watcher stopped: ${e?.message || e}`);
        w.close();
        if (watcher === w) watcher = null;
      });
      watcher = w;
      watchedIno = fs.statSync(full(FOLDERS.active)).ino;
    } catch (e) {
      watcher?.close();
      watcher = null;
    }
  }

  // Every POLL_MS: a watcher on a Facts/ folder that was since deleted or
  // replaced hears nothing, so it's restarted; then a sync, which also
  // restarts a watcher that died and catches whatever it missed.
  function poll() {
    if (watcher) {
      let ino = null;
      try {
        ino = fs.statSync(full(FOLDERS.active)).ino;
      } catch (e) {
        // Gone: sync() recreates it.
      }
      if (ino !== watchedIno) {
        log("Facts/ was replaced; restarting the file watcher.");
        watcher.close();
        watcher = null;
      }
    }
    sync();
  }

  // Views/ and Journal/ files Mana created, as vault-relative lower-case
  // paths in vault-sync.json's `created`: she only writes to or removes
  // those (and, for views written before this list, files starting with
  // the marker), never a file of the user's that happens to have the name.
  const relOf = (target) => path.relative(vaultDir, target).split(path.sep).join("/").toLowerCase();
  function saveCreated(state, created) {
    const list = [...created].sort();
    if (JSON.stringify(list) === JSON.stringify(state.created || [])) return;
    state.created = list;
    saveState(state);
  }
  const noticed = new Set();
  function leaveAlone(target) {
    if (noticed.has(target)) return;
    noticed.add(target);
    log(`left "${relOf(target)}" alone: Mana didn't create it.`);
  }

  // Rewrites each view whose content changed (an edit of the user's
  // included) and removes old ones -- only Mana's own files.
  function refreshViews() {
    if (!options.buildViews || !vaultExists()) return;
    try {
      const state = loadState();
      const created = new Set(state.created || []);
      const mine = (target, current) => created.has(relOf(target)) || current.startsWith(VIEWS_MARKER);
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
        if (current !== null && !mine(target, current)) {
          leaveAlone(target);
          continue;
        }
        if (current !== content) fs.writeFileSync(target, content, "utf8");
        created.add(relOf(target));
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
          if (!desired.has(file.toLowerCase()) && mine(file, fs.readFileSync(file, "utf8"))) {
            fs.unlinkSync(file);
            created.delete(relOf(file));
          }
        }
      }
      saveCreated(state, created);
    } catch (e) {
      log(`views not refreshed: ${e?.message || e}`);
    }
  }

  // Today's journal file: Journal/<day>.md, or "<day> (Mana).md" when the
  // user (a daily-notes plugin...) already made that one; null when both
  // are taken.
  function journalFile(day, created) {
    return (
      [`Journal/${day}.md`, `Journal/${day} (Mana).md`].find(
        (rel) => created.has(rel.toLowerCase()) || !fs.existsSync(full(rel)),
      ) || null
    );
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
      let state = loadState();
      let created = new Set(state.created || []);
      let rel = journalFile(day, created);
      if (!rel) {
        leaveAlone(full(`Journal/${day}.md`));
        return false;
      }
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
      // Again: the user may have made the day's file while the model ran.
      state = loadState();
      created = new Set(state.created || []);
      rel = journalFile(day, created);
      if (!rel) {
        leaveAlone(full(`Journal/${day}.md`));
        return false;
      }
      fs.mkdirSync(full("Journal"), { recursive: true });
      if (!fs.existsSync(full(rel))) {
        fs.writeFileSync(full(rel), `# ${day}\n\n`, "utf8");
        created.add(rel.toLowerCase());
        saveCreated(state, created);
      }
      fs.appendFileSync(full(rel), entry, "utf8");
      lastJournalAt = nowDate.toISOString();
      return true;
    } catch (e) {
      log(`journal not written: ${e?.message || e}`);
      return false;
    }
  }

  // #1389: read-only walk for what Doctor should tell the user: fact-shaped
  // notes outside the three Facts folders (never read today), missing
  // folders, and output that competes with Mana's (an old "Mana Memory.md",
  // a Views/ file without her marker). Legacy/ and Reference/ are skipped.
  // Reads at most HYGIENE_MAX_ENTRIES entries, only small .md files; never
  // writes. Paths are relative to the vault.
  function scanHygiene() {
    const findings = [];
    if (!vaultExists()) return { findings, truncated: false };
    const add = (kind, rel, why, fix) => findings.length < HYGIENE_MAX_FINDINGS && findings.push({ kind, path: rel, why, fix });
    const created = new Set(loadState().created || []);
    const factFolders = new Set(Object.values(FOLDERS).map((f) => f.toLowerCase()));
    if (status.lastSyncAt) {
      const expected = [...Object.values(FOLDERS), ...(options.buildViews ? ["Views"] : [])];
      for (const folder of expected) {
        if (fs.existsSync(full(folder))) continue;
        add("missing-structure", folder, "Mana expects this folder and it isn't there.", "Mana recreates it on her next sync; if it keeps vanishing, check what removes it.");
      }
    }
    let visited = 0;
    let truncated = false;
    const queue = [{ rel: "", depth: 0 }];
    while (queue.length && !truncated) {
      const { rel: dirRel, depth } = queue.shift();
      const dirLower = dirRel.toLowerCase();
      const inViews = dirLower === "views" || dirLower.startsWith("views/");
      let entries = [];
      try {
        entries = fs.readdirSync(full(dirRel), { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const entry of entries) {
        if (++visited > HYGIENE_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        const name = entry.name;
        const rel = dirRel ? `${dirRel}/${name}` : name;
        if (/^[.~]/.test(name)) continue;
        if (entry.isDirectory()) {
          const lower = name.toLowerCase();
          if (HYGIENE_SKIP_DIRS.has(lower) || (!dirRel && lower === "journal")) continue;
          if (depth < HYGIENE_MAX_DEPTH) queue.push({ rel, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile() || !/\.md$/i.test(name)) continue;
        if (!dirRel && /^mana memory\.md$/i.test(name)) {
          add("competing-output", rel, "An older single-file memory export that competes with Facts/ and Views/.", "Keep it as history by moving it into a Legacy/ folder, or delete it if you don't need it; Mana never touches it.");
          continue;
        }
        if (factFolders.has(dirLower)) continue;
        try {
          if (fs.statSync(full(rel)).size > MAX_NOTE_BYTES) continue;
          const content = fs.readFileSync(full(rel), "utf8");
          if (inViews) {
            if (!created.has(rel.toLowerCase()) && !content.startsWith(VIEWS_MARKER)) {
              add("unowned-view", rel, "It has no Mana marker, so Mana treats it as yours: she never overwrites or removes it, and won't write a view under this name.", "Rename it or move it out of Views/ if you want Mana to write that view.");
            }
            continue;
          }
          const parsed = parseNote(content);
          if (!parsed.error && parsed.body && ["active", "pending", "archived"].includes(String(parsed.header.status).toLowerCase())) {
            add("misplaced-fact", rel, "It looks like a Mana fact note, but Mana only reads Facts/, Facts/Pending and Facts/Archived.", "Move it into Facts/ to have Mana read it; she never imports or moves it herself.");
          }
        } catch (e) {
          // Unreadable: the sync already reports unreadable notes in Facts/.
        }
      }
    }
    return { findings, truncated };
  }

  // mode: "watching" (file watcher up), "polling" (it's down: only the
  // POLL_MS syncs) or "stopped".
  function getStatus() {
    const { findings, truncated } = scanHygiene();
    return { ...status, mode: !started ? "stopped" : watcher ? "watching" : "polling", findings, findingsTruncated: truncated };
  }

  function start() {
    started = true;
    store.onFactsChanged(() => schedule());
    sync();
    refreshViews();
    viewsTimer = setInterval(refreshViews, VIEWS_REFRESH_MS);
    viewsTimer.unref?.();
    pollTimer = setInterval(poll, POLL_MS);
    pollTimer.unref?.();
  }

  function stop() {
    started = false;
    clearTimeout(timer);
    clearInterval(viewsTimer);
    clearInterval(pollTimer);
    if (watcher) watcher.close();
    watcher = null;
  }

  return { start, stop, sync, refreshViews, writeJournal, getStatus };
}

module.exports = { VIEWS_MARKER, createMemoryVault, noteName, statusOf, keyFromName, parseNote, renderNote };
