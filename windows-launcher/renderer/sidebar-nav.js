// New sidebar navigation (issue #98): panel switching, collapse, session
// search filter, and the small real-data panels (Web access, Market watch,
// Vision) added alongside the existing Sessions/Model/Doctor/Settings
// panels. Loaded after renderer.js/session-sidebar.js and shares their
// global scope (classic scripts, not modules), so it can call functions
// like handleVisionHotkey() and runDoctorChecksFromLauncher() directly.

const sidebarEl = document.getElementById("sessionSidebar");
const sidebarCollapseBtnEl = document.getElementById("sidebarCollapseBtn");
const sidebarPanelsEl = document.getElementById("sidebarPanels");
const sidebarSearchInputEl = document.getElementById("sidebarSearchInput");
const chatEmptyStateEl = document.getElementById("chatEmptyState");
const chatLogElForNav = document.getElementById("chatLog");

function switchSidebarPanel(panelName) {
  document.querySelectorAll(".nav-item[data-panel]").forEach((el) => {
    el.classList.toggle("active", el.dataset.panel === panelName);
  });
  document.querySelectorAll(".sidebar-panel[data-panel]").forEach((el) => {
    el.hidden = el.dataset.panel !== panelName;
  });
}

document.querySelectorAll(".nav-item[data-panel]").forEach((el) => {
  el.addEventListener("click", () => switchSidebarPanel(el.dataset.panel));
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

// Market watch: GET /ffxiv/market?itemName=... (existing backend route).
async function checkMarketWatch() {
  const input = document.getElementById("marketWatchItemInput");
  const resultEl = document.getElementById("marketWatchResult");
  const itemName = input?.value.trim();
  if (!itemName || !resultEl) {
    return;
  }
  resultEl.textContent = "Checking...";
  try {
    const response = await fetch(
      `http://localhost:5005/ffxiv/market?itemName=${encodeURIComponent(itemName)}`,
    );
    const data = await response.json();
    if (!response.ok) {
      resultEl.textContent = data.error || `Request failed (${response.status})`;
      return;
    }
    resultEl.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    resultEl.textContent = `Failed to reach Mana: ${error.message}`;
  }
}
document.getElementById("marketWatchCheckBtn")?.addEventListener("click", checkMarketWatch);
document.getElementById("marketWatchItemInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    checkMarketWatch();
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
