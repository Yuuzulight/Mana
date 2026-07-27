const { contextBridge, ipcRenderer } = require('electron');
const { createMarkdownRenderer } = require('../renderer/markdown-render');
const createDOMPurify = require('dompurify');

const renderMarkdownToSafeHtml = createMarkdownRenderer();
const purify = createDOMPurify(window);

contextBridge.exposeInMainWorld('artifactAPI', {
  onShow: (cb) => ipcRenderer.on('artifact:show', (event, artifact) => cb(artifact)),
  renderMarkdownToSafeHtml: (text) => renderMarkdownToSafeHtml(text),
  sanitizeHtml: (html) => purify.sanitize(html),
});
