// Theme toggles, startup overlay, main DOM wiring (ui.js)
const THEME_STORAGE_KEY = 'manaTheme';
const LISTENING_AUTOSTART_STORAGE_KEY = 'mana_listening_autostart';
const BARGE_IN_STORAGE_KEY = 'mana_barge_in_enabled';

function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark' || choice === 'high-contrast') {
    document.documentElement.setAttribute('data-theme', choice);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  
  // Update toggle button states
  document.querySelectorAll('#themeToggle button[data-theme-choice]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeChoice === choice);
  });
}

// Apply saved theme on load
const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'system';
applyTheme(savedTheme);

// Theme toggle handler
document.getElementById('themeToggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-theme-choice]');
  if (!btn) return;
  
  const choice = btn.dataset.themeChoice;
  localStorage.setItem(THEME_STORAGE_KEY, choice);
  applyTheme(choice);
});

// Startup overlay wiring
(function initStartupOverlay() {
  const overlayEl = document.getElementById('startupOverlay');
  const subtitleEl = document.getElementById('startupSubtitle');
  const skipBtnEl = document.getElementById('startupSkipBtn');
  
  if (!overlayEl) return;
  
  function hideOverlay() {
    overlayEl?.classList.add('hidden');
  }

  // Skip button handler
  skipBtnEl?.addEventListener('click', hideOverlay);

  // Fetch initial startup status snapshot
  window.electronAPI?.getStartupStatus?.().then((snapshot) => {
    if (snapshot && Object.keys(snapshot).length > 0) {
      const readyCount = Object.values(snapshot).filter(s => s.status === 'ready').length;
      if (subtitleEl) subtitleEl.textContent = `${readyCount} services ready`;
      
      // Auto-hide when all services are done
      setTimeout(() => hideOverlay(), 1500);
    } else {
      setTimeout(hideOverlay, 2000);
    }
  }).catch(() => {
    setTimeout(hideOverlay, 3000);
  });

  // Listen for live startup progress updates
  window.electronAPI?.onStartupProgress((update) => {
    const statusEl = document.getElementById(`startupStatus-${update.id}`);
    if (statusEl) {
      statusEl.textContent = update.message || update.status;
      statusEl.className = `startup-row-status ${update.status}`;
      
      // Hide overlay when all services are ready/failed/skipped
      const allDone = document.querySelectorAll('.startup-bar-fill').every(bar => 
        ['ready', 'failed', 'skipped'].some(s => bar.classList.contains(s))
      );
      if (allDone) setTimeout(hideOverlay, 500);
    }
  });
})();

// Barge-in and listening autostart preferences
function getListeningAutostart() {
  return localStorage.getItem(LISTENING_AUTOSTART_STORAGE_KEY) === 'true';
}

function setListeningAutostart(enabled) {
  localStorage.setItem(LISTENING_AUTOSTART_STORAGE_KEY, enabled.toString());
  window.electronAPI?.updatePreference({ key: LISTENING_AUTOSTART_STORAGE_KEY, value: enabled });
}

function getBargeInEnabled() {
  return localStorage.getItem(BARGE_IN_STORAGE_KEY) === 'true';
}

function setBargeInEnabled(enabled) {
  localStorage.setItem(BARGE_IN_STORAGE_KEY, enabled.toString());
  window.electronAPI?.updatePreference({ key: BARGE_IN_STORAGE_KEY, value: enabled });
}

// Expose to global scope for other modules
window.ManaUI = {
  applyTheme,
  getListeningAutostart,
  setListeningAutostart,
  getBargeInEnabled,
  setBargeInEnabled,
};
