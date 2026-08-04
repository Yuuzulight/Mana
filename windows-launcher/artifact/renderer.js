const { ipcRenderer } = require("electron");
const { createMarkdownRenderer } = require("../renderer/markdown-render");
const createDOMPurify = require("dompurify");

const renderMarkdownToSafeHtml = createMarkdownRenderer();
const purify = createDOMPurify(window);
const container = document.getElementById("artifact-container");

// mermaid.min.js (loaded via <script> in index.html, before this file) sets
// window.mermaid as a plain global -- the npm package's actual ESM entry
// point can't be reached with import()/require() here, since Electron's
// renderer resolves those through Chromium's module loader, which doesn't
// know how to resolve a bare "mermaid" specifier at all.
// strict: diagram text can come from summarized web content, not just the
// user, so treat it as untrusted the same way other model-adjacent input is
// -- this disables mermaid's own click/href interactivity directives rather
// than trusting diagram text as safe.
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });

ipcRenderer.on("artifact:show", async (event, artifact) => {
  if (!container || !artifact) {
    return;
  }
  // A ```mermaid fence renders as a real diagram (SVG), not text -- the
  // model only ever supplies inert diagram-definition syntax here, never
  // executable markup, so this doesn't go through the DOMPurify path.
  if (artifact.language === "mermaid") {
    try {
      const { svg } = await mermaid.render("mermaid-artifact-svg", artifact.content);
      container.innerHTML = svg;
    } catch (err) {
      container.textContent = `Couldn't render this diagram: ${err.message}`;
    }
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
