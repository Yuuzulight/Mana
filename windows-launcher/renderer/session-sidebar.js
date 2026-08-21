// Session sidebar: lists named chat sessions backed by the ACP memory store
// (node-bot/acp-memory-store.js + capabilities/sessions-capability.js), with
// New chat, rename, delete, and "open memory" actions. Loaded after
// renderer.js in index.html and shares its global scope (classic scripts,
// not modules) so it can call appendChatMessage/chatLogEl directly and
// exposes ensureSessionId()/refreshSessionList() back to renderer.js.

const SESSIONS_API_BASE = BACKEND_BASE_URL;
const SESSION_STORAGE_KEY = "manaCurrentSessionId";

const sessionListEl = document.getElementById("sessionList");
const newChatBtnEl = document.getElementById("newChatBtn");
const sessionContextMenuEl = document.getElementById("sessionContextMenu");
const memoryModalEl = document.getElementById("memoryModal");
const memoryModalTitleEl = document.getElementById("memoryModalTitle");
const memoryModalBodyEl = document.getElementById("memoryModalBody");
const memoryModalCloseEl = document.getElementById("memoryModalClose");
const confirmModalEl = document.getElementById("confirmModal");
const confirmModalMessageEl = document.getElementById("confirmModalMessage");
const confirmModalOkEl = document.getElementById("confirmModalOk");
const confirmModalCancelEl = document.getElementById("confirmModalCancel");

let currentSessionId = localStorage.getItem(SESSION_STORAGE_KEY) || null;
let contextMenuSessionId = null;

