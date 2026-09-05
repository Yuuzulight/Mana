// Issue #500: extracted from renderer.js -- both IIFEs below are
// self-contained (own local state, only touch their own by-id DOM lookups
// and window.electronAPI), so moved out verbatim rather than left inline.

// Startup loading screen: labels are generic (Mana/Voice/Web search/AI)
// rather than naming node-bot/Kokoro/SearXNG/llama-server specifically,
// since any of those could be swapped for a different tool later without
// this screen needing to change. Wired independently of renderer.js's own
// IIFE (and its backend fetches) since it only talks to main.js over IPC --
// see service-manager.js and main.js's startupState/get-startup-status.
(function () {
  const overlayEl = document.getElementById('startupOverlay');
  const subtitleEl = document.getElementById('startupSubtitle');
  const skipBtnEl = document.getElementById('startupSkipBtn');
  const SERVICE_IDS = ['backend', 'kokoro', 'searxng', 'llama'];
  const DONE_STATUSES = ['ready', 'failed', 'skipped'];
  const STATUS_TEXT = { starting: 'Starting...', ready: 'Ready', failed: 'Failed', skipped: 'Skipped' };

  function hideOverlay() {
    overlayEl?.classList.add('hidden');
  }

  function refreshSubtitle() {
    const readyCount = SERVICE_IDS.filter((id) =>
      document.getElementById(`startupBar-${id}`)?.classList.contains('ready'),
    ).length;
    if (subtitleEl) subtitleEl.textContent = `${readyCount} of ${SERVICE_IDS.length} ready`;
    const allDone = SERVICE_IDS.every((id) => {
      const el = document.getElementById(`startupBar-${id}`);
      return el && DONE_STATUSES.some((status) => el.classList.contains(status));
    });
    if (allDone) hideOverlay();
  }

  function applyUpdate({ id, status, message }) {
    const statusEl = document.getElementById(`startupStatus-${id}`);
    const barEl = document.getElementById(`startupBar-${id}`);
    if (!statusEl || !barEl) return;
    statusEl.textContent = (status === 'failed' || status === 'skipped') && message
      ? message
      : STATUS_TEXT[status] || status;
    statusEl.className = 'startup-row-status ' + status;
    barEl.className = 'startup-bar-fill ' + status;
    refreshSubtitle();
  }

  skipBtnEl?.addEventListener('click', hideOverlay);
  // Catches up on anything that happened before this listener was
  // attached, then the live listener covers everything after.
  window.electronAPI?.getStartupStatus?.().then((snapshot) => {
    Object.values(snapshot || {}).forEach(applyUpdate);
  });
  window.electronAPI?.onStartupProgress?.(applyUpdate);
})();

// Closing screen: mirrors the startup screen above (see main.js's
// before-quit handler and service-manager.js's stopAll/stopChild), just
// reversed and hidden until shutdown actually starts. No snapshot fetch on
// load like startup has -- shutdown only ever begins after this renderer
// is already up, so there's nothing to catch up on.
(function () {
  const overlayEl = document.getElementById('shutdownOverlay');
  const subtitleEl = document.getElementById('shutdownSubtitle');
  const SERVICE_IDS = ['backend', 'kokoro', 'searxng', 'llama'];
  const DONE_STATUSES = ['ready', 'failed', 'skipped'];
  const STATUS_TEXT = { starting: 'Stopping...', ready: 'Stopped', failed: 'Failed', skipped: 'Skipped' };

  function refreshSubtitle() {
    const doneCount = SERVICE_IDS.filter((id) =>
      DONE_STATUSES.some((status) => document.getElementById(`shutdownBar-${id}`)?.classList.contains(status)),
    ).length;
    if (subtitleEl) subtitleEl.textContent = `${doneCount} of ${SERVICE_IDS.length} stopped`;
  }

  function applyUpdate({ id, status, message }) {
    const statusEl = document.getElementById(`shutdownStatus-${id}`);
    const barEl = document.getElementById(`shutdownBar-${id}`);
    if (!statusEl || !barEl) return;
    overlayEl?.classList.remove('hidden');
    statusEl.textContent = message || STATUS_TEXT[status] || status;
    statusEl.className = 'startup-row-status ' + status;
    barEl.className = 'startup-bar-fill ' + status;
    refreshSubtitle();
  }

  window.electronAPI?.onShutdownProgress?.(applyUpdate);
})();
