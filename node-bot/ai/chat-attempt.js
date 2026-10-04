function createChatAttempt(timeoutSeconds, timers = { setTimeout, clearTimeout }) {
  const controller = new AbortController();
  let started = false;
  let timer = [30, 60].includes(timeoutSeconds) ? timers.setTimeout(() => controller.abort(new Error('Local model did not begin replying before the fallback deadline')), timeoutSeconds * 1000) : null;
  function close() { if (timer !== null) timers.clearTimeout(timer); timer = null; }
  function markStarted() { controller.signal.throwIfAborted(); started = true; close(); }
  return { signal: controller.signal, markStarted, close, get started() { return started; } };
}

module.exports = { createChatAttempt };
