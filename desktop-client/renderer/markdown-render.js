// Renders chat text as sanitized HTML instead of plain text, so markdown
// formatting (headers, bold/italic, lists, fenced code blocks) actually
// displays. DOMPurify needs a real DOM to construct its sanitizer --
// required from preload.js here (contextIsolation is on for this app's
// renderer, issue #122, so this can't be required from the page script
// directly; preload shares the page's DOM despite the isolated JS
// context, so `window` still resolves). A test can inject its own
// `window` (e.g. from jsdom) via `options.window` instead.
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
