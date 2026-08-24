const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_VISION_HOTKEY_PROMPT,
  buildClipHotkeyPrompt,
  describeVisionHotkeyError,
  extractReplyErrorDetail,
} = require("../renderer/vision-hotkey");

test("vision hotkey prompt asks for a brief screen description", () => {
  assert.match(DEFAULT_VISION_HOTKEY_PROMPT, /screen/i);
  assert.match(DEFAULT_VISION_HOTKEY_PROMPT, /briefly/i);
});

test("buildClipHotkeyPrompt states the real span, not a hardcoded target", () => {
  assert.equal(
    buildClipHotkeyPrompt(15),
    "Look back over the last 15 seconds and tell me what just happened. Answer briefly.",
  );
  assert.equal(
    buildClipHotkeyPrompt(6),
    "Look back over the last 6 seconds and tell me what just happened. Answer briefly.",
  );
});

test("buildClipHotkeyPrompt uses singular 'second' for a 1-second span", () => {
  assert.equal(
    buildClipHotkeyPrompt(1),
    "Look back over the last 1 second and tell me what just happened. Answer briefly.",
  );
});

test("buildClipHotkeyPrompt falls back to no numeric span for an empty/single-frame buffer", () => {
  assert.equal(
    buildClipHotkeyPrompt(0),
    "Look back at what just happened and tell me. Answer briefly.",
  );
  assert.equal(
    buildClipHotkeyPrompt(undefined),
    "Look back at what just happened and tell me. Answer briefly.",
  );
});

test("buildClipHotkeyPrompt rounds a fractional span to the nearest second", () => {
  assert.equal(
    buildClipHotkeyPrompt(6.4),
    "Look back over the last 6 seconds and tell me what just happened. Answer briefly.",
  );
});

test("503 maps to a missing-vision-model message with docs pointer", () => {
  const message = describeVisionHotkeyError(503, "No local vision model found.");
  assert.match(message, /no vision model installed/i);
  assert.match(message, /docs\/vision_setup\.md/);
});

test("other errors surface the detail text", () => {
  assert.equal(
    describeVisionHotkeyError(500, "llama-server exploded"),
    "Mana couldn't look at the screen: llama-server exploded",
  );
  assert.equal(
    describeVisionHotkeyError(0, ""),
    "Mana couldn't look at the screen.",
  );
});

test("extractReplyErrorDetail prefers detail, then error, then text", async () => {
  assert.equal(
    await extractReplyErrorDetail({
      json: async () => ({ detail: "detail text", error: "error text" }),
    }),
    "detail text",
  );
  assert.equal(
    await extractReplyErrorDetail({
      json: async () => ({ error: "error text" }),
    }),
    "error text",
  );
  assert.equal(
    await extractReplyErrorDetail({
      json: async () => {
        throw new Error("not json");
      },
      text: async () => "plain text body",
    }),
    "plain text body",
  );
});
