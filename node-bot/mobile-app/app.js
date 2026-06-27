"use strict";

const DB_NAME = "mana-mobile";
const DB_VERSION = 1;
const TOKEN_KEY = "mana.mobile.token";
const TOKEN_EXPIRES_KEY = "mana.mobile.tokenExpiresAt";
const LAST_CHAT_KEY = "mana.mobile.lastChatId";

const state = {
  db: null,
  chats: [],
  currentChatId: "",
  token: localStorage.getItem(TOKEN_KEY) || "",
  tokenExpiresAt: Number(localStorage.getItem(TOKEN_EXPIRES_KEY) || 0),
  speakerEnabled: false,
  isSending: false,
  isRecording: false,
  isStoppingRecording: false,
  mediaRecorder: null,
  recordingChunks: [],
  recordingStream: null,
  recordingChatId: "",
  recordingStartPromise: null,
  recordingStopPromise: null,
};

const els = {
  lockScreen: document.getElementById("lockScreen"),
  chatScreen: document.getElementById("chatScreen"),
  unlockForm: document.getElementById("unlockForm"),
  passcodeInput: document.getElementById("passcodeInput"),
  lockStatus: document.getElementById("lockStatus"),
  connectionStatus: document.getElementById("connectionStatus"),
  chatTitle: document.getElementById("chatTitle"),
  messages: document.getElementById("messages"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  sendButton: document.getElementById("sendButton"),
  chatDrawer: document.getElementById("chatDrawer"),
  chatList: document.getElementById("chatList"),
  chatListButton: document.getElementById("chatListButton"),
  closeDrawerButton: document.getElementById("closeDrawerButton"),
  newChatButton: document.getElementById("newChatButton"),
  sendSummaryButton: document.getElementById("sendSummaryButton"),
  syncButton: document.getElementById("syncButton"),
  syncStatus: document.getElementById("syncStatus"),
  micButton: document.getElementById("micButton"),
  speakerButton: document.getElementById("speakerButton"),
};

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("chats")) {
        db.createObjectStore("chats", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("summaries")) {
        db.createObjectStore("summaries", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAll(storeName) {
  const tx = state.db.transaction(storeName, "readonly");
  return await requestToPromise(tx.objectStore(storeName).getAll());
}

async function put(storeName, value) {
  const tx = state.db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(value);
  await txComplete(tx);
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  if (window.crypto?.randomUUID) {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createChat() {
  const createdAt = nowIso();
  return {
    id: makeId("chat"),
    title: "New chat",
    messages: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function currentChat() {
  return state.chats.find((item) => item.id === state.currentChatId) || null;
}

function findChat(chatId) {
  return state.chats.find((item) => item.id === chatId) || null;
}

async function saveChat(chat) {
  chat.updatedAt = nowIso();
  await put("chats", chat);
}

async function loadChats() {
  state.chats = await getAll("chats");
  state.chats.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  if (!state.chats.length) {
    const chat = createChat();
    state.chats.push(chat);
    await put("chats", chat);
  }

  const lastChatId = localStorage.getItem(LAST_CHAT_KEY);
  state.currentChatId =
    state.chats.find((chat) => chat.id === lastChatId)?.id || state.chats[0].id;
  localStorage.setItem(LAST_CHAT_KEY, state.currentChatId);
  render();
  await refreshSyncStatus();
}

async function addMessageToChat(chatId, role, text, options = {}) {
  const chat = findChat(chatId);
  if (!chat) {
    return null;
  }
  const message = {
    id: options.id || makeId("msg"),
    role,
    text,
    pending: Boolean(options.pending),
    createdAt: nowIso(),
  };
  chat.messages.push(message);
  if (role === "user" && chat.title === "New chat") {
    chat.title = text.slice(0, 42) || "New chat";
  }
  await saveChat(chat);
  sortChats();
  if (chat.id === state.currentChatId) {
    render();
  } else {
    renderChatList();
  }
  return message;
}

async function addMessage(role, text, options = {}) {
  return await addMessageToChat(state.currentChatId, role, text, options);
}

async function addLocalSystemMessage(text, chatId = state.currentChatId) {
  if (!chatId) {
    els.connectionStatus.textContent = text;
    return null;
  }
  return await addMessageToChat(chatId, "system", text);
}

async function updateMessage(chatId, messageId, changes) {
  const chat = findChat(chatId);
  if (!chat) {
    return;
  }
  const message = chat.messages.find((item) => item.id === messageId);
  if (!message) {
    return;
  }
  Object.assign(message, changes);
  await saveChat(chat);
  sortChats();
  if (chat.id === state.currentChatId) {
    render();
  } else {
    renderChatList();
  }
}

function sortChats() {
  state.chats.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function formatChatMeta(chat) {
  const last = chat.messages[chat.messages.length - 1];
  return last ? last.text.slice(0, 64) : "No messages";
}

function renderMessages(chat) {
  els.messages.innerHTML = "";
  if (!chat?.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    els.messages.appendChild(empty);
    return;
  }

  for (const message of chat.messages) {
    const node = document.createElement("div");
    node.className = `message ${message.role}${message.pending ? " pending" : ""}`;
    node.textContent = message.text;
    els.messages.appendChild(node);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderChatList() {
  els.chatList.innerHTML = "";
  for (const item of state.chats) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.id === state.currentChatId ? "active" : "";
    button.textContent = item.title;

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = formatChatMeta(item);
    button.appendChild(meta);

    button.addEventListener("click", () => {
      state.currentChatId = item.id;
      localStorage.setItem(LAST_CHAT_KEY, item.id);
      closeDrawer();
      render();
    });
    els.chatList.appendChild(button);
  }
}

function render() {
  const chat = currentChat();
  const micBusy =
    state.isSending ||
    state.isStoppingRecording ||
    Boolean(state.recordingStopPromise);
  els.chatTitle.textContent = chat?.title || "Mana";
  renderMessages(chat);
  renderChatList();
  els.sendButton.disabled = state.isSending;
  els.micButton.disabled = micBusy && !state.isRecording;
  els.micButton.classList.toggle("recording", state.isRecording);
  els.micButton.setAttribute("aria-pressed", String(state.isRecording));
  els.micButton.setAttribute(
    "aria-label",
    state.isRecording ? "Stop recording" : "Hold to talk",
  );
  const micLabel = els.micButton.querySelector("span");
  if (micLabel) {
    micLabel.textContent = state.isRecording ? "stop" : "mic";
  }
  els.sendSummaryButton.disabled = !hasStableSummaryContent(chat);
  els.speakerButton.textContent = state.speakerEnabled ? "Voice On" : "Voice Off";
  els.speakerButton.setAttribute("aria-pressed", String(state.speakerEnabled));
}

function showChat() {
  els.lockScreen.classList.add("hidden");
  els.chatScreen.classList.remove("hidden");
  els.messageInput.focus();
}

function showLock(message = "Locked") {
  els.chatScreen.classList.add("hidden");
  els.lockScreen.classList.remove("hidden");
  els.lockStatus.textContent = message;
  els.passcodeInput.focus();
}

function clearToken() {
  state.token = "";
  state.tokenExpiresAt = 0;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRES_KEY);
}

function hasValidToken() {
  return Boolean(state.token && state.tokenExpiresAt > Date.now());
}

function authHeaders() {
  return { Authorization: `Bearer ${state.token}` };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return { error: text };
  }
}

async function unlock(passcode) {
  const response = await fetch("/mobile/auth/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(body.error || "Unlock failed");
  }
  state.token = body.token;
  state.tokenExpiresAt = Number(body.expiresAt || 0);
  localStorage.setItem(TOKEN_KEY, state.token);
  localStorage.setItem(TOKEN_EXPIRES_KEY, String(state.tokenExpiresAt));
}

async function checkHealth() {
  try {
    const response = await fetch("/mobile/health", { cache: "no-store" });
    const body = await parseJsonResponse(response);
    els.connectionStatus.textContent = body.ok ? "Connected" : "Unavailable";
  } catch (error) {
    els.connectionStatus.textContent = "Offline";
  }
}

function requireToken() {
  if (!hasValidToken()) {
    clearToken();
    showLock("Session expired");
    throw new Error("Session expired");
  }
}

async function sendTextMessage(text) {
  requireToken();
  const chatId = state.currentChatId;
  state.isSending = true;
  render();
  await addMessageToChat(chatId, "user", text);
  const pending = await addMessageToChat(chatId, "assistant", "Thinking...", {
    pending: true,
  });
  els.connectionStatus.textContent = "Thinking";

  try {
    const response = await fetch("/mobile/chat/text", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ text, chatId }),
    });
    const body = await parseJsonResponse(response);
    if (response.status === 401) {
      clearToken();
      showLock("Session expired");
    }
    if (!response.ok) {
      throw new Error(body.error || "Chat failed");
    }
    await updateMessage(chatId, pending.id, {
      text: body.reply || "",
      pending: false,
    });
    if (state.speakerEnabled && body.reply) {
      await playReply(body.reply);
    }
    els.connectionStatus.textContent = "Connected";
  } catch (error) {
    await updateMessage(chatId, pending.id, {
      role: "system",
      text: error.message,
      pending: false,
    });
    els.connectionStatus.textContent = "Retry needed";
  } finally {
    state.isSending = false;
    render();
  }
}

function stopRecordingStream(stream = state.recordingStream) {
  if (!stream) {
    return;
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function clearRecordingState(recording = {}) {
  const {
    recorder = state.mediaRecorder,
    stream = state.recordingStream,
    chunks = state.recordingChunks,
  } = recording;
  stopRecordingStream(stream);
  if (state.mediaRecorder === recorder) {
    state.mediaRecorder = null;
  }
  if (state.recordingChunks === chunks) {
    state.recordingChunks = [];
  }
  if (state.recordingStream === stream) {
    state.recordingStream = null;
  }
  if (!state.mediaRecorder) {
    state.recordingChatId = "";
  }
  state.recordingStartPromise = null;
  if (!recording.stopPromise || state.recordingStopPromise === recording.stopPromise) {
    state.recordingStopPromise = null;
  }
  state.isRecording = false;
  state.isStoppingRecording = false;
  render();
}

function recordingFilename(blob) {
  if (blob.type.includes("mp4")) {
    return "voice.m4a";
  }
  if (blob.type.includes("ogg")) {
    return "voice.ogg";
  }
  if (blob.type.includes("wav")) {
    return "voice.wav";
  }
  return "voice.webm";
}

async function startRecording() {
  if (state.isRecording || state.recordingStartPromise) {
    return state.recordingStartPromise;
  }
  if (state.isSending || state.isStoppingRecording || state.recordingStopPromise) {
    throw new Error("Please wait for the current reply");
  }
  requireToken();
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Voice recording is not supported");
  }

  state.recordingStartPromise = (async () => {
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      state.recordingStream = stream;
      state.mediaRecorder = recorder;
      state.recordingChunks = chunks;
      state.recordingChatId = state.currentChatId;

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) {
          chunks.push(event.data);
        }
      });

      recorder.start();
      state.isRecording = true;
      els.connectionStatus.textContent = "Recording";
      render();
    } catch (error) {
      stopRecordingStream(stream);
      clearRecordingState({ stream });
      throw error;
    } finally {
      state.recordingStartPromise = null;
    }
  })();

  return await state.recordingStartPromise;
}

async function stopRecording() {
  if (state.recordingStartPromise) {
    await state.recordingStartPromise.catch(() => {});
  }
  if (state.recordingStopPromise) {
    return await state.recordingStopPromise;
  }

  const recorder = state.mediaRecorder;
  const stream = state.recordingStream;
  const chunks = state.recordingChunks;
  if (!recorder || !state.isRecording || state.isStoppingRecording) {
    return;
  }

  const chatId = state.recordingChatId || state.currentChatId;
  state.isRecording = false;
  state.isStoppingRecording = true;
  els.connectionStatus.textContent = "Transcribing";
  render();

  let resolveStop;
  const stopPromise = new Promise((resolve) => {
    resolveStop = resolve;
  });
  state.recordingStopPromise = stopPromise;

  const finalizeRecording = async () => {
    const recordedChunks = chunks.slice();
    const mimeType = recorder.mimeType || recordedChunks[0]?.type || "audio/webm";
    const blob = new Blob(recordedChunks, { type: mimeType });

    if (blob.size) {
      state.isSending = true;
    }
    clearRecordingState({ recorder, stream, chunks, stopPromise });

    if (!blob.size) {
      await addLocalSystemMessage("No voice captured", chatId);
      els.connectionStatus.textContent = "Voice failed";
      resolveStop();
      return;
    }

    await sendAudioMessage(blob, chatId);
    resolveStop();
  };

  recorder.addEventListener("stop", finalizeRecording, { once: true });
  try {
    recorder.stop();
  } catch (error) {
    clearRecordingState({ recorder, stream, chunks, stopPromise });
    addLocalSystemMessage(error.message, chatId).finally(resolveStop);
  }

  return await stopPromise;
}

async function sendAudioMessage(blob, chatId = state.currentChatId) {
  state.isSending = true;
  els.connectionStatus.textContent = "Transcribing";
  render();

  try {
    requireToken();
    const formData = new FormData();
    formData.append("file", blob, recordingFilename(blob));

    const response = await fetch("/mobile/chat/audio", {
      method: "POST",
      headers: authHeaders(),
      body: formData,
    });
    const body = await parseJsonResponse(response);
    if (response.status === 401) {
      clearToken();
      showLock("Session expired");
      throw new Error("Session expired");
    }
    if (!response.ok) {
      throw new Error(body.error || "Voice chat failed");
    }

    const transcript = body.transcript || "";
    const reply = body.reply || "";
    await addMessageToChat(chatId, "user", transcript);
    await addMessageToChat(chatId, "assistant", reply);
    if (state.speakerEnabled && body.ttsConfigured !== false && reply) {
      await playReply(reply);
    }
    els.connectionStatus.textContent = "Connected";
  } catch (error) {
    await addLocalSystemMessage(error.message, chatId);
    els.connectionStatus.textContent = "Voice failed";
  } finally {
    state.isSending = false;
    render();
  }
}

async function playReply(text) {
  requireToken();
  const response = await fetch("/mobile/synthesize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ text }),
  });
  if (response.status === 401) {
    clearToken();
    showLock("Session expired");
    return;
  }
  if (!response.ok) {
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  audio.onerror = () => URL.revokeObjectURL(url);
  await audio.play().catch(() => URL.revokeObjectURL(url));
}

function buildSummaryText(chat) {
  return chat.messages
    .filter(
      (message) =>
        !message.pending &&
        (message.role === "user" || message.role === "assistant"),
    )
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n")
    .slice(0, 4000);
}

function hasPendingMessages(chat) {
  return Boolean(chat?.messages.some((message) => message.pending));
}

function hasStableSummaryContent(chat) {
  return Boolean(buildSummaryText(chat || { messages: [] }));
}

async function queueSummary() {
  const chat = currentChat();
  if (!chat || !chat.messages.length) {
    els.syncStatus.textContent = "No chat to summarize";
    return;
  }
  const excludedPending = hasPendingMessages(chat);
  const summary = buildSummaryText(chat);
  if (!summary) {
    els.syncStatus.textContent = "No chat to summarize";
    return;
  }
  if (excludedPending) {
    els.syncStatus.textContent = "Pending reply excluded";
  }

  const item = {
    id: makeId("summary"),
    chatId: chat.id,
    title: chat.title,
    summary,
    state: "queued",
    source: "phone",
    createdAt: nowIso(),
  };
  await put("summaries", item);
  await syncSummaries();
}

async function refreshSyncStatus() {
  if (!state.db) {
    return;
  }
  const summaries = await getAll("summaries");
  const pending = summaries.filter((item) => item.state !== "sent").length;
  els.syncStatus.textContent = pending
    ? `${pending} pending ${pending === 1 ? "summary" : "summaries"}`
    : "No pending summaries";
}

async function syncSummaries() {
  requireToken();
  const summaries = await getAll("summaries");
  const queued = summaries.filter((item) => item.state !== "sent");

  if (!queued.length) {
    await refreshSyncStatus();
    return;
  }

  els.syncStatus.textContent = `Syncing ${queued.length}`;
  for (const item of queued) {
    try {
      const response = await fetch("/mobile/summaries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          id: item.id,
          chatId: item.chatId,
          title: item.title,
          summary: item.summary,
          source: "phone",
        }),
      });
      if (response.status === 401) {
        clearToken();
        showLock("Session expired");
        break;
      }
      if (response.ok) {
        item.state = "sent";
        item.sentAt = nowIso();
        await put("summaries", item);
      }
    } catch (error) {
      item.lastError = error.message;
      await put("summaries", item);
      break;
    }
  }
  await refreshSyncStatus();
}

