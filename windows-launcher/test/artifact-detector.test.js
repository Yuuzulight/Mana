const assert = require("node:assert/strict");
const test = require("node:test");

const { ARTIFACT_MIN_CHARS, extractArtifact } = require("../renderer/artifact-detector");

test("extractArtifact returns null for plain chat text with no fenced blocks", () => {
  assert.equal(extractArtifact("just a normal reply, no code here"), null);
  assert.equal(extractArtifact(""), null);
  assert.equal(extractArtifact(undefined), null);
});

test("extractArtifact returns null for a short fenced block that isn't html", () => {
  const text = "Here's a quick snippet:\n```js\nconsole.log(1);\n```\nDone.";
  assert.equal(extractArtifact(text), null);
});

test("extractArtifact always flags an html fence regardless of size", () => {
  const text = "Here's a page:\n```html\n<p>hi</p>\n```\n";
  const artifact = extractArtifact(text);
  assert.ok(artifact);
  assert.equal(artifact.language, "html");
  assert.equal(artifact.content, "<p>hi</p>");
});

test("extractArtifact flags a non-html fenced block once it's long enough", () => {
  const longContent = "line\n".repeat(100); // well over ARTIFACT_MIN_CHARS
  const text = `Here's the report:\n\`\`\`markdown\n${longContent}\`\`\`\n`;
  const artifact = extractArtifact(text);
  assert.ok(artifact);
  assert.equal(artifact.language, "markdown");
  assert.ok(artifact.content.length >= ARTIFACT_MIN_CHARS);
});

test("extractArtifact returns only the first artifact-worthy block", () => {
  const text =
    "```html\n<p>first</p>\n```\nsome text\n```html\n<p>second</p>\n```\n";
  const artifact = extractArtifact(text);
  assert.equal(artifact.content, "<p>first</p>");
});

test("extractArtifact treats a fence with no language tag as text", () => {
  const longContent = "x".repeat(ARTIFACT_MIN_CHARS + 1);
  const text = `\`\`\`\n${longContent}\n\`\`\``;
  const artifact = extractArtifact(text);
  assert.ok(artifact);
  assert.equal(artifact.language, "text");
});
