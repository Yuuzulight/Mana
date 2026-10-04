const { randomBytes, timingSafeEqual } = require('node:crypto');

function createManualControl({ prepare, getContext, getPage, resume, touch = () => {} }) {
  let owner = null;
  let transition = null;
  let generation = 0;
  async function viewportOf(page) {
    const viewport = page.viewportSize() || await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (!Number.isFinite(viewport?.width) || !Number.isFinite(viewport?.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error('The page viewport is not available');
    return viewport;
  }

  function requireOwner(token) {
    const a = Buffer.from(typeof token === 'string' ? token : '');
    const b = Buffer.from(owner?.token || '');
    if (!owner || owner.revoked || owner.context !== getContext() || a.length !== b.length || !a.length || !timingSafeEqual(a, b)) throw new Error('Manual browser control is no longer active');
    return owner;
  }

  async function takeOver(deps, url) {
    if (transition) throw new Error('Browser control is already changing');
    if (owner && owner.context === getContext()) return { token: owner.token };
    const ticket = {};
    const before = generation;
    transition = ticket;
    try {
      await prepare(deps, url);
      if (before !== generation || !getContext() || !getPage()) throw new Error('No page is available for manual control');
      owner = { context: getContext(), token: randomBytes(32).toString('hex'), pending: Promise.resolve(), revoked: false };
      touch();
      return { token: owner.token };
    } finally { if (transition === ticket) transition = null; }
  }

  async function frame(token) {
    const current = requireOwner(token);
    touch();
    const page = getPage();
    const viewport = await viewportOf(page);
    const image = await page.screenshot({ type: 'jpeg', quality: 80, timeout: 10000 });
    if (requireOwner(token) !== current) throw new Error('Manual browser ownership changed');
    return { image: image.toString('base64'), width: viewport.width, height: viewport.height, url: page.url() };
  }

  async function input(token, command = {}) {
    const current = requireOwner(token);
    const run = async () => {
      if (requireOwner(token) !== current) throw new Error('Manual browser ownership changed');
      touch();
      const page = getPage();
      const viewport = await viewportOf(page);
      if (command.action === 'click') {
        if (!Number.isFinite(command.x) || !Number.isFinite(command.y) || command.x < 0 || command.y < 0 || command.x >= viewport.width || command.y >= viewport.height) throw new Error('Click is outside the page');
        if (!['left', 'right'].includes(command.button || 'left')) throw new Error('Invalid mouse button');
        await page.mouse.click(command.x, command.y, { button: command.button || 'left', clickCount: command.double ? 2 : 1 });
      } else if (command.action === 'text') {
        if (typeof command.text !== 'string' || command.text.length > 4096) throw new Error('Invalid keyboard text');
        await page.keyboard.insertText(command.text);
      } else if (command.action === 'key') {
        if (typeof command.key !== 'string' || !/^(?:(?:Control|Alt|Shift|Meta)\+)*(?:[A-Za-z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(command.key)) throw new Error('Invalid keyboard key');
        await page.keyboard.press(command.key);
      } else if (command.action === 'scroll') {
        if (!Number.isFinite(command.dy) || Math.abs(command.dy) > 2000) throw new Error('Invalid scroll distance');
        await page.mouse.wheel(0, command.dy);
      } else throw new Error('Unknown manual browser action');
      return { ok: true };
    };
    const result = current.pending.then(run);
    current.pending = result.catch(() => {});
    return result;
  }

  async function handBack(token) {
    if (transition) throw new Error('Browser control is already changing');
    const current = requireOwner(token);
    const ticket = {};
    const before = generation;
    transition = ticket;
    // Reject queued input, but keep the agent paused until running input ends.
    current.revoked = true;
    try {
      await current.pending;
      if (generation === before && owner === current && current.context === getContext()) await resume();
      return { active: false };
    } finally {
      if (owner === current) owner = null;
      if (transition === ticket) transition = null;
    }
  }

  return {
    takeOver, frame, input, handBack,
    clear: () => { generation += 1; if (owner) owner.revoked = true; owner = null; },
    isActive: () => Boolean(transition || (owner && owner.context === getContext())),
  };
}

module.exports = { createManualControl };
