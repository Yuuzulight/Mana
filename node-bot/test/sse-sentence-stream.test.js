const assert = require("node:assert/strict");
const test = require("node:test");

const { streamSentences } = require("../utils/sse-sentence-stream");

const NL = String.fromCharCode(10);

// Builds an SSE body from content deltas. chunkSize splits the wire bytes
// at arbitrary points, so line-splitting across network chunks is exercised
// rather than assumed.
function sseBody(deltas, { chunkSize = 0 } = {}) {
  const frames = deltas
    .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}${NL}${NL}`)
    .join("");
  const full = `${frames}data: [DONE]${NL}${NL}`;
  const pieces = [];
  if (chunkSize > 0) {
    for (let i = 0; i < full.length; i += chunkSize) pieces.push(full.slice(i, i + chunkSize));
  } else {
    pieces.push(full);
  }
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        for (const p of pieces) yield p;
      },
    },
  };
}

async function collect(resp) {
  const seen = [];
  const full = await streamSentences(resp, { onSentence: (s) => seen.push(s) });
  return { seen, full };
}

test("emits sentences as they complete", async () => {
  const { seen, full } = await collect(sseBody(["Hello there", ". ", "How are you", "? "]));
  assert.deepEqual(seen, ["Hello there.", "How are you?"]);
  assert.equal(full, "Hello there. How are you?");
});

test("reasoning inside a think block is never emitted", async () => {
  const { seen } = await collect(
    sseBody(["<think>I should ", "consider this. Carefully.</think>", "The answer is four. "]),
  );
  // The block contains a full stop, so an unfiltered pipeline would have
  // spoken the deliberation before the closing tag ever arrived.
  assert.deepEqual(seen, ["The answer is four."]);
});

test("a think tag split across deltas still suppresses", async () => {
  const { seen } = await collect(sseBody(["<thi", "nk>hidden. more hidden</thi", "nk>Visible. "]));
  assert.deepEqual(seen, ["Visible."]);
});

test("SSE lines split across network chunks still parse", async () => {
  const { seen } = await collect(sseBody(["One. ", "Two. "], { chunkSize: 7 }));
  assert.deepEqual(seen, ["One.", "Two."]);
});

test("a trailing sentence with no terminator is still emitted", async () => {
  const { seen } = await collect(sseBody(["All done. ", "no full stop here"]));
  assert.deepEqual(seen, ["All done.", "no full stop here"]);
});

test("a malformed frame costs one delta, not the stream", async () => {
  const resp = {
    body: {
      async *[Symbol.asyncIterator]() {
        yield `data: {not json}${NL}`;
        yield `data: ${JSON.stringify({ choices: [{ delta: { content: "Still fine. " } }] })}${NL}`;
        yield `data: [DONE]${NL}`;
      },
    },
  };
  const { seen } = await collect(resp);
  assert.deepEqual(seen, ["Still fine."]);
});

test("stops at [DONE] and ignores anything after it", async () => {
  const resp = {
    body: {
      async *[Symbol.asyncIterator]() {
        yield `data: ${JSON.stringify({ choices: [{ delta: { content: "Real. " } }] })}${NL}`;
        yield `data: [DONE]${NL}`;
        yield `data: ${JSON.stringify({ choices: [{ delta: { content: "Ghost. " } }] })}${NL}`;
      },
    },
  };
  const { seen } = await collect(resp);
  assert.deepEqual(seen, ["Real."]);
});

test("an empty body yields nothing rather than throwing", async () => {
  const { seen, full } = await collect({ body: null });
  assert.deepEqual(seen, []);
  assert.equal(full, "");
});
