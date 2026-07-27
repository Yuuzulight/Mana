// Renders chat text as sanitized HTML instead of plain text, so markdown
// formatting (headers, bold/italic, lists, fenced code blocks) actually
// displays. DOMPurify needs a real DOM to construct its sanitizer --
// Electron's renderer process already has one (nodeIntegration is on
// here), so this works without extra setup in production; a test can
// inject its own `window` (e.g. from jsdom) via `options.window` instead.
const { marked } = require("marked");
const createDOMPurify = require("dompurify");

function createMarkdownRenderer(options = {}) {
  const purify = options.DOMPurify || createDOMPurify(options.window || window);
  return function renderMarkdownToSafeHtml(text) {
    const rawHtml = marked.parse(String(text || ""), { breaks: true, gfm: true });
    return purify.sanitize(rawHtml);
  };
}

module.exports = { createMarkdownRenderer };
