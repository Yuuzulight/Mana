// Plain JS, no Obsidian dependency, so it can run under `node --test`.

function buildMemoryUrl(serverUrl) {
  return `${serverUrl.replace(/\/+$/, "")}/api/memory`;
}

function buildMemoryNotesUrl(serverUrl) {
  return `${serverUrl.replace(/\/+$/, "")}/api/memory/notes`;
}

async function authorizedFetch(url, apiKey, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401) {
    throw new Error("Mana rejected the API key (401). Check the key in plugin settings.");
  }
  if (!res.ok) {
    throw new Error(`Mana returned ${res.status} ${res.statusText}`);
  }
  return res;
}

async function fetchManaMemory(serverUrl, apiKey, fetchImpl = fetch) {
  const res = await authorizedFetch(buildMemoryUrl(serverUrl), apiKey, fetchImpl);
  return res.text();
}

// Returns an array of { slug, title, body, links } -- one entry per
// cross-session entity/facts/connections note (see buildMemoryNotes on the
// server). Empty array if Mana has no entities/facts/connections yet.
async function fetchManaMemoryNotes(serverUrl, apiKey, fetchImpl = fetch) {
  const res = await authorizedFetch(buildMemoryNotesUrl(serverUrl), apiKey, fetchImpl);
  return res.json();
}

// Issue #935: Mana syncs her facts, views and journal into the vault
// herself (MANA_VAULT_DIR), so the plugin no longer writes facts and never
// writes inside the folders Mana owns there.
const MANA_OWNED_FOLDERS = ["facts", "views", "journal"];

function isManaOwnedPath(vaultPath) {
  const top = String(vaultPath || "").replace(/\\/g, "/").replace(/^(\.?\/)+/, "").split("/")[0].toLowerCase();
  return MANA_OWNED_FOLDERS.includes(top);
}

// Drops the "## Key Facts" section from the summary note.
function withoutKeyFacts(markdown) {
  return String(markdown).replace(/\n## Key Facts\n[\s\S]*?(?=\n## |$)/, "");
}

// Drops the Key Facts note from the linked notes.
function withoutFactNotes(notes) {
  return notes.filter((note) => note.slug !== "key-facts");
}

module.exports = {
  buildMemoryUrl,
  buildMemoryNotesUrl,
  fetchManaMemory,
  fetchManaMemoryNotes,
  isManaOwnedPath,
  withoutKeyFacts,
  withoutFactNotes,
};
