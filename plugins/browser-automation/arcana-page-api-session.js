const path = require('node:path');
const { findElements, pageKey, sensitiveInPage, formatJsResult } = require('./browser-automation');
const SENSITIVE_CHECK = `(${sensitiveInPage.toString()})() ?? false`;

function unsupported(name) {
  throw new Error(`${name} is not supported by the Arcana Page API session yet`);
}

function createArcanaPageApiSession(client, pageId, options = {}) {
  let knownRefs = new Map();
  const getSnapshot = () => client.snapshot(pageId);
  function resolveRef(ref) {
    const raw = String(ref ?? '').replace(/^\[?ref=/, '').replace(/\]$/, '');
    const resolved = knownRefs.get(raw);
    if (!resolved) throw new Error(`"${ref}" isn't a ref from the latest page snapshot`);
    return resolved;
  }
  async function sensitiveGuard() {
    const reason = await client.evaluate(pageId, SENSITIVE_CHECK);
    if (reason === false) return;
    if (typeof reason !== 'string' || !reason) {
      throw new Error("Arcana could not check whether the page asks for credentials. Try again or hand it over.");
    }
    throw new Error(`this page asks for ${reason}, so it's the user's to do: don't act on it, hand it over (browser_automation__hand_over)`);
  }
  function elements(snapshot) {
    knownRefs = new Map((snapshot.elements || []).filter(element => element.reference).map(element => [String(element.reference), String(element.reference)]));
    return (snapshot.elements || []).map(element => {
      let role = String(element.role || element.tag || 'generic').toLowerCase();
      if (role === 'input') {
        role = element.type === 'search' ? 'searchbox' : ['checkbox', 'radio', 'range', 'number'].includes(element.type) ? ({ range: 'slider', number: 'spinbutton' }[element.type] || element.type) : 'textbox';
      }
      const name = String(element.name || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      const ref = String(element.reference || '');
      return `${role}${name ? ` "${name}"` : ''}${ref ? ` [ref=${ref}]` : ''}${element.disabled ? ' [disabled]' : ''}`;
    });
  }
  async function snapshot() {
    const value = await getSnapshot();
    return { url: value.url, title: value.title, elements: elements(value), text: String(value.text || '').slice(0, 1500), ...(value.sensitive ? { sensitive: value.sensitive } : {}) };
  }
  async function afterAction() { return snapshot(); }
  async function navigate(url) {
    if (url === 'about:blank') {
      await client.navigate(pageId, 'about:blank');
      return snapshot();
    }
    let target;
    try { target = new URL(url); } catch { throw new Error(`invalid URL: ${url}`); }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('only http/https URLs can be navigated to');
    await client.navigate(pageId, target.href);
    return snapshot();
  }
  async function find(description) {
    if (!String(description || '').trim()) throw new Error('say what to look for, like "the Sign in button"');
    const value = await getSnapshot();
    return { url: value.url, title: value.title, description: String(description), matches: findElements(elements(value), description) };
  }
  async function click(ref) {
    await sensitiveGuard();
    const id = resolveRef(ref);
    if (options.onDownload) {
      const bareId = id.replace(/^[^:]+:/, '');
      const downloadName = await client.evaluate(pageId, `(() => {
        const targetId = ${JSON.stringify(id)};
        const bare = ${JSON.stringify(bareId)};
        const el = Array.from(document.querySelectorAll('[data-folio-ref],[aria-ref]')).find(e => {
          const r = e.getAttribute('data-folio-ref') || e.getAttribute('aria-ref');
          return r === targetId || r === bare;
        });
        const anchor = el ? el.closest('a[download]') : null;
        return anchor ? (anchor.getAttribute('download') || 'download') : null;
      })()`).catch(() => null);
      if (downloadName) {
        const download = {
          suggestedFilename: () => downloadName,
          url: () => 'data:',
          saveAs: async () => {},
          cancel: async () => {},
        };
        Promise.resolve(options.onDownload(download)).catch(() => {});
      }
    }
    await client.click(pageId, id);
    return afterAction();
  }
  async function type(ref, text, submit = false) {
    await sensitiveGuard();
    const id = resolveRef(ref);
    await client.fill(pageId, id, String(text ?? ''));
    if (submit) await client.press(pageId, 'Enter');
    return afterAction();
  }
  async function select(ref, value) {
    await sensitiveGuard();
    await client.select(pageId, resolveRef(ref), String(value ?? ''));
    return afterAction();
  }
  async function press(key, ref) {
    await sensitiveGuard();
    const combo = pageKey(key);
    if (ref) {
      const id = resolveRef(ref);
      const bareId = id.replace(/^[^:]+:/, '');
      await client.evaluate(pageId, `(() => {
        const targetId = ${JSON.stringify(id)};
        const bare = ${JSON.stringify(bareId)};
        const el = Array.from(document.querySelectorAll('[data-folio-ref],[aria-ref]')).find(function(e) {
          const r = e.getAttribute('data-folio-ref') || e.getAttribute('aria-ref');
          return r === targetId || r === bare;
        });
        if (el) el.focus();
        return true;
      })()`);
    }
    await client.press(pageId, combo);
    return afterAction();
  }
  async function upload(ref, file) {
    await sensitiveGuard();
    const id = resolveRef(ref);
    await client.upload(pageId, id, path.resolve(String(file)));
    return afterAction();
  }
  async function drag(fromRef, toRef) {
    await sensitiveGuard();
    const sourceRef = resolveRef(fromRef);
    const targetRef = resolveRef(toRef);
    const bareSource = sourceRef.replace(/^[^:]+:/, '');
    const bareTarget = targetRef.replace(/^[^:]+:/, '');
    await client.evaluate(pageId, `(() => {
      const sRef = ${JSON.stringify(sourceRef)};
      const tRef = ${JSON.stringify(targetRef)};
      const sBare = ${JSON.stringify(bareSource)};
      const tBare = ${JSON.stringify(bareTarget)};
      const match = function(el, full, bare) {
        const r = el.getAttribute('data-folio-ref') || el.getAttribute('aria-ref');
        return r === full || r === bare;
      };
      const source = Array.from(document.querySelectorAll('[data-folio-ref],[aria-ref]')).find(function(el) { return match(el, sRef, sBare); });
      const target = Array.from(document.querySelectorAll('[data-folio-ref],[aria-ref]')).find(function(el) { return match(el, tRef, tBare); });
      if (!source || !target) throw new Error('Drag source or target not found');
      const createEvent = function(type) {
        let ev = null;
        if (typeof MouseEvent === 'function') {
          try { ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window }); } catch (e) {}
        }
        if (!ev || !(ev instanceof Event)) {
          ev = new Event(type, { bubbles: true, cancelable: true });
        }
        return ev;
      };
      const data = {};
      const fakeTransfer = {
        setData: function(k, v) { data[k] = v; },
        getData: function(k) { return data[k] || ''; },
        effectAllowed: 'all',
        dropEffect: 'move',
        types: [],
        files: [],
        items: []
      };
      let transfer = null;
      if (typeof DataTransfer === 'function') {
        try { transfer = new DataTransfer(); } catch (e) {}
      }
      const actualTransfer = transfer || fakeTransfer;
      const dnd = function(el, type) {
        const ev = createEvent(type);
        try { Object.defineProperty(ev, 'dataTransfer', { value: actualTransfer, configurable: true, writable: true }); }
        catch (e) { try { ev.dataTransfer = actualTransfer; } catch (e2) {} }
        el.dispatchEvent(ev);
      };
      source.dispatchEvent(createEvent('mousedown'));
      if (source.closest('[draggable=true]') || source.getAttribute('draggable') === 'true') {
        dnd(source, 'dragstart');
        dnd(target, 'dragenter');
        dnd(target, 'dragover');
        dnd(target, 'drop');
        dnd(source, 'dragend');
      }
      target.dispatchEvent(createEvent('mouseup'));
      return true;
    })()`);
    return afterAction();
  }
  async function hover(ref) {
    await sensitiveGuard();
    const id = resolveRef(ref);
    const bareId = id.replace(/^[^:]+:/, '');
    await client.evaluate(pageId, `(() => {
      const targetId = ${JSON.stringify(id)};
      const bare = ${JSON.stringify(bareId)};
      const el = Array.from(document.querySelectorAll('[data-folio-ref],[aria-ref]')).find(function(e) {
        const r = e.getAttribute('data-folio-ref') || e.getAttribute('aria-ref');
        return r === targetId || r === bare;
      });
      if (!el) throw new Error('Element not found');
      const createEvent = function(type) {
        let ev = null;
        if (typeof MouseEvent === 'function') {
          try { ev = new MouseEvent(type, { bubbles: true }); } catch (e) {}
        }
        if (!ev || !(ev instanceof Event)) {
          ev = new Event(type, { bubbles: true });
        }
        return ev;
      };
      el.dispatchEvent(createEvent('mouseover'));
      el.dispatchEvent(createEvent('mouseenter'));
      return true;
    })()`);
    return afterAction();
  }
  async function scroll(direction) {
    if (direction !== 'up' && direction !== 'down') throw new Error('direction must be "up" or "down"');
    await client.scroll(pageId, 0, direction === 'down' ? 576 : -576);
    return afterAction();
  }
  async function back() { await client.back(pageId); return snapshot(); }
  async function screenshot() { return (await client.screenshot(pageId, { format: 'png' })).toString('base64'); }
  async function lookAndClick(description, locate) {
    await sensitiveGuard();
    const frame = await client.screenshot(pageId, { format: 'png' });
    if (frame.length < 24 || frame.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
      throw new Error('Arcana did not return a valid PNG frame');
    }
    const width = frame.readUInt32BE(16);
    const height = frame.readUInt32BE(20);
    const point = await locate(`data:image/png;base64,${frame.toString('base64')}`, width, height);
    if (!point) throw new Error(`she couldn't see "${description}" on the page`);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      point.x < 0 || point.x >= width || point.y < 0 || point.y >= height) {
      throw new Error('the selected point is outside the screenshot');
    }
    if (!frame.equals(await client.screenshot(pageId, { format: 'png' }))) {
      throw new Error('the page changed while she was looking at it; try again');
    }
    await sensitiveGuard();
    await client.clickAt(pageId, point.x, point.y);
    return { ...(await afterAction()), clickedAt: point };
  }
  async function devtools(args = {}, look) {
    if (args.do !== 'run_js' && args.do !== 'look') unsupported(`Devtools ${String(args.do || 'action')}`);
    await sensitiveGuard();
    const { url, title } = await getSnapshot();
    if (args.do === 'run_js') {
      const code = String(args.code || '').trim();
      if (!code) throw new Error('code is required: a JavaScript expression to run on the page');
      const value = await client.evaluate(pageId, code);
      return { url, title, what: 'Result', devtools: [formatJsResult(value)] };
    }
    if (!look) throw new Error("looking at the page isn't available right now");
    const png = await screenshot();
    const seen = await look(`data:image/png;base64,${png}`, String(args.question || "Describe this page's layout and anything that looks broken."));
    return { url, title, what: 'What she sees', devtools: [String(seen || '')] };
  }
  return {
    navigate, snapshot, find, click, type, select, press, scroll, back, screenshot, lookAndClick, devtools,
    url: async () => (await getSnapshot()).url,
    hover: () => unsupported('Hover'), drag, upload,
    testPage: () => unsupported('Site testing'),
  };
}

module.exports = { createArcanaPageApiSession, SENSITIVE_CHECK };
