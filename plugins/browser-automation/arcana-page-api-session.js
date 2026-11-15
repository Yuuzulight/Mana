const { findElements, pageKey, sensitiveInPage } = require('./browser-automation');
const SENSITIVE_CHECK = `(${sensitiveInPage.toString()})()`;

function unsupported(name) {
  throw new Error(`${name} is not supported by the Arcana Page API session yet`);
}

function createArcanaPageApiSession(client, pageId) {
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
    if (reason) throw new Error(`this page asks for ${reason}, so it's the user's to do: don't act on it, hand it over (browser_automation__hand_over)`);
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
    await client.click(pageId, resolveRef(ref));
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
    if (ref) unsupported('Pressing a key on a referenced element');
    await client.press(pageId, combo);
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
  return {
    navigate, snapshot, find, click, type, select, press, scroll, back, screenshot, lookAndClick,
    url: async () => (await getSnapshot()).url,
    hover: () => unsupported('Hover'), drag: () => unsupported('Drag'), upload: () => unsupported('Upload'),
    testPage: () => unsupported('Site testing'),
    devtools: () => unsupported('Devtools'),
  };
}

module.exports = { createArcanaPageApiSession, SENSITIVE_CHECK };
