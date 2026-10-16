// The Obscura build Arcana ships has no table DOM API (Arcana#5), and Playwright's
// accessibility snapshot reads it for every <td>/<th>, so any page with a table
// throws. This init script fills the gap with the standard properties, only where
// the engine leaves them undefined, so a fixed engine is left alone.
const script = String.raw`(() => {
  const define = (ctor, name, get) => {
    if (!ctor || ctor.prototype[name] !== undefined) return;
    Object.defineProperty(ctor.prototype, name, { get, configurable: true });
  };
  const kids = (el, tags) => Array.prototype.filter.call(el.children || [], (c) => tags.includes(c.tagName));
  const T = globalThis.HTMLTableElement;
  // Rows and cells are plain Elements in this engine, so tag-guard the getters.
  const R = globalThis.HTMLTableRowElement || globalThis.Element;
  const C = globalThis.HTMLTableCellElement || globalThis.Element;
  const only = (tags, get) => function () { return tags.includes(this.tagName) ? get.call(this) : undefined; };
  const section = (t, tag) => kids(t, [tag])[0] || null;
  define(T, "tHead", function () { return section(this, "THEAD"); });
  define(T, "tFoot", function () { return section(this, "TFOOT"); });
  define(T, "caption", function () { return section(this, "CAPTION"); });
  define(T, "tBodies", function () { return kids(this, ["TBODY"]); });
  define(T, "rows", function () {
    const out = [];
    const take = (el) => out.push(...kids(el, ["TR"]));
    const head = section(this, "THEAD");
    if (head) take(head);
    for (const c of this.children || []) {
      if (c.tagName === "TR") out.push(c);
      else if (c.tagName === "TBODY") take(c);
    }
    const foot = section(this, "TFOOT");
    if (foot) take(foot);
    return out;
  });
  define(R, "cells", only(["TR"], function () { return kids(this, ["TD", "TH"]); }));
  define(R, "rowIndex", only(["TR"], function () {
    const table = this.closest && this.closest("table");
    return table ? table.rows.indexOf(this) : -1;
  }));
  define(R, "sectionRowIndex", only(["TR"], function () {
    return this.parentElement ? kids(this.parentElement, ["TR"]).indexOf(this) : -1;
  }));
  define(C, "cellIndex", only(["TD", "TH"], function () {
    return this.parentElement ? kids(this.parentElement, ["TD", "TH"]).indexOf(this) : -1;
  }));

  // The engine reports a 0x0 box for some inline elements (a link in a span in a heading), so
  // Playwright calls them invisible and gives them no ref: Mana can't click them. They take the
  // box of the nearest visible ancestor; hidden ones stay hidden.
  const E = globalThis.Element;
  if (E && !E.prototype.__arcanaBox) {
    const boxOf = E.prototype.getBoundingClientRect;
    const empty = (r) => !(r.width > 0 && r.height > 0);
    const hiddenStyle = (el) => { const cs = getComputedStyle(el); return cs.display === "none" || cs.visibility === "hidden"; };
    const standIn = (el) => {
      if (!el.isConnected || !(/^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL|SPAN|IMG)$/.test(el.tagName)) || !(el.textContent || "").trim() && el.tagName !== "IMG" && el.tagName !== "INPUT") return null;
      if (hiddenStyle(el)) return null;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (hiddenStyle(p)) return null;
        const r = boxOf.call(p);
        if (!empty(r)) return r;
      }
      return null;
    };
    E.prototype.getBoundingClientRect = function () {
      const r = boxOf.call(this);
      return empty(r) ? standIn(this) || r : r;
    };
    const boxesOf = E.prototype.getClientRects;
    E.prototype.getClientRects = function () {
      const list = boxesOf.call(this);
      if (list.length) return list;
      const r = standIn(this);
      return r ? [r] : list;
    };
    Object.defineProperty(E.prototype, "__arcanaBox", { value: true });
  }

  // jQuery's own selectors (a:last, :visible, :eq(1)) are not CSS. A browser throws on them and jQuery
  // then falls back to its own matcher; this engine answers with an empty list, so jQuery sites find nothing.
  const NOT_CSS = /:(?:first|last|eq|gt|lt|even|odd|visible|hidden|contains|input|button|text|password|checkbox|radio|submit|reset|file|image|selected|header|parent|animated)(?![\w-])/;
  for (const type of [globalThis.Element, globalThis.Document, globalThis.DocumentFragment]) {
    for (const method of ["querySelector", "querySelectorAll", "matches", "closest"]) {
      const original = type && type.prototype[method];
      if (typeof original !== "function" || original.__arcanaCss) continue;
      const wrapped = function (selector, ...rest) {
        if (typeof selector === "string" && NOT_CSS.test(selector)) {
          throw new DOMException("'" + selector + "' is not a valid selector.", "SyntaxError");
        }
        return original.call(this, selector, ...rest);
      };
      wrapped.__arcanaCss = true;
      type.prototype[method] = wrapped;
    }
  }

  // YouTube's component polyfill (ShadyDOM) calls the window's own event methods under these names and
  // expects them to exist.
  for (const name of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
    const key = "__shady_native_" + name;
    if (typeof window[key] !== "function") {
      Object.defineProperty(window, key, {
        value: function () { return EventTarget.prototype[name].apply(this || window, arguments); },
        configurable: true,
        writable: true,
      });
    }
  }

  // The engine never scrolls: scrollY stays 0, so a page that loads more near the bottom never does.
  // Mana's scroll moves a virtual offset the page can read, and sends the scroll event.
  if (!window.__arcanaScrollBy) {
    let offset = 0;
    const move = (to) => {
      offset = Math.max(0, to);
      window.dispatchEvent(new Event("scroll"));
      document.dispatchEvent(new Event("scroll"));
    };
    const read = { get: () => offset, set: (v) => move(Number(v) || 0), configurable: true };
    for (const name of ["scrollY", "pageYOffset"]) Object.defineProperty(window, name, { get: read.get, configurable: true });
    for (const el of [document.documentElement, document.body]) if (el) Object.defineProperty(el, "scrollTop", read);
    window.scrollTo = (x, y) => move(typeof x === "object" && x ? Number(x.top) || 0 : Number(y) || 0);
    window.scrollBy = (x, y) => move(offset + (typeof x === "object" && x ? Number(x.top) || 0 : Number(y) || 0));
    Object.defineProperty(window, "__arcanaScrollBy", { value: (dy) => move(offset + dy) });
  }

  // Arrow keys step a number or range input in a browser; the engine leaves that default action out.
  document.addEventListener("keydown", (e) => {
    const el = e.target;
    if (e.defaultPrevented || !el || el.tagName !== "INPUT" || (el.type !== "number" && el.type !== "range")) return;
    const dir = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    const step = Number(el.getAttribute("step")) || 1;
    const min = el.getAttribute("min") === null ? (el.type === "range" ? 0 : -Infinity) : Number(el.getAttribute("min"));
    const max = el.getAttribute("max") === null ? (el.type === "range" ? 100 : Infinity) : Number(el.getAttribute("max"));
    const now = Number(el.value);
    const start = Number.isFinite(now) && el.value !== "" ? now : el.type === "range" ? (min + max) / 2 : 0;
    el.value = String(Math.min(max, Math.max(min, parseFloat((start + dir * step).toFixed(8)))));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // A custom element (<fa-icon>, <app-card>) is inline in a browser until the page says otherwise; here it is
  // block, which makes a button named by its content lose its name. Mana calls this before it reads the page;
  // :where() keeps the page's own rules winning.
  const customTags = new Set();
  const customStyle = document.createElement("style");
  Object.defineProperty(window, "__arcanaInlineCustom", {
    value: () => {
      const known = customTags.size;
      for (const el of document.getElementsByTagName("*")) if (el.localName.includes("-")) customTags.add(el.localName);
      if (customTags.size === known) return;
      customStyle.textContent = ":where(" + [...customTags].join(",") + "){display:inline}";
      if (!customStyle.isConnected) (document.head || document.documentElement).appendChild(customStyle);
    },
  });

  // <option> reports display:none here, which hides every dropdown choice from the page snapshot.
  const addStyle = () => {
    const style = document.createElement("style");
    style.textContent = "option,optgroup{display:block}";
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addStyle);
  else addStyle();
})();`;

module.exports = { script };
