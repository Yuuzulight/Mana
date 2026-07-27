const container = document.getElementById("artifact-container");

window.artifactAPI.onShow((artifact) => {
  if (!container || !artifact) {
    return;
  }
  // An explicit ```html fence is real markup meant to be viewed as-is;
  // anything else (markdown, plain code) goes through the same renderer
  // chat bubbles use, so it's at least legible instead of raw text.
  container.innerHTML =
    artifact.language === "html"
      ? window.artifactAPI.sanitizeHtml(artifact.content)
      : window.artifactAPI.renderMarkdownToSafeHtml(artifact.content);
});
