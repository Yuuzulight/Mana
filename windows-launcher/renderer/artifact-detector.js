// Pure, DOM-free logic for deciding whether a chat reply contains content
// substantial enough to deserve its own standalone view instead of being
// crammed into a chat bubble -- same testable-module split as
// avatar/live2d-logic.js. The actual rendering (markdown-render.js) needs
// a real DOM (DOMPurify), so it isn't unit-tested the same way; this part
// -- the "should we" decision -- doesn't need one and is fully covered.

// An explicit ```html or ```mermaid fence is always artifact-worthy
// regardless of size (both are meant to be viewed/rendered, not read as
// chat text -- a compact 5-node flowchart is often well under the length
// threshold below); any other fenced block only qualifies once it's long
// enough that inlining it would dominate the chat bubble.
const ARTIFACT_MIN_CHARS = 400;
const ALWAYS_ARTIFACT_LANGUAGES = new Set(["html", "mermaid"]);

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
    if (ALWAYS_ARTIFACT_LANGUAGES.has(language) || content.length >= ARTIFACT_MIN_CHARS) {
      return {
        language: language || "text",
        content: content.replace(/\s+$/, ""),
        matchedText: match[0],
      };
    }
  }
  return null;
}

// Issue #391: groups a newly detected artifact into the version "thread" of
// the most recent artifact of the same language in `history` (the ordered
// list of artifacts already assigned this session), when the two share
// enough content to plausibly be revisions of one thing rather than two
// unrelated artifacts that happen to use the same language.
// ponytail: a fixed line-overlap threshold, not real content-identity --
// there's no stable id the model provides for "this is the same artifact as
// before." Upgrade path is a model-supplied artifact id/title if this
// heuristic ever misfires often enough in practice to matter.
const SAME_ARTIFACT_LINE_OVERLAP_THRESHOLD = 0.3;

function lineOverlapRatio(contentA, contentB) {
  const linesA = new Set(contentA.split("\n").map((line) => line.trim()).filter(Boolean));
  const linesB = new Set(contentB.split("\n").map((line) => line.trim()).filter(Boolean));
  if (!linesA.size || !linesB.size) return 0;
  let shared = 0;
  for (const line of linesA) {
    if (linesB.has(line)) shared += 1;
  }
  return shared / Math.max(linesA.size, linesB.size);
}

// Returns `artifact` enriched with `threadId` (which version-thread it
// belongs to) and `versionIndex` (1-based position within that thread).
// Reuses the most recent same-language entry in `history`'s threadId when
// the content overlaps enough to look like a revision; otherwise starts a
// new thread. `history` is not mutated -- the caller decides whether/where
// to store the returned, enriched artifact.
function assignArtifactVersion(artifact, history) {
  let lastSameLanguage = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].language === artifact.language) {
      lastSameLanguage = history[i];
      break;
    }
  }
  const isNewVersion =
    lastSameLanguage &&
    lineOverlapRatio(artifact.content, lastSameLanguage.content) >= SAME_ARTIFACT_LINE_OVERLAP_THRESHOLD;
  const threadId = isNewVersion ? lastSameLanguage.threadId : `${artifact.language}-${history.length}`;
  const versionIndex = isNewVersion
    ? history.filter((a) => a.threadId === threadId).length + 1
    : 1;
  return { ...artifact, threadId, versionIndex };
}

module.exports = {
  ARTIFACT_MIN_CHARS,
  ALWAYS_ARTIFACT_LANGUAGES,
  extractArtifact,
  assignArtifactVersion,
  SAME_ARTIFACT_LINE_OVERLAP_THRESHOLD,
};