async function startNewChat() {
  const chat = createChat();
  state.chats.unshift(chat);
  state.currentChatId = chat.id;
  localStorage.setItem(LAST_CHAT_KEY, chat.id);
  await put("chats", chat);
  closeDrawer();
  render();
}

function openDrawer() {
  els.chatDrawer.classList.remove("hidden");
}

function closeDrawer() {
  els.chatDrawer.classList.add("hidden");
}

function resizeComposer() {
  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${Math.min(112, els.messageInput.scrollHeight)}px`;
}

els.unlockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.lockStatus.textContent = "Unlocking";
  try {
    await unlock(els.passcodeInput.value);
    els.passcodeInput.value = "";
    await loadChats();
    showChat();
    checkHealth();
    syncSummaries().catch(() => refreshSyncStatus());
  } catch (error) {
    showLock(error.message);
  }
});

els.messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text || state.isSending) {
    return;
  }
  els.messageInput.value = "";
  resizeComposer();
  await sendTextMessage(text);
});

els.messageInput.addEventListener("input", resizeComposer);
els.chatListButton.addEventListener("click", openDrawer);
els.closeDrawerButton.addEventListener("click", closeDrawer);
els.newChatButton.addEventListener("click", startNewChat);
els.sendSummaryButton.addEventListener("click", () => {
  queueSummary().catch((error) => {
    els.syncStatus.textContent = error.message;
  });
});
els.syncButton.addEventListener("click", () => {
  syncSummaries().catch((error) => {
    els.syncStatus.textContent = error.message;
  });
});
els.speakerButton.addEventListener("click", () => {
  state.speakerEnabled = !state.speakerEnabled;
  render();
});

const MIC_TAP_TOGGLE_MS = 350;
let micPressStarted = false;
let micPressStartedAt = 0;
let micPressShouldStop = false;
let micPointerDown = false;
let suppressNextMicClick = false;

function handleRecordingError(error) {
  addLocalSystemMessage(error.message).catch(() => {
    els.connectionStatus.textContent = error.message;
  });
}

function beginMicPress() {
  micPressStarted = true;
  micPressStartedAt = Date.now();
  micPressShouldStop = state.isRecording || state.recordingStartPromise;
  if (!micPressShouldStop) {
    startRecording().catch((error) => {
      micPressStarted = false;
      suppressNextMicClick = true;
      handleRecordingError(error);
    });
  }
}

function endMicPress() {
  if (!micPressStarted) {
    return;
  }
  const pressDuration = Date.now() - micPressStartedAt;
  const shouldStop = micPressShouldStop || pressDuration > MIC_TAP_TOGGLE_MS;
  micPressStarted = false;
  micPressShouldStop = false;
  suppressNextMicClick = true;
  if (shouldStop) {
    stopRecording().catch(handleRecordingError);
  }
}

if (window.PointerEvent) {
  els.micButton.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || els.micButton.disabled) {
      return;
    }
    micPointerDown = true;
    els.micButton.setPointerCapture(event.pointerId);
    beginMicPress();
  });
  els.micButton.addEventListener("pointerup", (event) => {
    if (!micPointerDown) {
      return;
    }
    micPointerDown = false;
    if (els.micButton.hasPointerCapture(event.pointerId)) {
      els.micButton.releasePointerCapture(event.pointerId);
    }
    endMicPress();
  });
  els.micButton.addEventListener("pointercancel", () => {
    micPointerDown = false;
    endMicPress();
  });
} else {
  els.micButton.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || els.micButton.disabled) {
      return;
    }
    beginMicPress();
  });
  els.micButton.addEventListener("mouseup", endMicPress);
  els.micButton.addEventListener("mouseleave", endMicPress);
  els.micButton.addEventListener(
    "touchstart",
    (event) => {
      if (els.micButton.disabled) {
        return;
      }
      event.preventDefault();
      beginMicPress();
    },
    { passive: false },
  );
  els.micButton.addEventListener("touchend", endMicPress);
  els.micButton.addEventListener("touchcancel", endMicPress);
}

els.micButton.addEventListener("click", () => {
  if (suppressNextMicClick) {
    suppressNextMicClick = false;
    return;
  }
  if (
    els.micButton.disabled ||
    state.isStoppingRecording ||
    state.recordingStopPromise ||
    state.isSending
  ) {
    return;
  }
  if (state.isRecording || state.recordingStartPromise) {
    stopRecording().catch(handleRecordingError);
  } else {
    startRecording().catch(handleRecordingError);
  }
});

window.addEventListener("online", () => {
  checkHealth();
  syncSummaries().catch(() => refreshSyncStatus());
});
window.addEventListener("offline", () => {
  els.connectionStatus.textContent = "Offline";
});

async function init() {
  if (!("indexedDB" in window)) {
    showLock("Local storage unavailable");
    return;
  }
  state.db = await openDb();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
  if (hasValidToken()) {
    await loadChats();
    showChat();
    checkHealth();
    syncSummaries().catch(() => refreshSyncStatus());
  } else {
    clearToken();
    showLock();
  }
}

init().catch((error) => showLock(error.message));
