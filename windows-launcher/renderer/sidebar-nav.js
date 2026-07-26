// New sidebar navigation (issue #98): panel switching, collapse, session
// search filter, and the small real-data panels (Web access, Market watch,
// Vision) added alongside the existing Sessions/Model/Doctor/Settings
// panels. Loaded after renderer.js/session-sidebar.js and shares their
// global scope (classic scripts, not modules), so it can call functions
// like handleVisionHotkey() and runDoctorChecksFromLauncher() directly.

const { shell } = require("electron");
const path = require("path");

const sidebarEl = document.getElementById("sessionSidebar");
const sidebarCollapseBtnEl = document.getElementById("sidebarCollapseBtn");
const sidebarPanelsEl = document.getElementById("sidebarPanels");
const sidebarSearchInputEl = document.getElementById("sidebarSearchInput");
const chatEmptyStateEl = document.getElementById("chatEmptyState");
const chatLogElForNav = document.getElementById("chatLog");

// Popup info bubbles (issue #138): these panels live inside #navInfoModal
// rather than the always-visible #sidebarPanels flow. Sessions is the only
// one left as a regular inline panel -- everything else, including
// Settings, opens as a popup closable by clicking outside it.
const NAV_INFO_PANELS = {
  avatar: "Avatar",
  webAccess: "Web access",
  vision: "Vision",
  model: "Model",
  doctor: "Doctor",
  settings: "Settings",
};
const navInfoModalEl = document.getElementById("navInfoModal");
const navInfoTitleEl = document.getElementById("navInfoTitle");
const navInfoCloseBtnEl = document.getElementById("navInfoCloseBtn");
// doctorBubbleEl is already declared by renderer.js (loaded before this
// file, shared global scope -- see the file header comment above).

function hideNavInfoModal() {
  if (navInfoModalEl) navInfoModalEl.hidden = true;
  if (doctorBubbleEl) doctorBubbleEl.hidden = true;
}

function switchSidebarPanel(panelName) {
  document.querySelectorAll(".nav-item[data-panel]").forEach((el) => {
    el.classList.toggle("active", el.dataset.panel === panelName);
  });
  document.querySelectorAll(".sidebar-panel[data-panel]").forEach((el) => {
    el.hidden = el.dataset.panel !== panelName;
  });

  if (Object.prototype.hasOwnProperty.call(NAV_INFO_PANELS, panelName)) {
    if (navInfoTitleEl) navInfoTitleEl.textContent = NAV_INFO_PANELS[panelName];
    if (navInfoModalEl) navInfoModalEl.hidden = false;
  } else {
    hideNavInfoModal();
  }
}

// Sessions is the only surviving persistent panel -- closing any popup
// (Market watch, Settings, or one of the info panels reached from inside
// Settings) has to land back there explicitly, not just hide the modal, or
// switchSidebarPanel(whatever-was-open)'s own hidden-toggling (nothing but
// that one panel matches) would have already hidden Sessions too, leaving
// the sidebar showing nothing at all.
function closeNavInfoPopup() {
  hideNavInfoModal();
  switchSidebarPanel("sessions");
}

document.querySelectorAll(".nav-item[data-panel]").forEach((el) => {
  el.addEventListener("click", () => switchSidebarPanel(el.dataset.panel));
});

navInfoCloseBtnEl?.addEventListener("click", closeNavInfoPopup);
// Clicking the dimmed backdrop (not the panel itself) closes it too --
// same pattern as memoryModal/confirmModal below.
navInfoModalEl?.addEventListener("click", (e) => {
  if (e.target === navInfoModalEl) closeNavInfoPopup();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && navInfoModalEl && !navInfoModalEl.hidden) closeNavInfoPopup();
});

sidebarCollapseBtnEl?.addEventListener("click", () => {
  sidebarEl?.classList.toggle("collapsed");
});