function makeSessionId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  const bytes = window.crypto.getRandomValues(new Uint8Array(8));
  return `session-${Date.now()}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function ensureSessionId() {
  if (!currentSessionId) {
    currentSessionId = makeSessionId();
    localStorage.setItem(SESSION_STORAGE_KEY, currentSessionId);
  }
  return currentSessionId;
}

function formatSessionDate(iso) {
  if (!iso) {
    return "";
  }
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch (e) {
    return "";
  }
}

async function fetchSessions() {
  const response = await fetch(`${SESSIONS_API_BASE}/sessions`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const result = await response.json();
  return Array.isArray(result.sessions) ? result.sessions : [];
}

function clearChatLog() {
  if (chatLogEl) {
    chatLogEl.innerHTML = "";
  }
  // Issue #391: version threads (assignArtifactVersion) shouldn't bleed
  // across sessions -- resetSessionArtifacts lives in renderer.js, which
  // loads before this file and shares its global scope (see this file's
  // own header comment).
  resetSessionArtifacts();
}

async function loadSessionHistory(sessionId) {
  try {
    const response = await fetch(
      `${SESSIONS_API_BASE}/sessions/${encodeURIComponent(sessionId)}`,
    );
    if (response.ok) {
      const session = await response.json();
      for (const turn of session.turns || []) {
        if (turn.user) appendChatMessage("user", turn.user);
        if (turn.assistant) appendChatMessage("mana", turn.assistant);
      }
    }
  } catch (e) {
    console.warn("Mana: failed to load session history", e);
  }
}

async function switchToSession(sessionId) {
  currentSessionId = sessionId;
  localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  clearChatLog();
  await loadSessionHistory(sessionId);
  await refreshSessionList();
}

// On launch, the active session's id already survives in localStorage, but
// nothing had replayed its stored turns back into the chat log — so a
// restart looked like history was lost even though it was still on disk.
async function restoreCurrentSession() {
  const sessionId = ensureSessionId();
  await loadSessionHistory(sessionId);
  await refreshSessionList();
}

function startNewChat() {
  currentSessionId = makeSessionId();
  localStorage.setItem(SESSION_STORAGE_KEY, currentSessionId);
  clearChatLog();
  refreshSessionList();
}

function renderSessionList(sessions) {
  sessionListEl.innerHTML = "";

  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.id = "sessionEmpty";
    empty.textContent = "No saved sessions yet — start chatting to create one.";
    sessionListEl.appendChild(empty);
    return;
  }

  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = "session-item";
    if (session.sessionId === currentSessionId) {
      item.classList.add("active");
    }
    item.dataset.sessionId = session.sessionId;

    const nameEl = document.createElement("div");
    nameEl.className = "session-name";
    nameEl.textContent = session.name || session.sessionId;

    const metaEl = document.createElement("div");
    metaEl.className = "session-meta";
    metaEl.textContent = formatSessionDate(session.updatedAt);

    item.appendChild(nameEl);
    item.appendChild(metaEl);

    // Issue #401: a plain, user-stated goal for this session -- only
    // rendered when one is actually set, same as any other optional field.
    if (session.goal) {
      const goalEl = document.createElement("div");
      goalEl.className = "session-goal";
      goalEl.textContent = `Goal: ${session.goal}`;
      // Raw text, separate from the rendered "Goal: " label -- so
      // beginInlineGoalEdit doesn't have to parse a literal prefix back out
      // of the display string (which would corrupt a goal that itself
      // happens to start with "Goal: ").
      goalEl.dataset.rawGoal = session.goal;
      item.appendChild(goalEl);
    }

    item.addEventListener("click", () => {
      if (session.sessionId !== currentSessionId) {
        switchToSession(session.sessionId);
      }
    });

    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY, session.sessionId);
    });

    sessionListEl.appendChild(item);
  }
}

async function refreshSessionList() {
  try {
    const sessions = await fetchSessions();
    renderSessionList(sessions);
  } catch (e) {
    console.warn("Mana: failed to load session list", e);
  }
}

function openContextMenu(x, y, sessionId) {
  contextMenuSessionId = sessionId;
  sessionContextMenuEl.style.left = `${x}px`;
  sessionContextMenuEl.style.top = `${y}px`;
  sessionContextMenuEl.hidden = false;
}

function closeContextMenu() {
  sessionContextMenuEl.hidden = true;
  contextMenuSessionId = null;
}

document.addEventListener("click", (event) => {
  if (!sessionContextMenuEl.hidden && !sessionContextMenuEl.contains(event.target)) {
    closeContextMenu();
  }
});

function beginInlineRename(sessionId) {
  const item = sessionListEl.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`);
  if (!item) {
    return;
  }
  const nameEl = item.querySelector(".session-name");
  const currentName = nameEl.textContent;

  const input = document.createElement("input");
  input.className = "session-name-input";
  input.value = currentName;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  async function commit() {
    if (settled) return;
    settled = true;
    const newName = input.value.trim();
    if (newName && newName !== currentName) {
      try {
        await fetch(`${SESSIONS_API_BASE}/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName }),
        });
      } catch (e) {
        console.warn("Mana: failed to rename session", e);
      }
    }
    refreshSessionList();
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      settled = true;
      refreshSessionList();
    }
  });
  input.addEventListener("blur", commit);
}

// Issue #401: same inline-edit-and-PATCH shape as beginInlineRename above,
// for the session's optional goal instead of its required name. An empty
// submitted value clears the goal (sessions-capability.js's PATCH route
// treats an empty "goal" string the same way it already treats "name").
function beginInlineGoalEdit(sessionId) {
  const item = sessionListEl.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`);
  if (!item) {
    return;
  }
  const existingGoalEl = item.querySelector(".session-goal");
  const currentGoal = existingGoalEl ? existingGoalEl.dataset.rawGoal || "" : "";

  const input = document.createElement("input");
  input.className = "session-goal-input";
  input.placeholder = "Set a goal for this session...";
  input.value = currentGoal;
  if (existingGoalEl) {
    existingGoalEl.replaceWith(input);
  } else {
    item.querySelector(".session-meta").insertAdjacentElement("afterend", input);
  }
  input.focus();
  input.select();

  let settled = false;
  async function commit() {
    if (settled) return;
    settled = true;
    const newGoal = input.value.trim();
    if (newGoal !== currentGoal) {
      try {
        await fetch(`${SESSIONS_API_BASE}/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal: newGoal }),
        });
      } catch (e) {
        console.warn("Mana: failed to set session goal", e);
      }
    }
    refreshSessionList();
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      settled = true;
      refreshSessionList();
    }
  });
  input.addEventListener("blur", commit);
}

function showConfirmModal(message) {
  return new Promise((resolve) => {
    confirmModalMessageEl.textContent = message;
    confirmModalEl.hidden = false;

    function cleanup(result) {
      confirmModalEl.hidden = true;
      confirmModalOkEl.removeEventListener("click", onOk);
      confirmModalCancelEl.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() {
      cleanup(true);
    }
    function onCancel() {
      cleanup(false);
    }
    confirmModalOkEl.addEventListener("click", onOk);
    confirmModalCancelEl.addEventListener("click", onCancel);
  });
}

async function deleteSessionWithConfirm(sessionId) {
  const confirmed = await showConfirmModal(
    "Delete this session? Its stored memory cannot be recovered.",
  );
  if (!confirmed) {
    return;
  }

  try {
    await fetch(`${SESSIONS_API_BASE}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  } catch (e) {
    console.warn("Mana: failed to delete session", e);
  }

  if (sessionId === currentSessionId) {
    startNewChat();
  } else {
    refreshSessionList();
  }
}

async function openMemoryModal(sessionId) {
  memoryModalTitleEl.textContent = "Session memory";
  memoryModalBodyEl.textContent = "Loading...";
  memoryModalEl.hidden = false;

  try {
    const response = await fetch(
      `${SESSIONS_API_BASE}/sessions/${encodeURIComponent(sessionId)}`,
    );
    if (!response.ok) {
      memoryModalBodyEl.textContent = "This session has no stored memory yet.";
      return;
    }
    const session = await response.json();
    memoryModalTitleEl.textContent = session.name || session.sessionId;

    const parts = [];
    if (session.summary) {
      parts.push(`Summary:\n${session.summary}`);
    }
    if (Array.isArray(session.turns) && session.turns.length) {
      parts.push(
        `Recent turns:\n${session.turns
          .map((turn) => `User: ${turn.user}\nMana: ${turn.assistant || ""}`)
          .join("\n\n")}`,
      );
    }
    memoryModalBodyEl.textContent = parts.length
      ? parts.join("\n\n")
      : "This session has no stored memory yet.";
  } catch (e) {
    memoryModalBodyEl.textContent = `Failed to load memory: ${e.message}`;
  }
}

// Issue #153: pulls the session's ShareGPT JSONL from node-bot and hands
// it to main.js's native save dialog -- this is Electron, not a browser
// tab, so a plain <a download> anchor isn't the right tool here.
async function exportSession(sessionId) {
  try {
    const response = await fetch(
      `${SESSIONS_API_BASE}/sessions/${encodeURIComponent(sessionId)}/export`,
    );
    if (!response.ok) {
      console.warn("Mana: session export failed", await response.text());
      return;
    }
    const content = await response.text();
    await ipcRenderer.invoke("save-export-file", {
      defaultFileName: `${sessionId}.jsonl`,
      content,
    });
  } catch (e) {
    console.warn("Mana: failed to export session", e);
  }
}

memoryModalCloseEl.addEventListener("click", () => {
  memoryModalEl.hidden = true;
});

sessionContextMenuEl.querySelectorAll("button[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const sessionId = contextMenuSessionId;
    const action = button.dataset.action;
    closeContextMenu();
    if (!sessionId) {
      return;
    }
    if (action === "rename") {
      beginInlineRename(sessionId);
    } else if (action === "goal") {
      beginInlineGoalEdit(sessionId);
    } else if (action === "delete") {
      deleteSessionWithConfirm(sessionId);
    } else if (action === "memory") {
      openMemoryModal(sessionId);
    } else if (action === "export") {
      exportSession(sessionId);
    }
  });
});

newChatBtnEl.addEventListener("click", () => {
  startNewChat();
});

restoreCurrentSession();
