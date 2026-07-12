const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_VISION_HOTKEY_PROMPT,
  describeVisionHotkeyError,
  extractReplyErrorDetail,
} = require("../renderer/vision-hotkey");

test("vision hotkey prompt asks for a brief screen description", () => {
  assert.match(DEFAULT_VISION_HOTKEY_PROMPT, /screen/i);
  assert.match(DEFAULT_VISION_HOTKEY_PROMPT, /briefly/i);
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
