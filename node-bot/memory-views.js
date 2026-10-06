// #1387: which remembered entities get a note in her vault's Views/. Uses
// what the store already knows -- the entity types the classifier wrote
// (not_an_entity, canonical aliases) -- plus one rule for candidates it
// hasn't typed yet. Every exclusion says why.

// English filler that capitalised sentence starts turn into "entities"
// ("And", "Because", "Actually"). Only applied to untyped candidates: a
// typed entity named like one ("May", a person) always stays.
const FILLER = new Set(
  (
    "and but or so because actually also anyway then just well maybe really yeah yep nope hmm hm oh ah um uh " +
    "like right sure honestly basically literally still though although if while since after before now today " +
    "tomorrow yesterday here there everything something nothing anything someone everyone hey hi hello sorry " +
    "thank thanks please ok okay yes no not let lets wait btw also"
  ).split(" "),
);
const MIN_UNTYPED_MENTIONS = 2;

// entityIndex: { key: [{ display, sessionId, at }] }; types: the store's
// entity-types.json ({ key: { type, canonicalKey? } }).
// Returns { entities: { key: { display, type, mentions } }, excluded: [{ key, why }] }.
function visibleEntities(entityIndex = {}, types = {}) {
  const entities = {};
  const excluded = [];
  const canonicalOf = (key) => {
    const seen = new Set();
    let k = key;
    while (types[k]?.canonicalKey && !seen.has(k)) {
      seen.add(k);
      k = types[k].canonicalKey;
    }
    return k;
  };
  for (const [key, mentions] of Object.entries(entityIndex)) {
    if (!Array.isArray(mentions) || !mentions.length) continue;
    const canonical = canonicalOf(key);
    const type = types[canonical]?.type || types[key]?.type || null;
    if (type === "not_an_entity") {
      excluded.push({ key, why: "classified as not an entity" });
      continue;
    }
    if (canonical !== key) excluded.push({ key, why: `alias of ${canonical}` });
    const entry = (entities[canonical] ||= { display: null, type, mentions: [] });
    entry.mentions.push(...mentions);
    if (canonical === key || !entry.display) entry.display = mentions[mentions.length - 1].display || key;
  }
  // Untyped candidates: filler words never, single words only once seen twice.
  for (const [key, e] of Object.entries(entities)) {
    if (e.type) continue;
    const singleWord = !/\s/.test(key.trim());
    if (singleWord && FILLER.has(key.toLowerCase())) excluded.push({ key, why: "untyped filler word" });
    else if (singleWord && e.mentions.length < MIN_UNTYPED_MENTIONS) excluded.push({ key, why: `untyped single word mentioned ${e.mentions.length} time` });
    else continue;
    delete entities[key];
  }
  for (const e of Object.values(entities)) e.mentions.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  return { entities, excluded };
}

module.exports = { FILLER, MIN_UNTYPED_MENTIONS, visibleEntities };
