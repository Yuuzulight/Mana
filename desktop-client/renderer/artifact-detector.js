// Pure, DOM-free logic for deciding whether a chat reply contains content
// substantial enough to deserve its own standalone view instead of being
// crammed into a chat bubble. Same module as windows-launcher's
// renderer/artifact-detector.js -- kept as a parallel per-app copy rather
// than a shared package, matching how live2d-logic.js/live2d-avatar.js
// already exist independently in both apps.

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
