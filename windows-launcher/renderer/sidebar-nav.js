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
  snapshots: "Applied edits",
  proposals: "Pending edits",
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
  fetch(`${BACKEND_BASE_URL}/tts/override`)
    .then((response) => response.json())
    .then((data) => {
      voiceProviderSelectEl.value = data.override || "";
    })
    .catch(() => {});

  voiceProviderSelectEl.addEventListener("change", () => {
    const provider = voiceProviderSelectEl.value || null;
    fetch(`${BACKEND_BASE_URL}/tts/override`, {
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
    const response = await fetch(`${BACKEND_BASE_URL}/plugins`);
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
    const response = await fetch(`${BACKEND_BASE_URL}/plugins/${encodeURIComponent(key)}/enabled`, {
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

// Memory (issue #324): browse/manage acp-memory-store's remembered facts
// (memory__remember), including the unverifiedSource flag from issue #317 --
// previously only inspectable by reading facts.json by hand. Mirrors the
// Plugins panel's fetch/search/list pattern above.
const memoryFactsListEl = document.getElementById("memoryFactsList");
const memorySearchInputEl = document.getElementById("memorySearchInput");
let latestMemoryFacts = [];

function renderMemoryFactsList(query = "") {
  if (!memoryFactsListEl) return;
  const normalizedQuery = query.trim().toLowerCase();
  const facts = latestMemoryFacts.filter(
    (fact) =>
      !normalizedQuery ||
      fact.key.toLowerCase().includes(normalizedQuery) ||
      (fact.text || "").toLowerCase().includes(normalizedQuery),
  );
  if (facts.length === 0) {
    memoryFactsListEl.innerHTML = `<p class="sidebar-note">${
      latestMemoryFacts.length ? `No facts match "${escapeHtmlForPlugins(query)}".` : "No remembered facts yet."
    }</p>`;
    return;
  }
  memoryFactsListEl.innerHTML = facts
    .map(
      (fact) => `
        <div class="plugin-row">
          <div class="plugin-row-info">
            <strong>${escapeHtmlForPlugins(fact.key)}</strong>
            <span>${escapeHtmlForPlugins(fact.text)}</span>
            ${fact.unverifiedSource ? '<span class="memory-fact-flag">Unverified source</span>' : ""}
          </div>
          ${
            fact.status === "active"
              ? `<button class="memory-archive-btn" data-fact-key="${escapeHtmlForPlugins(fact.key)}" title="Archive">Archive</button>`
              : `<span class="sidebar-note">${escapeHtmlForPlugins(fact.status)}</span>`
          }
        </div>`,
    )
    .join("");
}

async function loadMemoryFacts() {
  if (!memoryFactsListEl) return;
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/admin/memory/facts`);
    const body = await response.json();
    latestMemoryFacts = body.facts || [];
    renderMemoryFactsList(memorySearchInputEl?.value || "");
  } catch (error) {
    memoryFactsListEl.innerHTML = `<p class="sidebar-note">Failed to load memory: ${escapeHtmlForPlugins(error.message)}</p>`;
  }
}
loadMemoryFacts();

memorySearchInputEl?.addEventListener("input", () => {
  renderMemoryFactsList(memorySearchInputEl.value);
});

memoryFactsListEl?.addEventListener("click", async (event) => {
  const archiveBtn = event.target.closest(".memory-archive-btn");
  if (!archiveBtn) return;
  const key = archiveBtn.dataset.factKey;
  archiveBtn.disabled = true;
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/admin/memory/facts/${encodeURIComponent(key)}/archive`, {
      method: "POST",
    });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    await loadMemoryFacts();
  } catch (error) {
    console.warn("Failed to archive fact:", error.message);
    archiveBtn.disabled = false;
  }
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

// Skills (issue #262 follow-up): create/edit/delete procedural-memory
// skills from Settings, backed by node-bot's skills-store.js via
// GET/POST/PATCH/DELETE /skills. Edit/delete aren't approval-gated (see
// skills-capability.js) -- a Settings form submission already is the human
// decision the gate exists to require for agent-authored writes. Create
// still goes through the same approval-gate path the idle-triggered
// skill-proposal pass (issue #262) uses; a human is right here filling out
// the form, so a "pending" outcome with nothing flagged auto-clears
// instead of surfacing a second confirmation step -- but if the gate's
// content scan actually flagged something (scanContent in
// approval-gate.js), that's specifically the case worth a second look, so
// it's left pending and shown below for explicit review instead.
const skillsSelectEl = document.getElementById("skillsSelect");
const skillsNewBtnEl = document.getElementById("skillsNewBtn");
const skillsEditBtnEl = document.getElementById("skillsEditBtn");
const skillsDeleteBtnEl = document.getElementById("skillsDeleteBtn");
const skillsEditorEl = document.getElementById("skillsEditor");
const skillNameInputEl = document.getElementById("skillNameInput");
const skillDescriptionInputEl = document.getElementById("skillDescriptionInput");
const skillBodyInputEl = document.getElementById("skillBodyInput");
const skillSaveBtnEl = document.getElementById("skillSaveBtn");
const skillCancelBtnEl = document.getElementById("skillCancelBtn");
const skillsStatusEl = document.getElementById("skillsStatus");
const skillsPendingEl = document.getElementById("skillsPending");
const skillsPendingListEl = document.getElementById("skillsPendingList");

let selectedSkillName = "";
let editingSkillName = null; // null while creating a new skill
let latestSkills = [];

// The two skill-write action types (server.js/skill-proposal.js) --
// manual/conversational vs. the idle-triggered autonomous pass -- share
// this one review surface, since either way it's a skill sitting pending
// for a human to look at.
const SKILL_WRITE_ACTION_TYPES = ["skill-write", "skill-write-idle"];

function setSkillsStatus(message, isError = false) {
  if (!skillsStatusEl) return;
  if (!message) {
    skillsStatusEl.hidden = true;
    skillsStatusEl.textContent = "";
    return;
  }
  skillsStatusEl.hidden = false;
  skillsStatusEl.textContent = message;
  skillsStatusEl.classList.toggle("error", Boolean(isError));
}

function setSelectedSkillName(name) {
  selectedSkillName = name || "";
  if (skillsEditBtnEl) skillsEditBtnEl.hidden = !selectedSkillName;
  if (skillsDeleteBtnEl) skillsDeleteBtnEl.hidden = !selectedSkillName;
}

function renderSkillsSelect(skills) {
  if (!skillsSelectEl) return;
  skillsSelectEl.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "None";
  skillsSelectEl.appendChild(noneOption);
  for (const skill of skills) {
    const option = document.createElement("option");
    option.value = skill.name;
    // Flags a skill nobody's actually reached for again since it was
    // approved -- the useCount signal from skills-store.js -- so an
    // approved-but-never-mattered proposal is visible, not indistinguishable
    // from a genuinely useful one.
    option.textContent = skill.useCount ? skill.name : `${skill.name} (unused)`;
    skillsSelectEl.appendChild(option);
  }
  const stillExists = skills.some((skill) => skill.name === selectedSkillName);
  skillsSelectEl.value = stillExists ? selectedSkillName : "";
  setSelectedSkillName(skillsSelectEl.value);
}

function renderPendingSkills(pending) {
  if (!skillsPendingEl || !skillsPendingListEl) return;
  const skillPending = pending.filter((p) => SKILL_WRITE_ACTION_TYPES.includes(p.actionType));
  skillsPendingEl.hidden = skillPending.length === 0;
  skillsPendingListEl.innerHTML = "";
  for (const item of skillPending) {
    const row = document.createElement("div");
    row.className = "skills-pending-item";
    const summary = document.createElement("div");
    summary.className = "skills-pending-item-summary";
    summary.textContent = item.summary || item.payload?.name || "Pending skill";
    row.appendChild(summary);
    if (item.flags?.length) {
      const flags = document.createElement("div");
      flags.className = "skills-pending-item-flags";
      flags.textContent = `Flagged: ${item.flags.join(", ")}`;
      row.appendChild(flags);
    }
    const actions = document.createElement("div");
    actions.className = "skills-pending-item-actions";
    const approveBtn = document.createElement("button");
    approveBtn.textContent = "Approve";
    approveBtn.addEventListener("click", () => decidePendingSkill(item.id, "allow-once"));
    const denyBtn = document.createElement("button");
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => decidePendingSkill(item.id, "deny"));
    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);
    row.appendChild(actions);
    skillsPendingListEl.appendChild(row);
  }
}

async function decidePendingSkill(requestId, decision) {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/approvals/${requestId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (!response.ok) throw new Error(`Decide returned ${response.status}`);
    setSkillsStatus(decision === "deny" ? "Skill proposal denied." : "Skill approved.");
    await refreshSkillsList();
  } catch (error) {
    setSkillsStatus(`Failed to ${decision === "deny" ? "deny" : "approve"}: ${error.message}`, true);
  }
}

async function refreshPendingSkills() {
  if (!skillsPendingEl) return;
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/approvals/pending`);
    if (!response.ok) throw new Error(`Pending approvals returned ${response.status}`);
    const result = await response.json();
    renderPendingSkills(result.pending || []);
  } catch (error) {
    console.warn("Mana pending skills list failed:", error.message);
  }
}

async function refreshSkillsList() {
  if (!skillsSelectEl) return;
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/skills`);
    if (!response.ok) throw new Error(`Skill list returned ${response.status}`);
    const result = await response.json();
    latestSkills = result.skills || [];
    renderSkillsSelect(latestSkills);
  } catch (error) {
    setSkillsStatus(`Failed to load skills: ${error.message}`, true);
  }
  await refreshPendingSkills();
}
refreshSkillsList();
// A proposal (idle or from elsewhere) can land while Settings just sits
// open -- poll the lightweight pending-only endpoint so it shows up
// without requiring a local save/delete/decide action first.
setInterval(refreshPendingSkills, 15000);

function closeSkillEditor() {
  editingSkillName = null;
  if (skillsEditorEl) skillsEditorEl.hidden = true;
  if (skillNameInputEl) {
    skillNameInputEl.value = "";
    skillNameInputEl.disabled = false;
  }
  if (skillDescriptionInputEl) skillDescriptionInputEl.value = "";
  if (skillBodyInputEl) skillBodyInputEl.value = "";
}

function openSkillEditor(skill) {
  editingSkillName = skill ? skill.name : null;
  if (skillNameInputEl) {
    skillNameInputEl.value = skill ? skill.name : "";
    // Renaming isn't supported by skills-store.js's updateSkill -- keep the
    // name field locked once a skill already exists.
    skillNameInputEl.disabled = Boolean(skill);
  }
  if (skillDescriptionInputEl) skillDescriptionInputEl.value = skill ? skill.description : "";
  if (skillBodyInputEl) skillBodyInputEl.value = skill ? skill.body : "";
  if (skillsEditorEl) skillsEditorEl.hidden = false;
  (skillNameInputEl?.disabled ? skillDescriptionInputEl : skillNameInputEl)?.focus();
}

skillsSelectEl?.addEventListener("change", () => {
  setSelectedSkillName(skillsSelectEl.value);
});

skillsNewBtnEl?.addEventListener("click", () => {
  setSkillsStatus(null);
  openSkillEditor(null);
});

skillsEditBtnEl?.addEventListener("click", async () => {
  if (!selectedSkillName) return;
  try {
    // touch=false: browsing into Edit isn't Mana actually reaching for the
    // skill -- shouldn't bump lastUsed/un-stale it just because the user
    // opened (and maybe cancelled) the editor.
    const response = await fetch(
      `${BACKEND_BASE_URL}/skills/${encodeURIComponent(selectedSkillName)}?touch=false`,
    );
    if (!response.ok) throw new Error(`Load skill returned ${response.status}`);
    setSkillsStatus(null);
    openSkillEditor(await response.json());
  } catch (error) {
    setSkillsStatus(`Failed to load skill: ${error.message}`, true);
  }
});

skillCancelBtnEl?.addEventListener("click", closeSkillEditor);

skillSaveBtnEl?.addEventListener("click", async () => {
  const name = skillNameInputEl?.value.trim();
  const description = skillDescriptionInputEl?.value.trim();
  const body = skillBodyInputEl?.value.trim();
  if (!name || !description || !body) return;

  skillSaveBtnEl.disabled = true;
  try {
    if (editingSkillName) {
      const response = await fetch(`${BACKEND_BASE_URL}/skills/${encodeURIComponent(editingSkillName)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, body }),
      });
      if (!response.ok) throw new Error(`Save skill returned ${response.status}`);
      setSkillsStatus("Skill updated.");
    } else {
      const response = await fetch(`${BACKEND_BASE_URL}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, body }),
      });
      if (!response.ok) throw new Error(`Create skill returned ${response.status}`);
      const outcome = await response.json();
      if (outcome.status === "pending" && outcome.requestId) {
        if (!outcome.flags || outcome.flags.length === 0) {
          // Nothing the content scan flagged, and a human just typed this
          // in directly -- auto-clear the hold instead of a redundant
          // second confirmation step.
          const decideResponse = await fetch(`${BACKEND_BASE_URL}/approvals/${outcome.requestId}/decide`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "allow-once" }),
          });
          if (!decideResponse.ok) throw new Error(`Approve skill returned ${decideResponse.status}`);
          setSkillsStatus("Skill created.");
        } else {
          // Flagged -- leave it genuinely pending rather than rubber-
          // stamping past the scan's own tripwire; shows up in the
          // pending-review list above for an explicit decision.
          setSkillsStatus(`Staged for review (flagged: ${outcome.flags.join(", ")}).`);
        }
      } else {
        setSkillsStatus("Skill created.");
      }
    }
    closeSkillEditor();
    setSelectedSkillName(name);
    await refreshSkillsList();
  } catch (error) {
    setSkillsStatus(`Failed to save skill: ${error.message}`, true);
  } finally {
    skillSaveBtnEl.disabled = false;
  }
});

