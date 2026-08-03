const { contextBridge, ipcRenderer } = require('electron');
const { createMarkdownRenderer } = require('../renderer/markdown-render');
const createDOMPurify = require('dompurify');

const renderMarkdownToSafeHtml = createMarkdownRenderer();
const purify = createDOMPurify(window);

// Mermaid rendering itself is handled directly in renderer.js against the
// window.mermaid global (loaded via <script> in index.html) -- it doesn't
// need Node's require() the way markdown-render/dompurify do, so it has no
// business being exposed through this preload's contextBridge.
contextBridge.exposeInMainWorld('artifactAPI', {
  onShow: (cb) => ipcRenderer.on('artifact:show', (event, artifact) => cb(artifact)),
  renderMarkdownToSafeHtml: (text) => renderMarkdownToSafeHtml(text),
  sanitizeHtml: (html) => purify.sanitize(html),
});
