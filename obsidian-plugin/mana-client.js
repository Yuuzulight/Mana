// Plain JS, no Obsidian dependency, so it can run under `node --test`.

function buildMemoryUrl(serverUrl) {
  return `${serverUrl.replace(/\/+$/, "")}/api/memory`;
}

async function fetchManaMemory(serverUrl, apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(buildMemoryUrl(serverUrl), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401) {
    throw new Error("Mana rejected the API key (401). Check the key in plugin settings.");
  }
  if (!res.ok) {
    throw new Error(`Mana returned ${res.status} ${res.statusText}`);
  }
  return res.text();
}

module.exports = { buildMemoryUrl, fetchManaMemory };
