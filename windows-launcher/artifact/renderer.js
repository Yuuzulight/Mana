const { ipcRenderer } = require("electron");
const { createMarkdownRenderer } = require("../renderer/markdown-render");
const createDOMPurify = require("dompurify");

const renderMarkdownToSafeHtml = createMarkdownRenderer();
const purify = createDOMPurify(window);
const container = document.getElementById("artifact-container");
const navEl = document.getElementById("artifact-nav");
const prevBtn = document.getElementById("artifact-prev");
const nextBtn = document.getElementById("artifact-next");
const versionLabelEl = document.getElementById("artifact-version-label");

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

// Issue #391: `thread` is every version of this artifact detected this
// session (assignArtifactVersion in artifact-detector.js), `index` is which
// one was clicked. Kept as module state so Prev/Next can move through it
// without another IPC round trip.
let currentThread = [];
let currentIndex = 0;

async function renderArtifact(artifact) {
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
}

function updateNav() {
  if (!navEl) return;
  if (currentThread.length <= 1) {
    navEl.style.display = "none";
    return;
  }
  navEl.style.display = "flex";
  versionLabelEl.textContent = `Version ${currentIndex + 1} of ${currentThread.length}`;
  prevBtn.disabled = currentIndex === 0;
  nextBtn.disabled = currentIndex === currentThread.length - 1;
}

prevBtn?.addEventListener("click", () => {
  if (currentIndex > 0) {
    currentIndex -= 1;
    renderArtifact(currentThread[currentIndex]);
    updateNav();
  }
});
nextBtn?.addEventListener("click", () => {
  if (currentIndex < currentThread.length - 1) {
    currentIndex += 1;
    renderArtifact(currentThread[currentIndex]);
    updateNav();
  }
});

ipcRenderer.on("artifact:show", async (event, payload) => {
  if (!payload) return;
  currentThread = Array.isArray(payload.thread) ? payload.thread : [payload];
  currentIndex = Number.isInteger(payload.index) ? payload.index : currentThread.length - 1;
  updateNav();
  await renderArtifact(currentThread[currentIndex]);
});
