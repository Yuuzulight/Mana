const { ipcRenderer } = require("electron");
const { createMarkdownRenderer } = require("../renderer/markdown-render");
const createDOMPurify = require("dompurify");

const renderMarkdownToSafeHtml = createMarkdownRenderer();
const purify = createDOMPurify(window);
const container = document.getElementById("artifact-container");

ipcRenderer.on("artifact:show", (event, artifact) => {
  if (!container || !artifact) {
    return;
  }
  // An explicit ```html fence is real markup meant to be viewed as-is;
  // anything else (markdown, plain code) goes through the same renderer
  // chat bubbles use, so it's at least legible instead of raw text.
  container.innerHTML =
    artifact.language === "html"
      ? purify.sanitize(artifact.content)
      : renderMarkdownToSafeHtml(artifact.content);
});
