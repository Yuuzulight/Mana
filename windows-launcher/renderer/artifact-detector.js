// Pure, DOM-free logic for deciding whether a chat reply contains content
// substantial enough to deserve its own standalone view instead of being
// crammed into a chat bubble -- same testable-module split as
// avatar/live2d-logic.js. The actual rendering (markdown-render.js) needs
// a real DOM (DOMPurify), so it isn't unit-tested the same way; this part
// -- the "should we" decision -- doesn't need one and is fully covered.

// An explicit ```html fence is always artifact-worthy regardless of size
// (it's meant to be viewed, not read as chat text); any other fenced block
// only qualifies once it's long enough that inlining it would dominate the
// chat bubble.
const ARTIFACT_MIN_CHARS = 400;

// Returns the first artifact-worthy fenced block in `markdownText`, or
// null. Only the first match -- a reply naming a second one is treated as
// chat content, not a second artifact.
function extractArtifact(markdownText) {
  const text = String(markdownText || "");
  const fenceRegex = /```(\w*)\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRegex.exec(text))) {
    const language = (match[1] || "").toLowerCase();
    const content = match[2];
    if (language === "html" || content.length >= ARTIFACT_MIN_CHARS) {
      return {
        language: language || "text",
        content: content.replace(/\s+$/, ""),
        matchedText: match[0],
      };
    }
  }
  return null;
}

module.exports = { ARTIFACT_MIN_CHARS, extractArtifact };
