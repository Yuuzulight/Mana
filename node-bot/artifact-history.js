// #1142: the artifacts in saved chats, for the chat window's Artifacts panel
// after a restart. A turn's own text has its whitespace collapsed and is cut
// at 4000 chars, which loses a fenced block, so appendTurn keeps the reply's
// artifact verbatim on the turn (artifactOf); artifactsOf lists a chat's
// artifacts without their content, which the panel reads when one is opened.
// Detection and versioning follow windows-launcher/renderer/artifact-detector.js
// (and its C# port, ArtifactDetector.cs); versions thread within one chat.

const ARTIFACT_MIN_CHARS = 400;
const ALWAYS_ARTIFACT_LANGUAGES = new Set(["html", "mermaid"]);
const SAME_ARTIFACT_LINE_OVERLAP_THRESHOLD = 0.3;
// ponytail: a bigger artifact isn't kept (a cut one would be broken); raise it if pages outgrow it.
const MAX_ARTIFACT_CHARS = 200000;

// The reply's first artifact-worthy fenced block as { language, content }, or null.
function artifactOf(replyText) {
  const fence = /```(\w*)\r?\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(String(replyText || "")))) {
    const language = (match[1] || "").toLowerCase();
    const content = match[2];
    if (ALWAYS_ARTIFACT_LANGUAGES.has(language) || content.length >= ARTIFACT_MIN_CHARS) {
      const trimmed = content.replace(/\s+$/, "");
      return trimmed.length <= MAX_ARTIFACT_CHARS ? { language: language || "text", content: trimmed } : null;
    }
  }
  return null;
}

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

// An HTML page's <title>, else its first non-blank line (ArtifactsPanel.Title).
function titleOf({ language, content }) {
  const title = language === "html" ? /<title[^>]*>\s*([^<]+?)\s*<\/title>/i.exec(content) : null;
  if (title) {
    return title[1].replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]);
  }
  const line = content.split("\n").map((l) => l.trim()).find(Boolean) || language;
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

// A chat's artifacts, oldest first, without their content: { turn, at,
// language, title, threadId, versionIndex }. before (ms): only turns saved
// earlier -- later ones are already in the panel from this run.
function artifactsOf(session, { before } = {}) {
  const history = [];
  const listed = [];
  let nextThread = 0;
  (session?.turns || []).forEach((turn, index) => {
    const artifact = turn?.artifact;
    if (!artifact || typeof artifact.content !== "string" || typeof artifact.language !== "string") return;
    const last = [...history].reverse().find((h) => h.language === artifact.language);
    const isNewVersion = last && lineOverlapRatio(artifact.content, last.content) >= SAME_ARTIFACT_LINE_OVERLAP_THRESHOLD;
    const threadId = isNewVersion ? last.threadId : `${artifact.language}-${nextThread++}`;
    const versionIndex = history.filter((h) => h.threadId === threadId).length + 1;
    history.push({ ...artifact, threadId });
    if (before !== undefined && !(Date.parse(turn.at) < before)) return;
    listed.push({ turn: index, at: turn.at || null, language: artifact.language, title: titleOf(artifact), threadId, versionIndex });
  });
  return listed;
}

module.exports = { artifactOf, artifactsOf, titleOf, MAX_ARTIFACT_CHARS };
