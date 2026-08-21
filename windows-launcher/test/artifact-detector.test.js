const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ARTIFACT_MIN_CHARS,
  extractArtifact,
  assignArtifactVersion,
} = require("../renderer/artifact-detector");

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

test("extractArtifact always flags a mermaid fence regardless of size", () => {
  const text = "Here's a diagram:\n```mermaid\ngraph TD;\nA-->B;\n```\n";
  const artifact = extractArtifact(text);
  assert.ok(artifact);
  assert.equal(artifact.language, "mermaid");
  assert.equal(artifact.content, "graph TD;\nA-->B;");
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

// Issue #391
test("assignArtifactVersion starts a new thread for the first artifact of a language", () => {
  const artifact = { language: "html", content: "<p>v1</p>" };
  const result = assignArtifactVersion(artifact, []);
  assert.equal(result.versionIndex, 1);
  assert.ok(result.threadId);
});

test("assignArtifactVersion continues the same thread when content overlaps enough", () => {
  const v1 = assignArtifactVersion(
    { language: "html", content: "<div>\n<p>one</p>\n<p>two</p>\n<p>three</p>\n</div>" },
    [],
  );
  const v2 = assignArtifactVersion(
    { language: "html", content: "<div>\n<p>one</p>\n<p>two</p>\n<p>three</p>\n<p>four</p>\n</div>" },
    [v1],
  );
  assert.equal(v2.threadId, v1.threadId);
  assert.equal(v2.versionIndex, 2);
});

test("assignArtifactVersion starts a new thread for an unrelated artifact of the same language", () => {
  const v1 = assignArtifactVersion(
    { language: "html", content: "<div>\n<p>completely different page one</p>\n<p>with its own content</p>\n</div>" },
    [],
  );
  const v2 = assignArtifactVersion(
    { language: "html", content: "<section>\n<h1>totally unrelated page two</h1>\n<h2>nothing shared here</h2>\n</section>" },
    [v1],
  );
  assert.notEqual(v2.threadId, v1.threadId);
  assert.equal(v2.versionIndex, 1);
});

test("assignArtifactVersion never threads artifacts of different languages together", () => {
  const v1 = assignArtifactVersion({ language: "html", content: "<p>same content</p>" }, []);
  const v2 = assignArtifactVersion({ language: "mermaid", content: "<p>same content</p>" }, [v1]);
  assert.notEqual(v2.threadId, v1.threadId);
});

test("assignArtifactVersion tracks a third version of the same thread", () => {
  const base = "line1\nline2\nline3\nline4\nline5";
  const v1 = assignArtifactVersion({ language: "mermaid", content: base }, []);
  const v2 = assignArtifactVersion({ language: "mermaid", content: `${base}\nline6` }, [v1]);
  const v3 = assignArtifactVersion({ language: "mermaid", content: `${base}\nline6\nline7` }, [v1, v2]);
  assert.equal(v3.threadId, v1.threadId);
  assert.equal(v3.versionIndex, 3);
});

test("assignArtifactVersion, given history with two prior threads, groups against the more recent one", () => {
  const threadA = assignArtifactVersion(
    { language: "html", content: "<div>\n<p>thread A</p>\n<p>content</p>\n</div>" },
    [],
  );
  const threadB = assignArtifactVersion(
    { language: "html", content: "<section>\n<h1>thread B</h1>\n<h2>content</h2>\n</section>" },
    [threadA],
  );
  // Overlaps with thread B (the more recent same-language entry, sharing
  // most lines with this revision), not thread A -- even though thread A
  // is also present in history and is also html.
  const v2 = assignArtifactVersion(
    { language: "html", content: "<section>\n<h1>thread B</h1>\n<h2>content</h2>\n<h3>revised</h3>\n</section>" },
    [threadA, threadB],
  );
  assert.equal(v2.threadId, threadB.threadId);
  assert.notEqual(v2.threadId, threadA.threadId);
});

// Regression test: threadId used to be derived from history.length, which
// collides whenever a caller threads a batch against a fresh, page-local
// history array (desktop-client's prependTurns does this per scroll-back
// page) -- two unrelated artifacts at the same index in two separate,
// independently-empty history arrays got the same threadId once merged.
test("assignArtifactVersion never collides threadIds across independent, separately-empty history arrays", () => {
  const fromArrayOne = assignArtifactVersion({ language: "html", content: "<p>unrelated page one</p>" }, []);
  const fromArrayTwo = assignArtifactVersion({ language: "html", content: "<p>unrelated page two</p>" }, []);
  assert.notEqual(fromArrayOne.threadId, fromArrayTwo.threadId);
});
