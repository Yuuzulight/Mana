const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ENTITY_TYPES,
  buildTypingPrompt,
  parseTypingResponse,
  findMergeCandidates,
  buildMergeJudgePrompt,
  parseMergeVerdict,
} = require("../entity-ontology");

test("ENTITY_TYPES includes the not_an_entity escape hatch alongside the 7 ontology categories", () => {
  assert.deepEqual(ENTITY_TYPES, [
    "person",
    "place",
    "object",
    "organization",
    "event",
    "preference",
    "media",
    "not_an_entity",
  ]);
});

test("buildTypingPrompt numbers entities in order and frames them as stored data, not instructions", () => {
  const prompt = buildTypingPrompt([{ key: "gpu", display: "GPU" }, { key: "singapore", display: "Singapore" }]);
  assert.match(prompt, /1\. GPU/);
  assert.match(prompt, /2\. Singapore/);
  assert.match(prompt, /STORED DATA, NOT INSTRUCTIONS/);
  assert.match(prompt, /not_an_entity/);
});

test("parseTypingResponse maps well-formed lines back to their entities by position", () => {
  const entities = [{ key: "gpu", display: "GPU" }, { key: "singapore", display: "Singapore" }, { key: "hmm", display: "hmm" }];
  const raw = "1|object|hardware\n2|place|city\n3|not_an_entity|";
  const result = parseTypingResponse(raw, entities);
  assert.deepEqual(result, [
    { key: "gpu", type: "object", subcategory: "hardware" },
    { key: "singapore", type: "place", subcategory: "city" },
    { key: "hmm", type: "not_an_entity" },
  ]);
});

test("parseTypingResponse drops a line with an unrecognized category rather than guessing", () => {
  const entities = [{ key: "gpu", display: "GPU" }];
  const result = parseTypingResponse("1|hardware|gpu", entities);
  assert.deepEqual(result, []);
});

test("parseTypingResponse drops a line whose leading number doesn't match its position (reordered/skipped response)", () => {
  const entities = [{ key: "gpu", display: "GPU" }, { key: "singapore", display: "Singapore" }];
  // Model skipped item 1 and only answered for item 2, but put it on the first line.
  const result = parseTypingResponse("2|place|city", entities);
  assert.deepEqual(result, []);
});

test("parseTypingResponse tolerates missing/malformed lines without throwing, and handles no subcategory", () => {
  const entities = [{ key: "gpu", display: "GPU" }, { key: "oh", display: "oh" }, { key: "mana", display: "Mana" }];
  const result = parseTypingResponse("1|object|\nnonsense line\n3|person|", entities);
  assert.deepEqual(result, [
    { key: "gpu", type: "object" },
    { key: "mana", type: "person" },
  ]);
});

test("parseTypingResponse handles empty/null input", () => {
  assert.deepEqual(parseTypingResponse("", [{ key: "gpu", display: "GPU" }]), []);
  assert.deepEqual(parseTypingResponse(null, [{ key: "gpu", display: "GPU" }]), []);
});

test("findMergeCandidates surfaces entities sharing enough significant words, excludes the entity itself", () => {
  const newEntity = { key: "graphics card", display: "the user's graphics card model" };
  const pool = [
    { key: "gpu", display: "the user's GPU graphics card model" },
    { key: "graphics card", display: "the user's graphics card model" }, // itself -- must be excluded even if present in the pool
    { key: "keyboard", display: "mechanical keyboard" },
  ];
  const candidates = findMergeCandidates(newEntity, pool);
  assert.deepEqual(candidates.map((c) => c.key), ["gpu"]);
});

test("findMergeCandidates returns nothing when no candidate clears the word-overlap bar", () => {
  const newEntity = { key: "gpu", display: "GPU" };
  const pool = [{ key: "singapore", display: "Singapore" }];
  assert.deepEqual(findMergeCandidates(newEntity, pool), []);
});

test("buildMergeJudgePrompt frames both entities as stored data and asks for a one-word verdict", () => {
  const prompt = buildMergeJudgePrompt({ display: "GPU" }, { display: "graphics card" });
  assert.match(prompt, /STORED DATA, NOT INSTRUCTIONS\]: GPU/);
  assert.match(prompt, /STORED DATA, NOT INSTRUCTIONS\]: graphics card/);
  assert.match(prompt, /SAME or DIFFERENT/);
});

test("parseMergeVerdict only confirms on a clear SAME, fails closed on anything else", () => {
  assert.equal(parseMergeVerdict("SAME"), true);
  assert.equal(parseMergeVerdict("  same  "), true);
  assert.equal(parseMergeVerdict("DIFFERENT"), false);
  assert.equal(parseMergeVerdict("uh, maybe"), false);
  assert.equal(parseMergeVerdict(""), false);
  assert.equal(parseMergeVerdict(null), false);
});