skillsDeleteBtnEl?.addEventListener("click", async () => {
  if (!selectedSkillName) return;
  const confirmed =
    typeof showConfirmModal === "function"
      ? await showConfirmModal(`Delete skill "${selectedSkillName}"? This cannot be undone.`)
      : window.confirm(`Delete skill "${selectedSkillName}"?`);
  if (!confirmed) return;
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/skills/${encodeURIComponent(selectedSkillName)}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`Delete skill returned ${response.status}`);
    setSkillsStatus("Skill deleted.");
    setSelectedSkillName("");
    await refreshSkillsList();
  } catch (error) {
    setSkillsStatus(`Failed to delete skill: ${error.message}`, true);
  }
});

// Connection (issue #190): lets the backend URL point at a remote node-bot
// instead of only a co-located one. BACKEND_BASE_URL itself (from
// backend-config.js) is only read once at startup, so this just persists
// the new value and tells the user to restart -- no live-reload wiring.
const backendUrlInputEl = document.getElementById("backendUrlInput");
const backendUrlSaveBtnEl = document.getElementById("backendUrlSaveBtn");

if (backendUrlInputEl) {
  backendUrlInputEl.value = BACKEND_BASE_URL;
}

backendUrlSaveBtnEl?.addEventListener("click", async () => {
  const url = backendUrlInputEl?.value.trim();
  if (!url) return;
  backendUrlSaveBtnEl.disabled = true;
  const originalLabel = backendUrlSaveBtnEl.textContent;
  try {
    await setBackendBaseUrl(url);
    backendUrlSaveBtnEl.textContent = "Saved -- restart to apply";
  } catch (error) {
    backendUrlSaveBtnEl.textContent = `Failed: ${error.message}`;
  } finally {
    setTimeout(() => {
      backendUrlSaveBtnEl.textContent = originalLabel;
      backendUrlSaveBtnEl.disabled = false;
    }, 2500);
  }
});