// Session search: filters the existing #sessionList items by name. Reuses
// session-sidebar.js's rendering -- this just hides/shows what's already
// there, so it stays in sync automatically as sessions are added/renamed.
sidebarSearchInputEl?.addEventListener("input", () => {
  const query = sidebarSearchInputEl.value.trim().toLowerCase();
  document.querySelectorAll("#sessionList .session-item").forEach((item) => {
    const name = item.querySelector(".session-name")?.textContent || "";
    item.classList.toggle("filtered-out", query.length > 0 && !name.toLowerCase().includes(query));
  });
});

// Empty-state placeholder: shown until the first chat bubble appears.
if (chatEmptyStateEl && chatLogElForNav) {
  const syncEmptyState = () => {
    chatEmptyStateEl.classList.toggle("hidden", chatLogElForNav.children.length > 0);
  };
  syncEmptyState();
  new MutationObserver(syncEmptyState).observe(chatLogElForNav, { childList: true });
}

// Avatar panel: mirror the zoom level next to the existing zoom button.
const avatarZoomLabelEl = document.getElementById("avatarZoomLabel");
const ZOOM_PANEL_LABELS = {
  full: "Framing: whole body",
  waist: "Framing: waist-up",
  bust: "Framing: bust-up",
};
document.getElementById("avatarZoomBtn")?.addEventListener("click", () => {
  // renderer.js's own handler already cycled the zoom by the time this
  // second listener runs; read the title it just set instead of
  // re-deriving the level ourselves.
  const title = document.getElementById("avatarZoomBtn")?.title || "";
  if (avatarZoomLabelEl) {
    if (title.startsWith("Whole body")) avatarZoomLabelEl.textContent = ZOOM_PANEL_LABELS.bust;
    else if (title.startsWith("Waist-up")) avatarZoomLabelEl.textContent = ZOOM_PANEL_LABELS.full;
    else if (title.startsWith("Bust-up")) avatarZoomLabelEl.textContent = ZOOM_PANEL_LABELS.waist;
  }
});

// Vision panel: reuse the exact same handler the global hotkey triggers.
document.getElementById("visionLookNowBtn")?.addEventListener("click", () => {
  if (typeof handleVisionHotkey === "function") {
    handleVisionHotkey();
  }
});

// Voice provider dropdown: manual override on top of whatever the backend
// is configured with (see node-bot/tts-runtime.js setProviderOverride).
// The automatic gaming-based switch (server.js) can still change this
// underneath the dropdown; this just gives an explicit way to force one.
const voiceProviderSelectEl = document.getElementById("voiceProviderSelect");
if (voiceProviderSelectEl) {
  fetch("http://localhost:5005/tts/override")
    .then((response) => response.json())
    .then((data) => {
      voiceProviderSelectEl.value = data.override || "";
    })
    .catch(() => {});

  voiceProviderSelectEl.addEventListener("change", () => {
    const provider = voiceProviderSelectEl.value || null;
    fetch("http://localhost:5005/tts/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    }).catch((error) => {
      console.warn("Failed to set TTS provider override:", error.message);
    });
  });
}

// Run an initial Doctor pass on load so the Doctor/Web access nav dots
// aren't stuck grey until the user opens the Doctor panel manually.
if (typeof runDoctorChecksFromLauncher === "function") {
  runDoctorChecksFromLauncher();
}

// Plugins (issue #138): grouped by category, filterable, backed by
// node-bot's plugin-settings-store.js via GET/POST /plugins (issue #131).
const pluginsListEl = document.getElementById("pluginsList");
const pluginsSearchInputEl = document.getElementById("pluginsSearchInput");
const pluginsAddBtnEl = document.getElementById("pluginsAddBtn");
let latestPluginsByCategory = {};

