const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_FRAMES,
  createClipBuffer,
  pushFrame,
  getSpanSeconds,
  getImages,
} = require("../renderer/clip-buffer");

test("createClipBuffer starts empty", () => {
  assert.deepEqual(createClipBuffer(), []);
});

test("pushFrame accumulates frames in order", () => {
  let buffer = createClipBuffer();
  buffer = pushFrame(buffer, "img1", 1000);
  buffer = pushFrame(buffer, "img2", 4000);
  assert.deepEqual(getImages(buffer), ["img1", "img2"]);
});

test("pushFrame drops the oldest frame once past MAX_FRAMES", () => {
  let buffer = createClipBuffer();
  for (let i = 0; i < MAX_FRAMES + 2; i++) {
    buffer = pushFrame(buffer, `img${i}`, i * 3000);
  }
  assert.equal(buffer.length, MAX_FRAMES);
  assert.deepEqual(getImages(buffer), ["img2", "img3", "img4", "img5", "img6"]);
});

test("pushFrame does not mutate the buffer passed in", () => {
  const original = createClipBuffer();
  const next = pushFrame(original, "img1", 1000);
  assert.deepEqual(original, []);
  assert.equal(next.length, 1);
});

test("getSpanSeconds is 0 for an empty or single-frame buffer", () => {
  assert.equal(getSpanSeconds(createClipBuffer()), 0);
  assert.equal(getSpanSeconds(pushFrame(createClipBuffer(), "img1", 5000)), 0);
});

test("getSpanSeconds reflects oldest-to-newest span, not frame count times target interval", () => {
  let buffer = createClipBuffer();
  buffer = pushFrame(buffer, "img1", 1000);
  buffer = pushFrame(buffer, "img2", 4000);
  buffer = pushFrame(buffer, "img3", 7000);
  assert.equal(getSpanSeconds(buffer), 6);
});