function renderPluginsList(query = "") {
  if (!pluginsListEl) return;
  const normalizedQuery = query.trim().toLowerCase();
  const rows = [];
  for (const category of Object.keys(latestPluginsByCategory)) {
    const plugins = latestPluginsByCategory[category].filter(
      (plugin) =>
        !normalizedQuery ||
        plugin.name.toLowerCase().includes(normalizedQuery) ||
        (plugin.description || "").toLowerCase().includes(normalizedQuery),
    );
    if (plugins.length === 0) continue;
    rows.push(`<div class="plugin-category-label">${escapeHtmlForPlugins(category)}</div>`);
    for (const plugin of plugins) {
      rows.push(`
        <div class="plugin-row">
          <div class="plugin-row-info">
            <strong>${escapeHtmlForPlugins(plugin.name)}</strong>
            <span>${escapeHtmlForPlugins(plugin.description || category)}</span>
          </div>
          <button class="plugin-switch ${plugin.enabled ? "on" : ""}" data-plugin-key="${escapeHtmlForPlugins(plugin.key)}" aria-pressed="${plugin.enabled}" title="${plugin.enabled ? "Enabled" : "Disabled"}"></button>
        </div>`);
    }
  }
  pluginsListEl.innerHTML = rows.join("") || `<p class="sidebar-note">No plugins match "${escapeHtmlForPlugins(query)}".</p>`;
}

function escapeHtmlForPlugins(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

async function loadPlugins() {
  if (!pluginsListEl) return;
  try {
    const response = await fetch("http://localhost:5005/plugins");
    const body = await response.json();
    latestPluginsByCategory = body.plugins || {};
    renderPluginsList(pluginsSearchInputEl?.value || "");
  } catch (error) {
    pluginsListEl.innerHTML = `<p class="sidebar-note">Failed to load plugins: ${escapeHtmlForPlugins(error.message)}</p>`;
  }
}
loadPlugins();

pluginsSearchInputEl?.addEventListener("input", () => {
  renderPluginsList(pluginsSearchInputEl.value);
});

pluginsListEl?.addEventListener("click", async (event) => {
  const switchBtn = event.target.closest(".plugin-switch");
  if (!switchBtn) return;
  const key = switchBtn.dataset.pluginKey;
  const enabled = !switchBtn.classList.contains("on");
  switchBtn.disabled = true;
  try {
    const response = await fetch(`http://localhost:5005/plugins/${encodeURIComponent(key)}/enabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    await loadPlugins();
  } catch (error) {
    console.warn("Failed to toggle plugin:", error.message);
    switchBtn.disabled = false;
  }
});

// No plugin marketplace/installer -- this just points at the docs that
// list what's available and how to add one (see plugins/README.md).
pluginsAddBtnEl?.addEventListener("click", () => {
  shell.openPath(path.join(__dirname, "..", "..", "plugins", "README.md"));
});

// Logs (issue #138): tail of the backend process's stdout/stderr, streamed
// over IPC from main.js's appendBackendLog(). get-backend-log catches up
// on anything that arrived before this listener attached.
const backendLogsEl = document.getElementById("backendLogs");
const BACKEND_LOG_DISPLAY_MAX_CHARS = 20000;

function appendToLogsDisplay(text) {
  if (!backendLogsEl) return;
  const atBottom = backendLogsEl.scrollTop + backendLogsEl.clientHeight >= backendLogsEl.scrollHeight - 4;
  backendLogsEl.textContent += text.endsWith("\n") ? text : `${text}\n`;
  if (backendLogsEl.textContent.length > BACKEND_LOG_DISPLAY_MAX_CHARS) {
    backendLogsEl.textContent = backendLogsEl.textContent.slice(-BACKEND_LOG_DISPLAY_MAX_CHARS);
  }
  if (atBottom) backendLogsEl.scrollTop = backendLogsEl.scrollHeight;
}

if (backendLogsEl && typeof ipcRenderer !== "undefined") {
  ipcRenderer.on("backend-log", (event, text) => appendToLogsDisplay(text));
  ipcRenderer
    .invoke("get-backend-log")
    .then((buffered) => {
      if (buffered) backendLogsEl.textContent = buffered;
    })
    .catch(() => {});
}
