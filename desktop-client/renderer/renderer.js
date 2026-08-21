// nodeIntegration is off (see main.js) -- these come from plain classic
// <script> tags loaded before this one (see index_fixed.html), same as
// PIXI/Live2DCubismCore already do, not require().
const { createLive2dAvatar } = window.ManaLive2DAvatar;
const { detectReplyEmotion } = window.ManaReplyEmotion;
const { formatCompareProfileLabel, pickDefaultCompareProfiles } = window.ManaCompareMode;
const { createDesktopStreamingChunkQueue } = window.ManaStreamingChunkQueue;

// Theme (Settings > Appearance): applied at the top level, before the async
// IIFE below does anything else, so there's no flash of the wrong theme
// while backend calls are still in flight. "System" (the default) just
// means no data-theme attribute -- style.css's prefers-color-scheme media
// query is then the only source of truth; Light/Dark set the attribute,
// which wins over that media query regardless of the OS setting (see the
// :root[data-theme] rules in style.css).
const THEME_STORAGE_KEY = 'manaTheme';
const LISTENING_AUTOSTART_STORAGE_KEY = 'mana_listening_autostart';
const BARGE_IN_STORAGE_KEY = 'mana_barge_in_enabled';
function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') {
    document.documentElement.setAttribute('data-theme', choice);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  document.querySelectorAll('#themeToggle button[data-theme-choice]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeChoice === choice);
  });
}
applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || 'system');
document.getElementById('themeToggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-theme-choice]');
  if (!btn) return;
  const choice = btn.dataset.themeChoice;
  localStorage.setItem(THEME_STORAGE_KEY, choice);
  applyTheme(choice);
});

// Startup loading screen: labels are generic (Mana/Voice/Web search/AI)
// rather than naming node-bot/Kokoro/SearXNG/llama-server specifically,
// since any of those could be swapped for a different tool later without
// this screen needing to change. Wired independently of the IIFE below
// (and its backend fetches) since it only talks to main.js over IPC --
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

(async function(){
  const statusEl = document.getElementById('status');
  const messagesEl = document.getElementById('messages');
  const historyLoadingEl = document.getElementById('historyLoading');
  const logsEl = document.getElementById('backendLogs');
  const live2dCanvas = document.getElementById('live2dCanvas');
  const avatarZoomBtn = document.getElementById('btnAvatarZoom');
  const avatarNoticeLink = document.getElementById('avatarNoticeLink');
  const messageInputEl = document.getElementById('messageInput');
  const btnResearchEl = document.getElementById('btnResearch');
  const researchProgressEl = document.getElementById('researchProgress');
  const researchProgressLabelEl = document.getElementById('researchProgressLabel');
  const researchCancelBtnEl = document.getElementById('researchCancelBtn');
  const btnCompareEl = document.getElementById('btnCompare');
  const comparePanelEl = document.getElementById('comparePanel');
  const compareProfileAEl = document.getElementById('compareProfileA');
  const compareProfileBEl = document.getElementById('compareProfileB');
  const compareResultAEl = document.getElementById('compareResultA');
  const compareResultBEl = document.getElementById('compareResultB');
  const compareLabelAEl = document.getElementById('compareLabelA');
  const compareLabelBEl = document.getElementById('compareLabelB');
  const comparePreferAEl = document.getElementById('comparePreferA');
  const comparePreferBEl = document.getElementById('comparePreferB');
  const compareColumnAEl = document.getElementById('compareColumnA');
  const compareColumnBEl = document.getElementById('compareColumnB');
  const compareCancelBtnEl = document.getElementById('compareCancelBtn');
  const navHomeBtnEl = document.getElementById('navHomeBtn');
  const navSettingsBtnEl = document.getElementById('navSettingsBtn');
  const navNewChatBtnEl = document.getElementById('navNewChatBtn');
  const navSearchBtnEl = document.getElementById('navSearchBtn');
  const navAvatarBtnEl = document.getElementById('navAvatarBtn');
  const navWebBtnEl = document.getElementById('navWebBtn');
  const navMarketBtnEl = document.getElementById('navMarketBtn');
  const navVisionBtnEl = document.getElementById('navVisionBtn');
  const navModelBtnEl = document.getElementById('navModelBtn');
  const navDoctorBtnEl = document.getElementById('navDoctorBtn');
  const navSnapshotsBtnEl = document.getElementById('navSnapshotsBtn');
  const navInfoModalEl = document.getElementById('navInfoModal');
  const navInfoTitleEl = document.getElementById('navInfoTitle');
  const navInfoBodyEl = document.getElementById('navInfoBody');
  const navInfoCloseBtnEl = document.getElementById('navInfoCloseBtn');
  const navInfoXBtnEl = document.getElementById('navInfoXBtn');
  const homeViewEl = document.getElementById('homeView');
  const settingsViewEl = document.getElementById('settingsView');
  const sessionsViewEl = document.getElementById('sessionsView');
  const sessionListEl = document.getElementById('sessionList');
  const presetSelectEl = document.getElementById('presetSelect');
  const presetNewBtnEl = document.getElementById('presetNewBtn');
  const presetEditBtnEl = document.getElementById('presetEditBtn');
  const presetDeleteBtnEl = document.getElementById('presetDeleteBtn');
  const presetEditorEl = document.getElementById('presetEditor');
  const presetNameInputEl = document.getElementById('presetNameInput');
  const presetInstructionsInputEl = document.getElementById('presetInstructionsInput');
  const presetSaveBtnEl = document.getElementById('presetSaveBtn');
  const presetCancelBtnEl = document.getElementById('presetCancelBtn');
  const updateVersionEl = document.getElementById('updateVersion');
  const updateStatusEl = document.getElementById('updateStatus');
  const checkUpdatesBtnEl = document.getElementById('checkUpdatesBtn');
  const pluginsListEl = document.getElementById('pluginsList');
  const skillsSelectEl = document.getElementById('skillsSelect');
  const skillsNewBtnEl = document.getElementById('skillsNewBtn');
  const skillsEditBtnEl = document.getElementById('skillsEditBtn');
  const skillsDeleteBtnEl = document.getElementById('skillsDeleteBtn');
  const skillsEditorEl = document.getElementById('skillsEditor');
  const skillNameInputEl = document.getElementById('skillNameInput');
  const skillDescriptionInputEl = document.getElementById('skillDescriptionInput');
  const skillBodyInputEl = document.getElementById('skillBodyInput');
  const skillSaveBtnEl = document.getElementById('skillSaveBtn');
  const skillCancelBtnEl = document.getElementById('skillCancelBtn');
  const skillsStatusEl = document.getElementById('skillsStatus');
  const skillsPendingEl = document.getElementById('skillsPending');
  const skillsPendingListEl = document.getElementById('skillsPendingList');
  const modelCurrentEl = document.getElementById('modelCurrent');
  const modelScanBtnEl = document.getElementById('modelScanBtn');
  const modelBrowseBtnEl = document.getElementById('modelBrowseBtn');
  const modelClearBtnEl = document.getElementById('modelClearBtn');
  const modelScanResultsEl = document.getElementById('modelScanResults');
  const useRemoteAiToggleEl = document.getElementById('useRemoteAiToggle');
  const listeningAutostartToggleEl = document.getElementById('listeningAutostartToggle');
  if (listeningAutostartToggleEl) {
    listeningAutostartToggleEl.checked = localStorage.getItem(LISTENING_AUTOSTART_STORAGE_KEY) === '1';
    listeningAutostartToggleEl.addEventListener('change', () => {
      localStorage.setItem(LISTENING_AUTOSTART_STORAGE_KEY, listeningAutostartToggleEl.checked ? '1' : '0');
    });
  }
  const bargeInToggleEl = document.getElementById('bargeInToggle');
  if (bargeInToggleEl) {
    bargeInToggleEl.checked = localStorage.getItem(BARGE_IN_STORAGE_KEY) !== '0';
    bargeInToggleEl.addEventListener('change', () => {
      localStorage.setItem(BARGE_IN_STORAGE_KEY, bargeInToggleEl.checked ? '1' : '0');
    });
  }
  const brainProviderFieldsEl = document.getElementById('brainProviderFields');
  const brainProviderSelectEl = document.getElementById('brainProviderSelect');
  const brainBaseUrlEl = document.getElementById('brainBaseUrl');
  const brainModelEl = document.getElementById('brainModel');
  const brainApiKeyEl = document.getElementById('brainApiKey');
  const brainProviderConnectBtnEl = document.getElementById('brainProviderConnectBtn');
  const brainProviderSaveBtnEl = document.getElementById('brainProviderSaveBtn');
  const brainProviderStatusEl = document.getElementById('brainProviderStatus');
  const visionModelPathEl = document.getElementById('visionModelPath');
  const visionMmprojPathEl = document.getElementById('visionMmprojPath');
  const visionModelBrowseBtnEl = document.getElementById('visionModelBrowseBtn');
  const visionMmprojBrowseBtnEl = document.getElementById('visionMmprojBrowseBtn');
  const visionModelClearBtnEl = document.getElementById('visionModelClearBtn');
  const visionModelStatusEl = document.getElementById('visionModelStatus');

  // silero-vad.js/voice-endpointing.js are loaded as classic <script> tags
  // (see index_fixed.html), not require()'d -- same reasoning as
  // window.ManaLive2DAvatar etc. at the top of this file, since this
  // renderer runs with nodeIntegration:false/contextIsolation:true.
  const { createSileroVad } = window.ManaSileroVad;
  const {
    FRAME_SAMPLES: VAD_FRAME_SAMPLES,
    SAMPLE_RATE: VAD_SAMPLE_RATE,
  } = window.ManaSileroVad;
  const {
    shouldStopRecording,
    nextBargeInState,
    dbfsFromSamples,
    DEFAULT_MAX_WAIT_FOR_SPEECH_MS: MAX_WAIT_FOR_SPEECH_MS,
    DEFAULT_SILENCE_BUFFER_MS: SILENCE_BUFFER_MS,
    DEFAULT_MAX_UTTERANCE_MS: MAX_UTTERANCE_MS,
    DEFAULT_BARGE_IN_HOLD_MS: BARGE_IN_HOLD_MS,
    DEFAULT_BARGE_IN_MIN_DBFS: BARGE_IN_MIN_DBFS,
  } = window.ManaVoiceEndpointing;

  // process.env isn't available here (nodeIntegration:false, unlike
  // windows-launcher's renderer, which this block otherwise matches) -- so
  // these are just fixed defaults rather than env-var-overridable knobs.
  const VAD_THRESHOLD = 0.5;
  const VAD_DISABLED = false;
  const VAD_MODEL_URL = '../assets/vad/silero_vad.onnx';
  const MIN_SPEECH_RMS = 0.012;
  const SILENCE_METER_INTERVAL_MS = 150;
  // #341 Sub-project A: how often to snapshot the audio recorded so far
  // and poll for a partial transcript while the user is still speaking.
  const PARTIAL_TRANSCRIPT_POLL_MS = 1200;
  const LISTEN_PAUSE_MS = 250;
  const BARGE_IN_POLL_MS = 50;

  // Barge-in can misfire on residual echo -- windows-launcher gates it
  // behind MANA_BARGE_IN_VOICE (env var, default on) as the documented
  // remedy. process.env isn't available here, so this is a localStorage-
  // backed on/off switch instead (settable via devtools console, or the
  // Settings toggle below), same pattern as LISTENING_AUTOSTART_STORAGE_KEY.
  // Default on. Also gated on `listening` -- barge-in should only run while
  // continuous listening is actually on, not for every reply regardless of
  // trigger (push-to-talk-only users shouldn't get this behavior change).
  function bargeInEnabled() {
    return listening && localStorage.getItem(BARGE_IN_STORAGE_KEY) !== '0';
  }

  let sileroVad = null;
  let sileroVadLoadFailed = false;
  let listening = false;

  function getSileroVad() {
    if (VAD_DISABLED || sileroVadLoadFailed || typeof window.ort === 'undefined') {
      return null;
    }
    if (!sileroVad) {
      sileroVad = createSileroVad({
        ort: window.ort,
        modelUrl: VAD_MODEL_URL,
        threshold: VAD_THRESHOLD,
      });
    }
    return sileroVad;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function ensureMediaStream() {
    if (!mediaStream) {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    return mediaStream;
  }

  let mediaStream = null;
  let recorder = null;
  let chunks = [];
  let live2dAvatar = null;
  let deepResearchRunning = false;
  let currentResearchJobId = null;

  // Chat sessions (New chat / Sessions nav buttons): backed by node-bot's
  // acp-memory-store.js + capabilities/sessions-capability.js, which already
  // persist/name/rename sessions server-side -- this just has to generate
  // and remember a sessionId, send it along with every message, and render
  // what comes back. sessionId lives in localStorage (same pattern as the
  // theme choice above) so relaunching Mana resumes the same conversation
  // instead of silently starting a new one.
  const SESSION_STORAGE_KEY = 'manaCurrentSessionId';
  const SESSIONS_API = 'http://127.0.0.1:5005';
  let currentSessionId = localStorage.getItem(SESSION_STORAGE_KEY) || null;
  let nextBeforeCursor = null;
  let hasMoreHistory = false;
  let loadingHistory = false;

  function makeSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = window.crypto.getRandomValues(new Uint8Array(8));
    return `session-${Date.now()}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  function ensureSessionId() {
    if (!currentSessionId) {
      currentSessionId = makeSessionId();
      localStorage.setItem(SESSION_STORAGE_KEY, currentSessionId);
    }
    return currentSessionId;
  }

  // Issue #391: every artifact detected this session, in chronological
  // order, each enriched with a threadId/versionIndex (see
  // window.electronAPI.assignArtifactVersion). Live messages (appendMessage)
  // always arrive in true chronological order and push onto the end.
  // Historical messages (prependTurns) arrive in scroll-back order --
  // oldest-in-page-first within one fetched page, but a later scroll-back
  // fetches an OLDER page after a newer one already loaded -- so each
  // page's turns are threaded only against each other (not the
  // already-loaded newer content) and the whole page is unshifted onto the
  // front as a unit. Version-thread continuity across a scroll-back page
  // boundary isn't attempted; within one page (which covers most sessions)
  // it works the same as the live case.
  let sessionArtifacts = [];

  // Renders `text` as sanitized markdown into `div`, and -- if a big or
  // ```html fenced block is found (issue #148) -- replaces it with a
  // button that opens the full content (and every other version in its
  // thread, issue #391) in its own window instead of dominating the bubble.
  // `artifact` is already-versioned (threadId/versionIndex assigned by the
  // caller) or null.
  function renderBubbleContent(div, text, artifact) {
    const displayText = artifact ? text.replace(artifact.matchedText, '').trim() : text;
    div.innerHTML = window.electronAPI.renderMarkdownToSafeHtml(displayText);

    if (artifact) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-artifact-open';
      button.textContent = `Open ${artifact.language} content in new window`;
      button.addEventListener('click', () => {
        const thread = sessionArtifacts.filter((a) => a.threadId === artifact.threadId);
        window.electronAPI.openArtifact({ thread, index: thread.indexOf(artifact) });
      });
      div.appendChild(button);
    }
  }

  // Appends one new bubble to the live end of the conversation (a message
  // just sent or just replied to) -- as opposed to prependTurns() below,
  // which inserts older history at the top during scroll-back.
  function appendMessage(role, text) {
    if (!messagesEl || !text) return null;
    const div = document.createElement('div');
    div.className = 'message ' + (role === 'user' ? 'system' : 'assistant');
    const rawArtifact = window.electronAPI.extractArtifact(text);
    let artifact = null;
    if (rawArtifact) {
      artifact = window.electronAPI.assignArtifactVersion(rawArtifact, sessionArtifacts);
      sessionArtifacts.push(artifact);
    }
    renderBubbleContent(div, text, artifact);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function prependTurns(turns) {
    if (!messagesEl || !turns || !turns.length) return;

    // Pass 1: extract raw artifacts for the whole page and thread them
    // against each other only (see this section's header comment).
    const rawByTurn = turns.map((turn) => ({
      user: turn.user ? window.electronAPI.extractArtifact(turn.user) : null,
      assistant: turn.assistant ? window.electronAPI.extractArtifact(turn.assistant) : null,
    }));
    const pageArtifacts = [];
    for (const raw of rawByTurn) {
      if (raw.user) {
        raw.userVersioned = window.electronAPI.assignArtifactVersion(raw.user, pageArtifacts);
        pageArtifacts.push(raw.userVersioned);
      }
      if (raw.assistant) {
        raw.assistantVersioned = window.electronAPI.assignArtifactVersion(raw.assistant, pageArtifacts);
        pageArtifacts.push(raw.assistantVersioned);
      }
    }
    sessionArtifacts = [...pageArtifacts, ...sessionArtifacts];

    // Pass 2: build the DOM using each turn's already-versioned artifact.
    const frag = document.createDocumentFragment();
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const raw = rawByTurn[i];
      if (turn.user) {
        const u = document.createElement('div');
        u.className = 'message system';
        renderBubbleContent(u, turn.user, raw.userVersioned || null);
        frag.appendChild(u);
      }
      if (turn.assistant) {
        const a = document.createElement('div');
        a.className = 'message assistant';
        renderBubbleContent(a, turn.assistant, raw.assistantVersioned || null);
        frag.appendChild(a);
      }
    }
    const anchor = historyLoadingEl?.nextSibling || null;
    messagesEl.insertBefore(frag, anchor);
  }

  function clearMessages() {
    messagesEl?.querySelectorAll('.message').forEach((el) => el.remove());
    nextBeforeCursor = null;
    hasMoreHistory = false;
    sessionArtifacts = [];
  }

  async function fetchHistoryPage(sessionId, before) {
    const params = new URLSearchParams({ limit: '20' });
    if (before !== undefined && before !== null) params.set('before', String(before));
    const resp = await fetch(`${SESSIONS_API}/sessions/${encodeURIComponent(sessionId)}/turns?${params}`);
    if (!resp.ok) return null;
    return resp.json();
  }

  async function loadInitialHistory(sessionId) {
    const page = await fetchHistoryPage(sessionId);
    if (!page) return;
    prependTurns(page.turns);
    hasMoreHistory = page.hasMore;
    nextBeforeCursor = page.nextBefore;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Scrolling near the top loads the next chunk further back in time.
  // Scroll position is preserved by measuring how much the content grew and
  // shifting scrollTop by exactly that -- otherwise prepending content above
  // the viewport yanks the view down to a random spot.
  async function loadOlderMessages() {
    if (loadingHistory || !hasMoreHistory || !currentSessionId || !messagesEl) return;
    loadingHistory = true;
    if (historyLoadingEl) historyLoadingEl.hidden = false;
    const previousScrollHeight = messagesEl.scrollHeight;
    try {
      const page = await fetchHistoryPage(currentSessionId, nextBeforeCursor);
      if (page) {
        prependTurns(page.turns);
        hasMoreHistory = page.hasMore;
        nextBeforeCursor = page.nextBefore;
        messagesEl.scrollTop = messagesEl.scrollHeight - previousScrollHeight + messagesEl.scrollTop;
      }
    } finally {
      loadingHistory = false;
      if (historyLoadingEl) historyLoadingEl.hidden = true;
    }
  }

  async function switchToSession(sessionId) {
    currentSessionId = sessionId;
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    clearMessages();
    showView('home');
    await loadInitialHistory(sessionId);
    refreshSessionList();
  }

  function startNewChat() {
    currentSessionId = makeSessionId();
    localStorage.setItem(SESSION_STORAGE_KEY, currentSessionId);
    clearMessages();
    if (messageInputEl) messageInputEl.value = '';
    showView('home');
  }

  function formatSessionDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  function beginInlineRename(sessionId, currentName) {
    const item = sessionListEl?.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`);
    if (!item) return;
    const nameEl = item.querySelector('.session-name');
    const input = document.createElement('input');
    input.className = 'session-name-input';
    input.value = currentName || sessionId;
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
          await fetch(`${SESSIONS_API}/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }),
          });
        } catch (e) {
          console.warn('Failed to rename session:', e);
        }
      }
      refreshSessionList();
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        settled = true;
        refreshSessionList();
      }
    });
    input.addEventListener('blur', commit);
  }

  function renderSessionList(sessions) {
    if (!sessionListEl) return;
    sessionListEl.innerHTML = '';
    if (!sessions.length) {
      sessionListEl.innerHTML = '<p class="subtitle">No saved sessions yet -- start chatting to create one.</p>';
      return;
    }
    for (const session of sessions) {
      const item = document.createElement('div');
      item.className = 'session-item' + (session.sessionId === currentSessionId ? ' active' : '');
      item.dataset.sessionId = session.sessionId;

      const nameEl = document.createElement('div');
      nameEl.className = 'session-name';
      nameEl.textContent = session.name || session.sessionId;

      const metaEl = document.createElement('div');
      metaEl.className = 'session-meta';
      metaEl.textContent = formatSessionDate(session.updatedAt);

      const renameBtn = document.createElement('button');
      renameBtn.className = 'session-rename-btn';
      renameBtn.title = 'Rename';
      renameBtn.type = 'button';
      renameBtn.textContent = '✎';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        beginInlineRename(session.sessionId, session.name);
      });

      item.appendChild(nameEl);
      item.appendChild(metaEl);
      item.appendChild(renameBtn);
      item.addEventListener('click', () => {
        if (session.sessionId !== currentSessionId) switchToSession(session.sessionId);
      });
      sessionListEl.appendChild(item);
    }
  }

  async function refreshSessionList() {
    if (!sessionListEl) return;
    try {
      const resp = await fetch(`${SESSIONS_API}/sessions`);
      const j = await resp.json();
      renderSessionList(Array.isArray(j.sessions) ? j.sessions : []);
    } catch (e) {
      sessionListEl.innerHTML = `<p class="subtitle">Failed to load sessions: ${String(e.message || e)}</p>`;
    }
  }

  messagesEl?.addEventListener('scroll', () => {
    if (messagesEl.scrollTop < 80) loadOlderMessages();
  });

  // Issue #253: preferredExpression is the model's own expression__set tool
  // choice for this reply (from the /reply or /transcribe response's
  // `expression` field, if any) -- passed alongside the automatically-
  // detected state, not instead of it.
  async function speakReply(replyText, preferredExpression) {
    setSprite('speaking');
    if (live2dAvatar) live2dAvatar.setState(detectReplyEmotion(replyText), preferredExpression);
    try {
      const sresp = await fetch('http://127.0.0.1:5005/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: replyText }),
      });
      if (sresp.ok) {
        const arr = await sresp.arrayBuffer();
        const audioCtx = new AudioContext();
        const buf = await audioCtx.decodeAudioData(arr);
        // Awaited so this function's promise resolves only once playback has
        // actually finished (naturally, or cut short by barge-in's stop()),
        // not merely once it has started. speakStreamingReply's fallback
        // call relies on that to keep replyInProgress set for this reply's
        // full audible duration (see replyInProgress's declaration below) --
        // without it, `await speakReply(...)` there returns as soon as
        // synthesis/decoding finishes, well before the audio stops playing.
        await new Promise((resolve) => {
          const src = audioCtx.createBufferSource();
          src.buffer = buf;
          src.connect(audioCtx.destination);
          // Reply-scoped barge-in tracking (see playDecodedChunk/Finding 3):
          // this is the fallback path (queue.run()'s streamed draft turned out
          // stale), which plays through its own AudioContext/source outside
          // playDecodedChunk, but shares the same currentChunkSource variable
          // and watchForBargeIn() so it isn't left unmonitored.
          currentChunkSource = src;
          src.onended = () => {
            if (currentChunkSource === src) currentChunkSource = null;
            stopLipSync();
            setSprite('idle');
            audioCtx.close().catch(() => {}); // Finding 6: don't leak AudioContexts
            resolve();
          };
          src.start();
          startLipSync(audioCtx, src);
          if (bargeInEnabled()) {
            const playbackTokenAtStart = desktopReplyPlaybackToken;
            watchForBargeIn(
              () => currentChunkSource !== null && desktopReplyPlaybackToken === playbackTokenAtStart,
              () => {
                if (currentChunkSource) currentChunkSource.stop();
                stopStreamingReply();
                handleDesktopBargeInTrigger().catch((e) =>
                  console.warn('Barge-in interruption handling failed:', e.message),
                );
              },
            ).catch((e) => console.warn('Voice barge-in monitor failed:', e.message));
          }
        });
      } else {
        setSprite('idle');
      }
    } catch (e) {
      setSprite('idle');
    }
  }

  // --- Issue #331: streaming TTS pipeline -------------------------------
  // POST /reply/stream sends newline-delimited JSON objects over a chunked
  // response -- one {"type":"sentence","text":...} event per completed
  // sentence, then exactly one {"type":"final",...} event. Ported from
  // windows-launcher/renderer/renderer.js's Task 4 implementation (same
  // event shapes, same cancel-on-changed queue discipline -- see
  // createStreamingChunkQueue/cancelPending there), adapted to this app's
  // AudioContext/AudioBufferSourceNode playback instead of <audio> blobs.

  async function* readNdjsonEvents(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch (e) {
          // A malformed line costs one event, not the whole stream.
        }
      }
    }
  }

  // A BufferSourceNode's start() can only be called once ever, so a fresh
  // node is created per chunk (same one-shot constraint speakReply's
  // existing playback already works within, just repeated per chunk here
  // instead of once per whole reply).
  async function synthesizeAndDecodeChunk(text, audioCtx) {
    const response = await fetch('http://127.0.0.1:5005/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error('synthesize failed: ' + response.status);
    const arrayBuffer = await response.arrayBuffer();
    return audioCtx.decodeAudioData(arrayBuffer);
  }

  let bargeInMonitor = null;

  // Sub-project B: the streaming-chunk-queue currently backing playback, so
  // a barge-in trigger can read its not-yet-played sentences. Set at the
  // start of speakStreamingReply, cleared once that call's queue has
  // genuinely drained or been superseded.
  let activeStreamingQueue = null;

  // { sentences: string[], stackDepth: 0|1 } while a reply is held mid-
  // playback after a barge-in, else null.
  let heldReply = null;

  // Count of barge-in-triggered captures currently in flight (recording the
  // interruption through classifying and acting on it) -- listenLoop must
  // not start its own recording while this is > 0, since `replyInProgress`
  // alone isn't reliably still true for that whole span (it flips false as
  // soon as speakStreamingReply's now-superseded queue finishes unwinding,
  // which can happen well before the interruption has finished being
  // captured). A counter rather than a boolean: a nested interruption (see
  // handleDesktopBargeInTrigger's wasNested branch) starts a second capture
  // while the first is still winding down its own `handleTranscriptText`
  // await, so two captures' windows can overlap -- a boolean would get set
  // back to false by whichever one finishes first, letting listenLoop start
  // a third, racing recording while the other capture is still in flight.
  let bargeInCaptureCount = 0;

  // Ported from windows-launcher's watchForBargeIn(): while a reply chunk is
  // playing, polls the mic VAD and stops playback once speech has been
  // continuously detected for BARGE_IN_HOLD_MS (so one cough/tap doesn't
  // trigger it). Stop-and-discard only -- no hold/resume, matching today's
  // shipped windows-launcher behavior. `isStillPlaying` stands in for that
  // app's `currentReplyAudio` truthiness check, adapted to this app's
  // token-based playback-supersession pattern (desktopReplyPlaybackToken).
  // `onTrigger` is the actual stop action -- windows-launcher's
  // stopReplyAudio() both pauses the live element AND advances its token in
  // one call, so this takes a caller-supplied callback rather than
  // hardcoding stopStreamingReply() here, letting playDecodedChunk stop its
  // own live AudioBufferSourceNode (immediate, audible cutoff) instead of
  // only marking the reply superseded and letting the current chunk play out.
  async function watchForBargeIn(isStillPlaying, onTrigger) {
    if (bargeInMonitor) {
      return;
    }
    const self = { stopped: false };
    bargeInMonitor = self;

    try {
      await ensureMediaStream();
      const vad = getSileroVad();
      if (!vad) {
        return;
      }
      vad.reset();

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: VAD_SAMPLE_RATE,
      });
      const source = audioCtx.createMediaStreamSource(mediaStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);

      let speechStartedAt = null;
      try {
        while (!self.stopped && isStillPlaying()) {
          await wait(BARGE_IN_POLL_MS);
          if (self.stopped || !isStillPlaying()) {
            break;
          }

          let isSpeech = false;
          try {
            analyser.getFloatTimeDomainData(samples);
            const frame = samples.subarray(samples.length - VAD_FRAME_SAMPLES);
            const probability = await vad.processFrame(frame);
            isSpeech = vad.isSpeech(probability);
          } catch (e) {
            isSpeech = false;
          }

          const isLoudEnough = dbfsFromSamples(samples) >= BARGE_IN_MIN_DBFS;

          const state = nextBargeInState({
            isSpeech,
            isLoudEnough,
            speechStartedAt,
            now: performance.now(),
            holdMs: BARGE_IN_HOLD_MS,
          });
          speechStartedAt = state.speechStartedAt;
          if (state.triggered) {
            onTrigger();
            break;
          }
        }
      } finally {
        try {
          source.disconnect();
        } catch (e) {}
        audioCtx.close().catch(() => {});
      }
    } finally {
      bargeInMonitor = null;
    }
  }

  // Tracks the AudioBufferSourceNode currently playing, across ALL chunks of
  // the current reply (not just one) -- reply-scoped, not chunk-scoped.
  // Issue #331 review (Finding 3): a chunk-scoped liveness flag broke
  // monitoring on chunk boundaries -- the streaming-chunk-queue starts the
  // next chunk in the same microtask the previous one's onended fires in,
  // but the *old* watchForBargeIn() call wouldn't notice its chunk had ended
  // until its next ~50ms poll tick, so it held the bargeInMonitor singleton
  // and the new chunk's watchForBargeIn() call silently no-op'd. Matching
  // windows-launcher's actual design (one monitor spans the whole reply, via
  // its single currentReplyAudio), each chunk's playDecodedChunk call (and
  // speakReply's fallback) just reassigns this variable rather than using a
  // per-call flag, so isStillPlaying() stays true across the boundary and
  // the same monitor instance keeps running instead of restarting. Cleared
  // only if it's still the same node that's ending (`onended` guard below),
  // so a stale callback from a superseded node can't wipe out a newer one.
  let currentChunkSource = null;

  function playDecodedChunk(audioCtx, audioBuffer, text) {
    return new Promise((resolve) => {
      setSprite('speaking');
      if (live2dAvatar) live2dAvatar.setState(detectReplyEmotion(text));
      const src = audioCtx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(audioCtx.destination);
      currentChunkSource = src;
      src.onended = () => {
        if (currentChunkSource === src) currentChunkSource = null;
        stopLipSync();
        resolve();
      };
      src.start();
      startLipSync(audioCtx, src);
      if (bargeInEnabled()) {
        const playbackTokenAtStart = desktopReplyPlaybackToken;
        watchForBargeIn(
          () => currentChunkSource !== null && desktopReplyPlaybackToken === playbackTokenAtStart,
          // Stops whichever chunk is actually live when the trigger fires --
          // by the time it does, that may be a later chunk than the one
          // that started this monitor (see currentChunkSource comment
          // above). src.stop() on an already-started node is valid and
          // fires onended exactly once (whether triggered here or by
          // natural completion), so there's no double-resolve risk to guard
          // against here (unlike windows-launcher's <audio> element, which
          // has three distinct terminal events -- ended/error/pause -- and
          // needs waitForPlayback's `settled` guard for that reason).
          () => {
            if (currentChunkSource) currentChunkSource.stop();
            stopStreamingReply();
            handleDesktopBargeInTrigger().catch((e) =>
              console.warn('Barge-in interruption handling failed:', e.message),
            );
          },
        ).catch((e) => console.warn('Voice barge-in monitor failed:', e.message));
      }
    });
  }

  let desktopReplyPlaybackToken = 0;
  // Set for the full duration of speakStreamingReply -- the /reply/stream
  // fetch, every streamed chunk's synthesis/playback, and (if the streamed
  // draft turned out stale) the speakReply fallback it awaits before
  // returning. listenLoop's gate below reads this to avoid starting a new
  // recording while Mana is still talking, e.g. if push-to-talk is used
  // while continuous listening is also toggled on.
  let replyInProgress = false;

  function stopStreamingReply() {
    desktopReplyPlaybackToken += 1;
  }

  // Sub-project B: re-speaks a held reply's remaining sentences from the cut
  // point, reusing the same one-ahead synthesize/play queue
  // speakStreamingReply uses -- not a new playback primitive, just a second
  // entry point into it, sourced from the held array instead of an NDJSON
  // stream. Held state is text only; this re-synthesizes rather than
  // replaying cached audio.
  async function resumeHeldReply() {
    const sentences = heldReply ? heldReply.sentences : null;
    heldReply = null;
    if (!sentences || sentences.length === 0) {
      return;
    }

    stopStreamingReply();
    const playbackToken = desktopReplyPlaybackToken;
    const audioCtx = new AudioContext();
    const queue = createDesktopStreamingChunkQueue({
      synthesize: (text) => synthesizeAndDecodeChunk(text, audioCtx),
      play: (audioBuffer, text) => playDecodedChunk(audioCtx, audioBuffer, text),
      isCurrent: () => desktopReplyPlaybackToken === playbackToken,
      onIdle: () => setSprite('idle'),
    });
    activeStreamingQueue = queue;
    const runPromise = queue.run();
    for (const sentence of sentences) {
      queue.pushChunk(sentence);
    }
    queue.markDone();
    try {
      await runPromise;
    } finally {
      // Matches speakStreamingReply's cleanup: always close the AudioContext
      // and clear activeStreamingQueue, even if runPromise rejects, so a
      // failed resume doesn't leak an AudioContext (Chromium caps concurrent
      // instances at ~6).
      audioCtx.close().catch(() => {});
      if (activeStreamingQueue === queue) {
        activeStreamingQueue = null;
      }
    }
  }

  async function classifyBargeInText(text) {
    try {
      const response = await fetch('http://127.0.0.1:5005/barge-in/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        return { category: 'unclassified' };
      }
      const data = await response.json();
      return { category: data.category || 'unclassified' };
    } catch (e) {
      console.warn('Barge-in classify request failed:', e.message);
      return { category: 'unclassified' };
    }
  }

  // Acts on a classified interruption against the currently-held reply.
  // `heldReply` must already be set (non-null) when this is called for the
  // non-nested path -- see handleDesktopBargeInTrigger.
  async function handleDesktopBargeInInterruption(category, transcript) {
    // Captured once up front: a nested interruption's own capture window can
    // overlap this one's `await handleTranscriptText` below (see
    // bargeInCaptureCount's doc comment) and replace the module-global
    // `heldReply` with a new hold before this call resumes -- comparing
    // identity against `hold` rather than re-reading the global lets this
    // dispatch stay correct regardless of that ordering.
    const hold = heldReply;

    if (category === 'amend') {
      // Same shape as correction (discard, no resume -- the amended reply
      // replaces what was being said, it doesn't supplement it), except the
      // transcript is wrapped so the model steers using the original reply
      // it already has in session history (see the design doc's Key Finding:
      // buildAssistantReply appends the full reply to session history before
      // /reply/stream's final event, well before any barge-in can fire).
      heldReply = null;
      if (transcript) {
        // Kept parenthesis-free to match windows-launcher's wrapper exactly
        // (its cleanTranscriptText() would strip a "(...)"-wrapped prefix
        // entirely -- this app doesn't have that stripping, but the wording
        // is kept identical across both apps for parity).
        await handleTranscriptText(`Amending what you just said: ${transcript}`);
      }
      return;
    }

    if (category === 'correction') {
      heldReply = null;
      if (transcript) {
        await handleTranscriptText(transcript);
      }
      return;
    }

    if (category === 'new_question') {
      hold.stackDepth = 1;
      if (transcript) {
        // handleTranscriptText -> speakStreamingReply already awaits full
        // playback of the inserted answer before returning, so resuming
        // right after is safe -- no separate "wait for playback to finish"
        // step needed.
        await handleTranscriptText(transcript);
      }
      // A nested interruption during the line above discards heldReply
      // itself (see handleDesktopBargeInTrigger's wasNested branch) -- only
      // resume if it's still the same hold.
      if (heldReply === hold) {
        await resumeHeldReply();
      }
      return;
    }

    // backchannel or unclassified: resume from the cut point, no new turn.
    await resumeHeldReply();
  }

  // Fired from watchForBargeIn's onTrigger once a trigger holds for
  // BARGE_IN_HOLD_MS (the caller has already stopped the audible playback by
  // this point -- see playDecodedChunk/speakReply's watchForBargeIn call
  // sites). Captures the current reply's not-yet-played sentences, records
  // the interruption immediately, transcribes and classifies it, then
  // dispatches to resume/discard/insert.
  async function handleDesktopBargeInTrigger() {
    const wasNested = Boolean(heldReply && heldReply.stackDepth >= 1);
    const heldSentences = activeStreamingQueue ? activeStreamingQueue.peekPending() : [];

    if (wasNested) {
      // A second interruption arrived while an inserted new-question answer
      // was playing -- per the depth-1 cap, the outer held reply is
      // discarded outright (not stacked); this interruption becomes a fresh
      // top-level turn, no classification needed since there's nothing left
      // to resume/discard against.
      heldReply = null;
      bargeInCaptureCount += 1;
      try {
        const blob = await recordUntilSilence({ isBargeInCapture: true });
        if (!blob) return;
        const transcript = await transcribeBlob(blob);
        if (transcript) {
          await handleTranscriptText(transcript);
        }
      } catch (e) {
        console.warn('Barge-in interruption capture failed:', e.message);
      } finally {
        bargeInCaptureCount -= 1;
      }
      return;
    }

    if (heldSentences.length === 0) {
      // Nothing left to hold -- equivalent to today's stop-and-discard; the
      // normal listen loop picks up whatever comes next.
      return;
    }

    heldReply = { sentences: heldSentences, stackDepth: 0 };
    bargeInCaptureCount += 1;
    try {
      const blob = await recordUntilSilence({ isBargeInCapture: true });
      if (!blob) {
        await resumeHeldReply();
        return;
      }
      const transcript = await transcribeBlob(blob);
      const { category } = await classifyBargeInText(transcript);
      await handleDesktopBargeInInterruption(category, transcript);
    } catch (e) {
      console.warn('Barge-in interruption capture failed:', e.message);
      heldReply = null;
    } finally {
      bargeInCaptureCount -= 1;
    }
  }

  // Replaces the fetch('/reply') -> res.json() -> speakReply flow at this
  // app's two reply call sites. Sentences arrive incrementally from POST
  // /reply/stream and are queued for TTS/playback as they arrive; on the
  // final event, if what was already streamed doesn't match the true final
  // reply (changed:true -- covers both "nothing streamed" and a
  // regeneration pass rewriting it), drop whatever's still queued but not
  // yet in flight and fall back to speakReply's synthesize-the-whole-thing-
  // at-once path once the in-flight chunk (if any) has finished.
  //
  // onFinal(finalEvent), if given, fires the instant the final NDJSON event
  // is read -- well before playback finishes, since that event arrives
  // before queue.markDone()/runPromise below even start winding down. Issue
  // #331 review (Finding 1): callers use this to append the reply text to
  // the chat log as soon as it's known, instead of waiting for this whole
  // function (and therefore all queued audio) to finish playing first.
  async function speakStreamingReply(requestBody, onFinal) {
    replyInProgress = true;
    try {
      stopStreamingReply();
      const playbackToken = desktopReplyPlaybackToken;
      const audioCtx = new AudioContext();
      const queue = createDesktopStreamingChunkQueue({
        synthesize: (text) => synthesizeAndDecodeChunk(text, audioCtx),
        play: (audioBuffer, text) => playDecodedChunk(audioCtx, audioBuffer, text),
        isCurrent: () => desktopReplyPlaybackToken === playbackToken,
        onIdle: () => setSprite('idle'),
      });
      activeStreamingQueue = queue;
      const runPromise = queue.run();

      let finalEvent = null;
      try {
        const response = await fetch('http://127.0.0.1:5005/reply/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        for await (const event of readNdjsonEvents(response)) {
          if (event.type === 'sentence') {
            queue.pushChunk(event.text);
          } else if (event.type === 'final') {
            finalEvent = event;
            if (typeof onFinal === 'function') {
              onFinal(finalEvent);
            }
            if (event.changed) {
              // Known now, as early as the final event itself arrives (always
              // after every sentence event, so this can't miss a pending
              // chunk) -- drop the rest of the backlog instead of letting the
              // whole stale draft play out before restarting.
              queue.cancelPending();
            }
          }
        }
      } finally {
        queue.markDone();
        await runPromise;
        if (activeStreamingQueue === queue) {
          activeStreamingQueue = null;
        }
      }

      // Finding 6: this reply's audio queue has fully drained (every
      // streamed chunk synthesized/played) -- this AudioContext is done
      // being used, whether or not the speakReply fallback below runs next
      // (that one creates and closes its own). Chromium caps concurrent
      // AudioContext instances (~6); never closing these would eventually
      // wedge voice output in a long continuous-listening session.
      audioCtx.close().catch(() => {});

      const result = finalEvent || { reply: '', ttsConfigured: false };

      if (desktopReplyPlaybackToken === playbackToken && result.changed && result.reply) {
        stopStreamingReply();
        await speakReply(result.reply, result.expression);
      }

      return result;
    } finally {
      replyInProgress = false;
    }
  }

  async function init() {
    try {
      const st = await window.electronAPI.backendStatus();
      statusEl.textContent = st.running ? 'Backend running' : 'Backend not running';
      if (!st.running) startLoadingAnimation();
    } catch (e) { statusEl.textContent = 'Backend unknown'; startLoadingAnimation(); }

    // backend logs: append and use first log to stop loading animation
    window.electronAPI.backendLog((s)=>{ logsEl.textContent += s + '\n'; logsEl.scrollTop = logsEl.scrollHeight; stopLoadingAnimation();
      // also detect excite marker
      try{ if (String(s).includes('__MANA_EXCITE__')) setSprite('excited'); }catch(e){}
    });

    window.electronAPI.backendExit((info)=>{ statusEl.textContent = 'Backend exited'; startLoadingAnimation(); });

    initLive2dAvatar();
    // Finding 2: awaited so getUserMedia() has resolved and `mediaStream` is
    // set before the autostart check below can call startListening() -->
    // listenLoop() --> recordUntilSilence() --> ensureMediaStream(). Without
    // this, ensureMediaStream() could see mediaStream still null and open a
    // second, orphaned MediaStream (duplicate device capture, and
    // push-to-talk possibly ending up bound to a different stream than the
    // listen loop).
    await setupRecording();
    if (localStorage.getItem(LISTENING_AUTOSTART_STORAGE_KEY) === '1') {
      startListening();
    }
  }

  // Live2D speaks a richer state vocabulary (idle/talking/excited/angry/
  // sad/disgusted) than the simple state names used elsewhere in this file
  // (idle/listening/speaking/excited); this maps those onto the closest
  // Live2D one for the generic (non-reply) cases. A reply's actual detected
  // emotion (see onRecordingStop) overrides this afterward.
  function live2dStateFor(spriteState){
    if (spriteState === 'listening' || spriteState === 'speaking') return 'talking';
    return spriteState || 'idle';
  }

  async function initLive2dAvatar(){
    if (!live2dCanvas) return;
    try {
      live2dAvatar = await createLive2dAvatar({
        canvas: live2dCanvas,
        width: live2dCanvas.clientWidth,
        height: live2dCanvas.clientHeight,
      });
      if (live2dAvatar) {
        live2dAvatar.setState(live2dStateFor(_prevSpriteState));
      }
    } catch (e) {
      console.warn('Live2D avatar failed to load:', e);
    }
  }

  if (avatarZoomBtn) {
    avatarZoomBtn.addEventListener('click', () => { if (live2dAvatar) live2dAvatar.cycleZoom(); });
  }
  if (avatarNoticeLink) {
    avatarNoticeLink.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await window.electronAPI.openAvatarNotice(); } catch (err) { window.open('../AVATAR_NOTICE.md', '_blank'); }
    });
  }

  let _prevSpriteState = 'idle';
  function setSprite(state){
    // handle transient excited state, which should revert to the underlying
    // state (idle/speaking) after a beat
    if (state === 'excited'){
      const base = _prevSpriteState || 'idle';
      if (live2dAvatar) live2dAvatar.setState('excited');
      const durationMs = 320;
      const iterations = 5;
      setTimeout(()=>{
        if (live2dAvatar) live2dAvatar.setState(live2dStateFor(base));
      }, durationMs * iterations);
      return;
    }
    _prevSpriteState = state || 'idle';
    if (live2dAvatar) live2dAvatar.setState(live2dStateFor(_prevSpriteState));
  }

  function startLoadingAnimation(){
    statusEl.textContent = 'Backend starting...';
  }
  function stopLoadingAnimation(){
    statusEl.textContent = 'Backend running';
  }

  // Lip sync: sample the playing reply audio's RMS amplitude and forward it
  // to the Live2D avatar's mouth parameter. No-op when Live2D isn't loaded.
  let lipSyncRafId = null;
  function stopLipSync(){
    if (lipSyncRafId !== null) {
      cancelAnimationFrame(lipSyncRafId);
      lipSyncRafId = null;
    }
    if (live2dAvatar) live2dAvatar.setMouthTarget(0, 0);
  }
  function startLipSync(audioCtx, sourceNode){
    if (!live2dAvatar) return;
    try {
      const { spectralCentroidHz, computeMfcc, classifyViseme } = window.Live2DLogic;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      sourceNode.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      // Frequency-domain read alongside the time-domain one above, used
      // only for a spectral-centroid estimate (mouth *shape*) -- no extra
      // audio graph, just a second read of the same analyser.
      const magnitudesDb = new Float32Array(analyser.frequencyBinCount);
      let lastSentAt = 0;
      const tick = (timestamp) => {
        // ~30Hz is plenty for mouth movement.
        if (timestamp - lastSentAt >= 33) {
          lastSentAt = timestamp;
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (let i = 0; i < samples.length; i += 1) {
            sum += samples[i] * samples[i];
          }
          const rms = Math.sqrt(sum / samples.length);
          analyser.getFloatFrequencyData(magnitudesDb);
          const centroidHz = spectralCentroidHz(magnitudesDb, audioCtx.sampleRate, analyser.fftSize);
          // Issue #275: MFCC-based viseme classification, computed
          // alongside (not instead of) the older centroid -- see
          // live2d-avatar.js's setMouthTarget for the fallback order.
          const viseme = classifyViseme(computeMfcc(magnitudesDb, audioCtx.sampleRate, analyser.fftSize));
          live2dAvatar.setMouthTarget(rms, centroidHz, viseme);
        }
        lipSyncRafId = requestAnimationFrame(tick);
      };
      lipSyncRafId = requestAnimationFrame(tick);
    } catch (e) {
      // Lip sync is a nicety; never let it break audio playback.
      console.warn('Lip sync failed to start:', e);
    }
  }

  async function setupRecording(){
    try{
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }catch(e){
      console.error('mic failed', e);
      await window.electronAPI.showError('Microphone access is required');
      return;
    }

    const btn = document.getElementById('btnRecord');
    const stopBtn = document.getElementById('btnStop');
    const clearBtn = document.getElementById('btnClear');

    btn.addEventListener('mousedown', startRecording);
    btn.addEventListener('touchstart', startRecording);
    btn.addEventListener('mouseup', stopRecording);
    btn.addEventListener('touchend', stopRecording);
    stopBtn.addEventListener('click', stopRecording);
    clearBtn.addEventListener('click', ()=>{ clearMessages(); });
  }

  function startRecording(){
    if (!mediaStream) return;
    chunks = [];
    recorder = new MediaRecorder(mediaStream);
    recorder.ondataavailable = (e)=>{ if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = onRecordingStop;
    recorder.start();
    setSprite('listening');
    statusEl.textContent = 'Listening...';
  }

  async function stopRecording(){
    try{ if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch(e){}
    setSprite('idle');
    statusEl.textContent = 'Processing...';
  }

  // Issue #331: transcription and reply generation are now two calls
  // instead of one -- /transcribe-only has no streaming equivalent (it's a
  // plain multipart upload), so it just gets the transcript; the reply
  // itself goes through /reply/stream (via speakStreamingReply) the same
  // way sendTextMessage's does, so voice replies get the same
  // early-audio-start pipelining as typed ones.
  async function transcribeBlob(blob) {
    const form = new FormData();
    form.append('file', blob, 'voice.webm');
    const resp = await fetch('http://127.0.0.1:5005/transcribe-only', { method: 'POST', body: form });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error('transcribe failed: ' + resp.status + ' ' + txt);
    }
    const j = await resp.json().catch(()=>null);
    return j?.transcript || '';
  }

  // Shared by handleVoiceTurn (push-to-talk/continuous-listening) and the
  // barge-in interruption dispatcher (Sub-project B) -- both end up with a
  // known transcript string and need the exact same reply-generation
  // handling.
  async function handleTranscriptText(transcript) {
    try{
      appendMessage('user', transcript);
      // Issue #331 review (Finding 1): append to the chat log as soon as
      // the final event names the reply, not after speakStreamingReply
      // resolves -- that await also waits for every queued chunk to
      // finish *playing*.
      const result = await speakStreamingReply(
        {
          text: transcript,
          sessionId: ensureSessionId(),
          presetId: selectedPresetId || undefined,
        },
        (finalEvent) => {
          if (!finalEvent.error && finalEvent.reply) appendMessage('assistant', finalEvent.reply);
        },
      );
      if (result.error) throw new Error(result.error);
      statusEl.textContent = 'Idle';
    } catch (e){
      statusEl.textContent = 'Error';
      await window.electronAPI.showError(String(e));
      setSprite('idle');
    }
  }

  // Shared by push-to-talk (onRecordingStop) and continuous listening
  // (listenLoop) -- both produce a recorded utterance as a Blob and need
  // the exact same transcribe-then-reply handling.
  async function handleVoiceTurn(blob) {
    try {
      const transcript = await transcribeBlob(blob);
      // Issue #331 review (Finding 1): only act on a genuinely non-empty
      // transcript. /transcribe-only returning nothing meaningful (empty
      // string, or no transcript at all) must not reach the chat log or
      // trigger a reply -- previously the else branch appended a raw
      // JSON.stringify(j) debug bubble for this case, which continuous
      // listening's no-speech recordings would otherwise hit constantly.
      if (transcript) {
        await handleTranscriptText(transcript);
      }
    } catch (e){
      statusEl.textContent = 'Error';
      await window.electronAPI.showError(String(e));
      setSprite('idle');
    }
  }

  async function onRecordingStop(){
    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    await handleVoiceTurn(blob);
  }

  // Continuous listening (issue #135 port): records one utterance at a
  // time, using Silero VAD (falling back to a plain RMS threshold if the
  // model failed to load) to detect when the user has stopped talking,
  // instead of requiring a held-down button. Uses local recorder/chunks
  // variables rather than the module-scope ones startRecording/stopRecording
  // use above -- push-to-talk and continuous listening must not share
  // mutable state, since a user could in principle trigger both at once.
  async function recordUntilSilence({
    maxWaitForSpeechMs = MAX_WAIT_FOR_SPEECH_MS,
    silenceBufferMs = SILENCE_BUFFER_MS,
    maxDurationMs = MAX_UTTERANCE_MS,
    // True only for the specific recordUntilSilence() call that IS a
    // barge-in's own capture (see handleDesktopBargeInTrigger) -- must not
    // be inferred from module-scope bargeInCaptureCount > 0, which is true
    // while *any* capture is in flight anywhere and would also bypass
    // Finding 4 for an unrelated, already-running listenLoop recording.
    isBargeInCapture = false,
  } = {}) {
    await ensureMediaStream();

    const vad = getSileroVad();
    if (vad) {
      vad.reset();
    }

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: VAD_SAMPLE_RATE,
    });
    const source = audioCtx.createMediaStreamSource(mediaStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    function currentRms() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        sum += samples[i] * samples[i];
      }
      return Math.sqrt(sum / samples.length);
    }

    async function isSpeechNow() {
      if (vad) {
        try {
          analyser.getFloatTimeDomainData(samples);
          const frame = samples.subarray(samples.length - VAD_FRAME_SAMPLES);
          const probability = await vad.processFrame(frame);
          return vad.isSpeech(probability);
        } catch (e) {
          console.warn('Silero VAD inference failed, falling back to RMS for this session:', e);
          sileroVadLoadFailed = true;
        }
      }
      return currentRms() >= MIN_SPEECH_RMS;
    }

    // Issue #331 review (Finding 1): resolves null instead of a Blob when
    // there's no real utterance to hand off -- either nobody spoke at all
    // (no-speech-timeout) or a reply started elsewhere mid-recording
    // (Finding 4, see the replyInProgress check in tick() below) and
    // whatever got captured is stale/possibly Mana's own TTS audio picked
    // up by the mic. Callers (listenLoop) must skip handleVoiceTurn for a
    // null result instead of transcribing it.
    return await new Promise((resolve, reject) => {
      const localChunks = [];
      const localRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' });
      let hasHeardSpeech = false;
      let lastSpeechAt = 0;
      let meterTimer = null;
      let partialTimer = null;
      let partialPollInFlight = false;
      // Plumbing for #341 Sub-project B's classifier, not yet consumed by
      // anything -- kept in sync with the status text below.
      let partialTranscript = "";
      // Aborted in cleanup() so an in-flight poll doesn't keep running
      // (and competing for CPU with the real final transcription about to
      // start) after the recording it was polling for has already ended.
      const partialAbortController = new AbortController();
      let stopped = false;
      let noSpeechResult = false;
      const startedAt = performance.now();

      function cleanup() {
        stopped = true;
        if (meterTimer !== null) {
          clearTimeout(meterTimer);
          meterTimer = null;
        }
        if (partialTimer !== null) {
          clearInterval(partialTimer);
          partialTimer = null;
        }
        partialAbortController.abort();
        try {
          source.disconnect();
        } catch (e) {}
        audioCtx.close().catch(() => {});
      }

      // #341 Sub-project A: snapshots whatever's been recorded so far and
      // polls for a partial transcript, updating the live status text. A
      // failed or slow poll is silently skipped -- never blocks or delays
      // tick()'s actual stop-detection logic below.
      async function pollPartialTranscript() {
        if (stopped || partialPollInFlight || localChunks.length === 0) {
          return;
        }
        partialPollInFlight = true;
        try {
          const snapshot = new Blob(localChunks, { type: 'audio/webm' });
          const form = new FormData();
          form.append('file', snapshot, 'partial.webm');
          const response = await fetch('http://127.0.0.1:5005/transcribe-partial', {
            method: 'POST',
            body: form,
            signal: partialAbortController.signal,
          });
          if (!response.ok || stopped) {
            return;
          }
          const data = await response.json();
          if (data.transcript && !stopped) {
            partialTranscript = data.transcript;
            statusEl.textContent = `Hearing: "${data.transcript}"`;
          }
        } catch (e) {
          if (e.name !== 'AbortError') {
            console.warn('Partial transcript poll failed:', e.message);
          }
        } finally {
          partialPollInFlight = false;
        }
      }

      localRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          localChunks.push(event.data);
        }
      };
      localRecorder.onerror = (event) => {
        cleanup();
        reject(event.error);
      };
      localRecorder.onstop = () => {
        cleanup();
        resolve(noSpeechResult ? null : new Blob(localChunks, { type: 'audio/webm' }));
      };

      localRecorder.start(SILENCE_METER_INTERVAL_MS);
      partialTimer = setInterval(pollPartialTranscript, PARTIAL_TRANSCRIPT_POLL_MS);

      async function tick() {
        if (stopped) return;

        // Finding 4: a reply started via another path (typing/push-to-talk)
        // while this recording was already in progress -- stop now rather
        // than let the VAD keep picking up Mana's own TTS audio as "speech"
        // for up to MAX_UTTERANCE_MS, then submit that as the user's turn.
        // This must not abort our *own* barge-in capture, though -- only an
        // *unrelated* reply starting elsewhere mid-recording should trigger
        // it. replyInProgress can stay true for a few ticks after
        // stopStreamingReply() while speakStreamingReply's now-superseded
        // queue is still winding down, so isBargeInCapture (set only on the
        // barge-in's own recordUntilSilence() call, not module-scope) gates
        // this to genuinely unrelated replies -- a module-scope check here
        // would also bypass Finding 4 for any other, unrelated
        // recordUntilSilence() call (e.g. listenLoop's own) that happens to
        // be running while a barge-in capture is in flight elsewhere.
        if (replyInProgress && !isBargeInCapture) {
          noSpeechResult = true;
          if (localRecorder.state !== 'inactive') {
            localRecorder.stop();
          }
          return;
        }

        if (await isSpeechNow()) {
          if (!hasHeardSpeech) {
            statusEl.textContent = 'Listening...';
          }
          hasHeardSpeech = true;
          lastSpeechAt = performance.now();
        }
        if (stopped) return;

        const stopReason = shouldStopRecording({
          hasHeardSpeech,
          elapsedMs: performance.now() - startedAt,
          msSinceLastSpeech: hasHeardSpeech ? performance.now() - lastSpeechAt : 0,
          maxWaitForSpeechMs,
          silenceBufferMs,
          maxDurationMs,
        });
        if (stopReason) {
          if (stopReason === 'no-speech-timeout') {
            noSpeechResult = true;
          }
          if (localRecorder.state !== 'inactive') {
            localRecorder.stop();
          }
          return;
        }
        meterTimer = setTimeout(tick, SILENCE_METER_INTERVAL_MS);
      }
      meterTimer = setTimeout(tick, SILENCE_METER_INTERVAL_MS);
    });
  }

  // Issue #331 review (Finding 7): a loop-generation counter so a rapid
  // Stop -> Start click can't leave two listenLoop()s running at once.
  // stopListening() sets `listening = false` but can't interrupt an
  // in-flight recordUntilSilence() call (up to MAX_UTTERANCE_MS = 20s); if
  // the user re-enables listening inside that window, startListening()'s
  // `if (listening) return;` guard alone would pass (listening is false
  // again by then) and start a second loop while the first one's pending
  // recordUntilSilence() is still going to resume its own iteration once it
  // resolves. Each startListening() call mints a new generation, and a
  // loop only keeps iterating while it's still holding the current one.
  let listenGeneration = 0;

  async function listenLoop(myGeneration) {
    while (listening && listenGeneration === myGeneration) {
      // replyInProgress is set for the full duration of speakStreamingReply
      // (see its declaration above) -- covers both push-to-talk's and this
      // loop's own reply, so two recordings can never overlap a reply.
      // bargeInCaptureCount catches the gap between a barge-in stopping
      // playback (replyInProgress can flip false within a few ticks) and
      // that interruption's own capture/classify/dispatch actually finishing
      // -- see its declaration above.
      if (replyInProgress || bargeInCaptureCount > 0) {
        await wait(LISTEN_PAUSE_MS);
        continue;
      }
      try {
        statusEl.textContent = 'Waiting for you...';
        const blob = await recordUntilSilence();
        if (!listening || listenGeneration !== myGeneration) break;
        if (!blob) continue; // Finding 1: nothing was actually said -- don't transcribe/display it
        await handleVoiceTurn(blob);
      } catch (error) {
        console.error(error);
        statusEl.textContent = `Listening error: ${error.message}`;
        await wait(1500);
      }
    }
  }

  function startListening() {
    if (listening) return;
    listening = true;
    const myGeneration = ++listenGeneration;
    const btn = document.getElementById('btnListen');
    if (btn) {
      btn.textContent = 'Stop Listening';
      btn.classList.add('active');
    }
    listenLoop(myGeneration);
  }

  function stopListening() {
    listening = false;
    heldReply = null;
    const btn = document.getElementById('btnListen');
    if (btn) {
      btn.textContent = 'Start Listening';
      btn.classList.remove('active');
    }
    statusEl.textContent = 'Idle';
  }

  document.getElementById('btnListen')?.addEventListener('click', () => {
    if (listening) {
      stopListening();
    } else {
      startListening();
    }
  });

  // Deep research: reuses the single transcript/reply pair this UI already
  // has (no scrolling chat log here, unlike windows-launcher) -- the
  // question goes into #transcript, the cited report into #reply.
  function setResearchProgress(label){
    if (!researchProgressEl || !researchProgressLabelEl) return;
    if (!label) { researchProgressEl.hidden = true; return; }
    researchProgressEl.hidden = false;
    researchProgressLabelEl.textContent = label;
  }

  function formatResearchReply(result){
    const lines = [result.report, ''];
    if (result.sources.length) {
      lines.push('Sources:');
      for (const source of result.sources) {
        const suffix = source.readFailed ? " (couldn't be read; used search snippet)" : '';
        lines.push(`[${source.index}] ${source.title || source.url} - ${source.url}${suffix}`);
      }
    }
    if (result.subQueries && result.subQueries.length) {
      lines.push('');
      lines.push(`Searched: ${result.subQueries.join(' | ')}`);
    }
    if (result.bounds && (result.bounds.hitTimeLimit || result.bounds.hitSourceLimit)) {
      lines.push('');
      lines.push(
        `(Stopped early: ${result.bounds.sourcesUsed} of up to ${result.bounds.maxSources} sources read${
          result.bounds.hitTimeLimit ? `, ${Math.round(result.bounds.elapsedMs / 1000)}s time budget reached` : ''
        }.)`,
      );
    }
    return lines.join('\n');
  }

  async function pollResearchJob(jobId){
    for (;;) {
      const response = await fetch(`http://127.0.0.1:5005/research/${jobId}`);
      if (!response.ok) {
        throw new Error(`Research status check failed (${response.status})`);
      }
      const job = await response.json();
      if (job.status === 'done') return job.result;
      if (job.status === 'cancelled') {
        const cancelled = new Error('Research cancelled.');
        cancelled.cancelled = true;
        throw cancelled;
      }
      if (job.status === 'error') {
        throw new Error(job.error || 'Deep research failed');
      }
      setResearchProgress(job.progress?.label || 'Researching...');
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  async function startDeepResearch(){
    if (deepResearchRunning || !messageInputEl) return;
    const question = messageInputEl.value.trim();
    if (!question) return;
    messageInputEl.value = '';
    deepResearchRunning = true;
    btnResearchEl?.classList.add('active');
    appendMessage('user', question);
    setResearchProgress('Starting research...');

    try {
      const startResponse = await fetch('http://127.0.0.1:5005/research/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, sessionId: ensureSessionId() }),
      });
      if (!startResponse.ok) {
        const detail = await startResponse.text();
        throw new Error(detail || `Failed to start research (${startResponse.status})`);
      }
      const { jobId } = await startResponse.json();
      currentResearchJobId = jobId;
      const result = await pollResearchJob(jobId);
      appendMessage('assistant', formatResearchReply(result));
      setSprite('speaking');
      setTimeout(() => setSprite('idle'), 400);
    } catch (error) {
      if (error.cancelled) {
        appendMessage('assistant', 'Research cancelled.');
      } else {
        console.warn('Deep research failed:', error);
        appendMessage('assistant', `Research failed: ${error.message}`);
      }
    } finally {
      deepResearchRunning = false;
      currentResearchJobId = null;
      btnResearchEl?.classList.remove('active');
      setResearchProgress(null);
    }
  }

  btnResearchEl?.addEventListener('click', () => { startDeepResearch(); });

  researchCancelBtnEl?.addEventListener('click', async () => {
    if (!currentResearchJobId) return;
    setResearchProgress('Cancelling...');
    try {
      await fetch(`http://127.0.0.1:5005/research/${currentResearchJobId}/cancel`, { method: 'POST' });
    } catch (e) {
      console.warn('Failed to cancel research job:', e);
    }
  });

  // Nav: Home (live chat) / Sessions (saved chat list) / Settings. "Code" is
  // an existing unimplemented stub left as-is.
  function showView(view) {
    const isSettings = view === 'settings';
    const isSessions = view === 'sessions';
    const isHome = view === 'home';
    if (homeViewEl) homeViewEl.hidden = !isHome;
    if (settingsViewEl) settingsViewEl.hidden = !isSettings;
    if (sessionsViewEl) sessionsViewEl.hidden = !isSessions;
    navHomeBtnEl?.classList.toggle('active', isSessions);
    navSettingsBtnEl?.classList.toggle('active', isSettings);
  }
  navHomeBtnEl?.addEventListener('click', () => {
    showView('sessions');
    refreshSessionList();
  });
  navSettingsBtnEl?.addEventListener('click', () => showView('settings'));

  // Settings info-nav items (Avatar/Web access/Market watch/Vision/Model/
  // Doctor, under Settings > Status): each backend capability already
  // exists (see node-bot's web-access/sessions/ffxiv-market capabilities,
  // /doctor, /models/status, /vision/describe), so these just surface it
  // through one shared info panel rather than a bespoke view per item.
  const BACKEND_URL = 'http://127.0.0.1:5005';

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Doctor issue detail popover: cards show just the label, click one to
  // see the full message in a small bubble anchored to it. position:fixed
  // (see style.css) so it's placed relative to the viewport, not clipped
  // by navInfoBody's own overflow-y:auto scroll area.
  const doctorBubbleEl = document.getElementById('doctorBubble');
  const doctorBubbleTitleEl = doctorBubbleEl?.querySelector('.doctor-bubble-title');
  const doctorBubbleMessageEl = doctorBubbleEl?.querySelector('.doctor-bubble-message');
  function showDoctorBubble(issueBtn) {
    if (!doctorBubbleEl) return;
    doctorBubbleTitleEl.textContent = issueBtn.querySelector('strong')?.textContent || '';
    doctorBubbleMessageEl.textContent = issueBtn.dataset.doctorMessage || '';
    doctorBubbleEl.hidden = false;
    const rect = issueBtn.getBoundingClientRect();
    const bubbleRect = doctorBubbleEl.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - bubbleRect.width - 12);
    const fitsBelow = rect.bottom + 8 + bubbleRect.height <= window.innerHeight - 12;
    const top = fitsBelow ? rect.bottom + 8 : Math.max(12, rect.top - bubbleRect.height - 8);
    doctorBubbleEl.style.left = `${Math.max(12, left)}px`;
    doctorBubbleEl.style.top = `${top}px`;
  }
  function hideDoctorBubble() {
    if (doctorBubbleEl) doctorBubbleEl.hidden = true;
  }
  document.addEventListener('click', (e) => {
    if (!doctorBubbleEl || doctorBubbleEl.hidden) return;
    if (!doctorBubbleEl.contains(e.target) && !e.target.closest('.doctor-issue')) {
      hideDoctorBubble();
    }
  });

  function openNavInfo(title, bodyHtml) {
    hideDoctorBubble();
    navInfoTitleEl.textContent = title;
    navInfoBodyEl.innerHTML = bodyHtml;
    navInfoModalEl.setAttribute('aria-hidden', 'false');
  }
  function closeNavInfo() {
    navInfoModalEl.setAttribute('aria-hidden', 'true');
    hideDoctorBubble();
  }
  navInfoCloseBtnEl?.addEventListener('click', closeNavInfo);
  navInfoXBtnEl?.addEventListener('click', closeNavInfo);
  // Clicking the dimmed backdrop (not the panel itself) closes it too.
  navInfoModalEl?.addEventListener('click', (e) => {
    if (e.target === navInfoModalEl) closeNavInfo();
  });
  // Result links (Search) open in the real browser, not a new Electron window.
  navInfoBodyEl?.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-external]');
    if (a) { e.preventDefault(); window.electronAPI.openExternal(a.href); return; }
    const issueBtn = e.target.closest('.doctor-issue');
    if (issueBtn) showDoctorBubble(issueBtn);
    const restoreBtn = e.target.closest('.snapshot-restore-btn');
    if (restoreBtn) restoreEditSnapshotWithConfirm(restoreBtn.dataset.snapshotId, restoreBtn.dataset.snapshotPath);
  });

  async function fetchJson(url, options) {
    const resp = await fetch(url, options);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || `${resp.status} ${resp.statusText}`);
    return body;
  }

  navNewChatBtnEl?.addEventListener('click', () => { startNewChat(); });

  navAvatarBtnEl?.addEventListener('click', async () => {
    try { await window.electronAPI.openAvatarNotice(); } catch (e) {}
  });

  navSearchBtnEl?.addEventListener('click', () => {
    openNavInfo('Search the web', `
      <div class="info-row">
        <input type="text" id="webSearchInput" placeholder="Search the web..." />
        <button id="webSearchBtn" class="primary">Search</button>
        <div id="webSearchResults" class="info-results"></div>
      </div>
    `);
    const inputEl = document.getElementById('webSearchInput');
    const resultsEl = document.getElementById('webSearchResults');
    const runSearch = async () => {
      const query = inputEl.value.trim();
      if (!query) return;
      resultsEl.innerHTML = '<p class="subtitle">Searching...</p>';
      try {
        const j = await fetchJson(`${BACKEND_URL}/web/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, limit: 5 }),
        });
        resultsEl.innerHTML = (j.results || []).map((r) => `
          <div class="info-result">
            <a href="${escapeHtml(r.url)}" data-external class="r-title">${escapeHtml(r.title || r.url)}</a>
            <div class="r-url">${escapeHtml(r.url)}</div>
            <div class="r-snippet">${escapeHtml(r.snippet || '')}</div>
          </div>`).join('') || '<p class="subtitle">No results.</p>';
      } catch (e) {
        resultsEl.innerHTML = `<p class="subtitle">Search failed: ${escapeHtml(e.message)} (needs local SearXNG running)</p>`;
      }
    };
    document.getElementById('webSearchBtn').addEventListener('click', runSearch);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
    inputEl.focus();
  });

  navWebBtnEl?.addEventListener('click', async () => {
    openNavInfo('Web Access', '<p class="subtitle">Checking...</p>');
    try {
      const j = await fetchJson(`${BACKEND_URL}/health`);
      const w = j?.components?.webAccess;
      if (!w) { navInfoBodyEl.innerHTML = '<p class="subtitle">No web access status reported.</p>'; return; }
      navInfoBodyEl.innerHTML = `
        <div class="info-list-item"><span>Status</span><strong>${escapeHtml(w.status)}</strong></div>
        <p class="subtitle" style="margin-top:8px">${escapeHtml(w.message || '')}</p>
        ${w.searxngUrl ? `<p class="subtitle">SearXNG: ${escapeHtml(w.searxngUrl)}</p>` : ''}
      `;
    } catch (e) {
      navInfoBodyEl.innerHTML = `<p class="subtitle">Failed to reach backend: ${escapeHtml(e.message)}</p>`;
    }
  });

  navMarketBtnEl?.addEventListener('click', () => {
    openNavInfo('Market Watch (FFXIV)', `
      <div class="info-row">
        <input type="text" id="marketItemInput" placeholder="Item name (e.g. Ragstone Whetstone)" />
        <input type="text" id="marketWorldInput" placeholder="World (optional, e.g. Odin)" />
        <button id="marketSearchBtn" class="primary">Look up price</button>
        <div id="marketResults" class="info-results"></div>
      </div>
    `);
    document.getElementById('marketSearchBtn').addEventListener('click', async () => {
      const itemName = document.getElementById('marketItemInput').value.trim();
      const world = document.getElementById('marketWorldInput').value.trim();
      const resultsEl = document.getElementById('marketResults');
      if (!itemName) { resultsEl.innerHTML = '<p class="subtitle">Enter an item name.</p>'; return; }
      resultsEl.innerHTML = '<p class="subtitle">Looking up...</p>';
      try {
        const params = new URLSearchParams({ itemName });
        if (world) params.set('world', world);
        const j = await fetchJson(`${BACKEND_URL}/ffxiv/market?${params}`);
        const cheapest = (j.lowestListings || [])[0];
        resultsEl.innerHTML = `
          <div class="info-list-item"><span>${escapeHtml(j.itemName || itemName)}</span><strong>${escapeHtml(j.world || world || '')}</strong></div>
          ${cheapest ? `<div class="info-list-item"><span>Cheapest listing</span><strong>${cheapest.pricePerUnit.toLocaleString()} gil${cheapest.hq ? ' (HQ)' : ''}</strong></div>` : '<p class="subtitle">No active listings.</p>'}
          <pre class="box" style="white-space:pre-wrap;margin-top:8px">${escapeHtml(JSON.stringify(j, null, 2))}</pre>
        `;
      } catch (e) {
        resultsEl.innerHTML = `<p class="subtitle">Lookup failed: ${escapeHtml(e.message)}</p>`;
      }
    });
  });

  navVisionBtnEl?.addEventListener('click', () => {
    openNavInfo('Vision', `
      <div class="info-row">
        <input type="file" id="visionFileInput" accept="image/*" />
        <input type="text" id="visionPromptInput" placeholder="What should Mana look for? (optional)" />
        <button id="visionDescribeBtn" class="primary">Describe image</button>
        <div id="visionResult" class="subtitle"></div>
      </div>
    `);
    document.getElementById('visionDescribeBtn').addEventListener('click', async () => {
      const fileInput = document.getElementById('visionFileInput');
      const promptInput = document.getElementById('visionPromptInput');
      const resultEl = document.getElementById('visionResult');
      const file = fileInput.files?.[0];
      if (!file) { resultEl.textContent = 'Choose an image first.'; return; }
      resultEl.textContent = 'Looking...';
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const j = await fetchJson(`${BACKEND_URL}/vision/describe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl, prompt: promptInput.value || 'Describe this image.' }),
        });
        resultEl.textContent = j.reply || '(no reply)';
      } catch (e) {
        resultEl.textContent = 'Failed: ' + e.message + ' (needs a local vision GGUF model -- see docs/vision_setup.md)';
      }
    });
  });

  navModelBtnEl?.addEventListener('click', async () => {
    openNavInfo('Model', '<p class="subtitle">Checking...</p>');
    try {
      const j = await fetchJson(`${BACKEND_URL}/models/status`);
      const rows = Object.values(j.profiles || {}).map((p) => `
        <div class="info-list-item">
          <span>${escapeHtml(p.label || p.key)}${p.key === j.activeProfile ? ' (active)' : ''}</span>
          <strong>${p.available ? escapeHtml(p.selectedModel || '—') : 'not found'}</strong>
        </div>`).join('');
      navInfoBodyEl.innerHTML = `
        <p class="subtitle">Active profile: ${escapeHtml(j.activeProfile || 'none')}</p>
        <div class="info-list" style="margin-top:8px">${rows || '<p class="subtitle">No profiles reported.</p>'}</div>
        ${j.recommendation ? `<p class="subtitle" style="margin-top:8px">Recommended: ${escapeHtml(j.recommendation.label || j.recommendation.profile)} — ${escapeHtml(j.recommendation.reason || '')}</p>` : ''}
      `;
    } catch (e) {
      navInfoBodyEl.innerHTML = `<p class="subtitle">Failed to reach backend: ${escapeHtml(e.message)}</p>`;
    }
  });

  navDoctorBtnEl?.addEventListener('click', async () => {
    openNavInfo('Doctor', '<p class="subtitle">Running checks...</p>');
    try {
      // /doctor returns HTTP 503 whenever any check fails -- a real,
      // parseable response, not an unreachable backend (see the setup
      // wizard's own fetch above) -- so read the body regardless of .ok
      // rather than going through fetchJson's throw-on-!ok behavior.
      const resp = await fetch(`${BACKEND_URL}/doctor`);
      const j = await resp.json();
      const checks = j.checks || [];
      const counts = { pass: 0, warn: 0, fail: 0 };
      checks.forEach((c) => { counts[c.status] = (counts[c.status] || 0) + 1; });
      // Most checks pass on a working install -- put the ones that need
      // action up top with full detail, and collapse the rest into a
      // compact list instead of a wall of identical green cards.
      const needsAttention = checks.filter((c) => c.status !== 'pass');
      const passing = checks.filter((c) => c.status === 'pass');

      const attentionHtml = needsAttention.map((c) => `
        <button type="button" class="doctor-issue" data-doctor-message="${escapeHtml(c.message || '')}">
          <span class="setup-status-icon ${c.status}">${c.status === 'warn' ? '!' : '✕'}</span>
          <strong>${escapeHtml(c.label || c.id)}</strong>
        </button>`).join('');

      const passingHtml = passing.map((c) => `
        <div class="doctor-pass-row">
          <span class="setup-status-icon pass">✓</span>
          <span>${escapeHtml(c.label || c.id)}</span>
        </div>`).join('');

      navInfoBodyEl.innerHTML = `
        <div class="doctor-summary">
          <span class="doctor-count pass">${counts.pass || 0} passing</span>
          <span class="doctor-count warn">${counts.warn || 0} need attention</span>
          <span class="doctor-count fail">${counts.fail || 0} failing</span>
        </div>
        ${needsAttention.length
          ? `<div class="doctor-section-label">Needs attention</div><div class="doctor-attention-grid">${attentionHtml}</div>`
          : '<p class="subtitle">Everything needed is configured.</p>'}
        ${passing.length
          ? `<div class="doctor-section-label">All good (${passing.length})</div><div class="doctor-pass-list">${passingHtml}</div>`
          : ''}
      `;
    } catch (e) {
      navInfoBodyEl.innerHTML = `<p class="subtitle">Failed to reach backend: ${escapeHtml(e.message)}</p>`;
    }
  });

  // Issue #428: restorable snapshots of applied editor-handoff edits, from
  // whichever editor was connected -- generic, not Zed-specific (see
  // node-bot's zed-integration.js listEditSnapshots/restoreEditSnapshot).
  function formatSnapshotTimestamp(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }

  function renderEditSnapshotsPanel(snapshots) {
    if (!snapshots.length) {
      navInfoBodyEl.innerHTML = '<p class="subtitle">No applied edits yet.</p>';
      return;
    }
    navInfoBodyEl.innerHTML = `
      <p class="subtitle">Edits applied from a connected editor can be undone here, independent of git.</p>
      ${snapshots.map((s) => `
        <div class="snapshot-item">
          <div class="snapshot-item-info">
            <div class="snapshot-item-path">${escapeHtml(s.relativePath || '(unknown file)')}</div>
            <div class="snapshot-item-meta">${escapeHtml(s.summary || 'Edit')} · ${escapeHtml(formatSnapshotTimestamp(s.appliedAt))}</div>
          </div>
          <button type="button" class="snapshot-restore-btn primary" data-snapshot-id="${escapeHtml(s.id)}" data-snapshot-path="${escapeHtml(s.relativePath || '')}">Restore</button>
        </div>`).join('')}
    `;
  }

  async function refreshEditSnapshotsPanel() {
    openNavInfo('Applied edits', '<p class="subtitle">Loading...</p>');
    try {
      const result = await fetchJson(`${BACKEND_URL}/editors/workspace/snapshots`);
      renderEditSnapshotsPanel(result.snapshots || []);
    } catch (e) {
      navInfoBodyEl.innerHTML = `<p class="subtitle">Failed to reach backend: ${escapeHtml(e.message)}</p>`;
    }
  }

  navSnapshotsBtnEl?.addEventListener('click', () => {
    refreshEditSnapshotsPanel();
  });

  // Restore has no code-level conflict check against the file's current
  // content -- unlike approving a proposal, a snapshot only knows the
  // file's state before its own edit, not what may have changed since.
  // This confirm() is the safety net, matching the plain-confirm pattern
  // used for other destructive actions in this app (preset/skill delete).
  async function restoreEditSnapshotWithConfirm(id, relativePath) {
    if (!id) return;
    const confirmed = window.confirm(
      `Restore "${relativePath}" to its state before this edit? The current content will be overwritten.`,
    );
    if (!confirmed) return;
    try {
      const result = await fetchJson(
        `${BACKEND_URL}/editors/workspace/snapshots/${encodeURIComponent(id)}/restore`,
        { method: 'POST' },
      );
      if (!result.restored) throw new Error('Restore failed');
      await refreshEditSnapshotsPanel();
    } catch (e) {
      console.warn('Mana restore edit snapshot failed:', e);
    }
  }

  // Presets: saved persona/behavior instructions the user can select to be
  // appended to the base system prompt server-side (see buildAssistantReply
  // in node-bot/server.js). Backed by GET/POST/PATCH/DELETE /presets;
  // selected preset id is sent as presetId on /transcribe.
  const PRESET_STORAGE_KEY = 'manaSelectedPresetId';
  let selectedPresetId = localStorage.getItem(PRESET_STORAGE_KEY) || '';
  let editingPresetId = null;
  let latestPresets = [];

  function setSelectedPresetId(presetId) {
    selectedPresetId = presetId || '';
    if (selectedPresetId) {
      localStorage.setItem(PRESET_STORAGE_KEY, selectedPresetId);
    } else {
      localStorage.removeItem(PRESET_STORAGE_KEY);
    }
    if (presetEditBtnEl) presetEditBtnEl.hidden = !selectedPresetId;
    if (presetDeleteBtnEl) presetDeleteBtnEl.hidden = !selectedPresetId;
  }

  function renderPresetSelect(presets) {
    if (!presetSelectEl) return;
    presetSelectEl.innerHTML = '';
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = 'None';
    presetSelectEl.appendChild(noneOption);
    for (const preset of presets) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      presetSelectEl.appendChild(option);
    }
    const stillExists = presets.some((preset) => preset.id === selectedPresetId);
    presetSelectEl.value = stillExists ? selectedPresetId : '';
    setSelectedPresetId(presetSelectEl.value);
  }

  async function refreshPresetList() {
    try {
      const resp = await fetch('http://127.0.0.1:5005/presets');
      if (!resp.ok) throw new Error(`Preset list returned ${resp.status}`);
      const result = await resp.json();
      latestPresets = result.presets || [];
      renderPresetSelect(latestPresets);
    } catch (e) {
      console.warn('Mana preset list failed:', e);
    }
  }

  function closePresetEditor() {
    editingPresetId = null;
    if (presetEditorEl) presetEditorEl.hidden = true;
    if (presetNameInputEl) presetNameInputEl.value = '';
    if (presetInstructionsInputEl) presetInstructionsInputEl.value = '';
  }

  function openPresetEditor(preset) {
    editingPresetId = preset ? preset.id : null;
    if (presetNameInputEl) presetNameInputEl.value = preset ? preset.name : '';
    if (presetInstructionsInputEl) presetInstructionsInputEl.value = preset ? preset.instructions : '';
    if (presetEditorEl) presetEditorEl.hidden = false;
    presetNameInputEl?.focus();
  }

  presetSelectEl?.addEventListener('change', () => {
    setSelectedPresetId(presetSelectEl.value);
  });

  presetNewBtnEl?.addEventListener('click', () => openPresetEditor(null));

  presetEditBtnEl?.addEventListener('click', () => {
    const preset = latestPresets.find((item) => item.id === selectedPresetId);
    if (preset) openPresetEditor(preset);
  });

  presetCancelBtnEl?.addEventListener('click', closePresetEditor);

  presetSaveBtnEl?.addEventListener('click', async () => {
    const name = presetNameInputEl?.value.trim();
    const instructions = presetInstructionsInputEl?.value.trim();
    if (!name || !instructions) return;
    try {
      const url = editingPresetId
        ? `http://127.0.0.1:5005/presets/${editingPresetId}`
        : 'http://127.0.0.1:5005/presets';
      const resp = await fetch(url, {
        method: editingPresetId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, instructions }),
      });
      if (!resp.ok) throw new Error(`Save preset returned ${resp.status}`);
      const saved = await resp.json();
      closePresetEditor();
      await refreshPresetList();
      presetSelectEl.value = saved.id;
      setSelectedPresetId(saved.id);
    } catch (e) {
      console.warn('Mana save preset failed:', e);
    }
  });

  presetDeleteBtnEl?.addEventListener('click', async () => {
    const preset = latestPresets.find((item) => item.id === selectedPresetId);
    if (!preset) return;
    const confirmed = window.confirm(`Delete preset "${preset.name}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      const resp = await fetch(`http://127.0.0.1:5005/presets/${preset.id}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error(`Delete preset returned ${resp.status}`);
      setSelectedPresetId('');
      await refreshPresetList();
    } catch (e) {
      console.warn('Mana delete preset failed:', e);
    }
  });

  // Skills (Settings > Skills, issue #262 follow-up): create/edit/delete
  // procedural-memory skills, backed by node-bot's skills-store.js via
  // GET/POST/PATCH/DELETE /skills. Edit/delete aren't gated at all (see
  // skills-capability.js) since a Settings form submission already is the
  // human decision the gate exists to require for agent-authored writes.
  // Create still goes through the same approval-gate path the idle-
  // triggered skill-proposal pass (issue #262) uses; a human is right here
  // filling out the form, so a "pending" outcome with nothing flagged
  // auto-clears instead of a redundant second confirmation -- but if the
  // gate's content scan actually flagged something, that's specifically
  // the case worth a second look, so it's left pending and shown below.
  let selectedSkillName = '';
  let editingSkillName = null;
  let latestSkills = [];

  // The two skill-write action types (server.js/skill-proposal.js) --
  // manual/conversational vs. the idle-triggered autonomous pass -- share
  // this one review surface, since either way it's a skill sitting pending
  // for a human to look at.
  const SKILL_WRITE_ACTION_TYPES = ['skill-write', 'skill-write-idle'];

  function setSkillsStatus(message, isError) {
    if (!skillsStatusEl) return;
    if (!message) {
      skillsStatusEl.hidden = true;
      skillsStatusEl.textContent = '';
      return;
    }
    skillsStatusEl.hidden = false;
    skillsStatusEl.textContent = message;
    skillsStatusEl.classList.toggle('error', Boolean(isError));
  }

  function setSelectedSkillName(name) {
    selectedSkillName = name || '';
    if (skillsEditBtnEl) skillsEditBtnEl.hidden = !selectedSkillName;
    if (skillsDeleteBtnEl) skillsDeleteBtnEl.hidden = !selectedSkillName;
  }

  function renderSkillsSelect(skills) {
    if (!skillsSelectEl) return;
    skillsSelectEl.innerHTML = '';
    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = 'None';
    skillsSelectEl.appendChild(noneOption);
    for (const skill of skills) {
      const option = document.createElement('option');
      option.value = skill.name;
      // Flags a skill nobody's actually reached for again since it was
      // approved -- the useCount signal from skills-store.js -- so an
      // approved-but-never-mattered proposal is visible, not indistinguishable
      // from a genuinely useful one.
      option.textContent = skill.useCount ? skill.name : `${skill.name} (unused)`;
      skillsSelectEl.appendChild(option);
    }
    const stillExists = skills.some((skill) => skill.name === selectedSkillName);
    skillsSelectEl.value = stillExists ? selectedSkillName : '';
    setSelectedSkillName(skillsSelectEl.value);
  }

  function renderPendingSkills(pending) {
    if (!skillsPendingEl || !skillsPendingListEl) return;
    const skillPending = pending.filter((p) => SKILL_WRITE_ACTION_TYPES.includes(p.actionType));
    skillsPendingEl.hidden = skillPending.length === 0;
    skillsPendingListEl.innerHTML = '';
    for (const item of skillPending) {
      const row = document.createElement('div');
      row.className = 'skills-pending-item';
      const summary = document.createElement('div');
      summary.className = 'skills-pending-item-summary';
      summary.textContent = item.summary || item.payload?.name || 'Pending skill';
      row.appendChild(summary);
      if (item.flags?.length) {
        const flags = document.createElement('div');
        flags.className = 'skills-pending-item-flags';
        flags.textContent = `Flagged: ${item.flags.join(', ')}`;
        row.appendChild(flags);
      }
      const actions = document.createElement('div');
      actions.className = 'skills-pending-item-actions';
      const approveBtn = document.createElement('button');
      approveBtn.textContent = 'Approve';
      approveBtn.addEventListener('click', () => decidePendingSkill(item.id, 'allow-once'));
      const denyBtn = document.createElement('button');
      denyBtn.textContent = 'Deny';
      denyBtn.addEventListener('click', () => decidePendingSkill(item.id, 'deny'));
      actions.appendChild(approveBtn);
      actions.appendChild(denyBtn);
      row.appendChild(actions);
      skillsPendingListEl.appendChild(row);
    }
  }

  async function decidePendingSkill(requestId, decision) {
    try {
      await fetchJson(`${BACKEND_URL}/approvals/${requestId}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      setSkillsStatus(decision === 'deny' ? 'Skill proposal denied.' : 'Skill approved.');
      await refreshSkillsList();
    } catch (e) {
      setSkillsStatus(`Failed to ${decision === 'deny' ? 'deny' : 'approve'}: ${e.message}`, true);
    }
  }

  async function refreshPendingSkills() {
    if (!skillsPendingEl) return;
    try {
      const result = await fetchJson(`${BACKEND_URL}/approvals/pending`);
      renderPendingSkills(result.pending || []);
    } catch (e) {
      console.warn('Mana pending skills list failed:', e);
    }
  }

  async function refreshSkillsList() {
    if (!skillsSelectEl) return;
    try {
      const result = await fetchJson(`${BACKEND_URL}/skills`);
      latestSkills = result.skills || [];
      renderSkillsSelect(latestSkills);
    } catch (e) {
      setSkillsStatus(`Failed to load skills: ${e.message}`, true);
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
      skillNameInputEl.value = '';
      skillNameInputEl.disabled = false;
    }
    if (skillDescriptionInputEl) skillDescriptionInputEl.value = '';
    if (skillBodyInputEl) skillBodyInputEl.value = '';
  }

  function openSkillEditor(skill) {
    editingSkillName = skill ? skill.name : null;
    if (skillNameInputEl) {
      skillNameInputEl.value = skill ? skill.name : '';
      // Renaming isn't supported by skills-store.js's updateSkill -- keep
      // the name field locked once a skill already exists.
      skillNameInputEl.disabled = Boolean(skill);
    }
    if (skillDescriptionInputEl) skillDescriptionInputEl.value = skill ? skill.description : '';
    if (skillBodyInputEl) skillBodyInputEl.value = skill ? skill.body : '';
    if (skillsEditorEl) skillsEditorEl.hidden = false;
    (skillNameInputEl?.disabled ? skillDescriptionInputEl : skillNameInputEl)?.focus();
  }

  skillsSelectEl?.addEventListener('change', () => {
    setSelectedSkillName(skillsSelectEl.value);
  });

  skillsNewBtnEl?.addEventListener('click', () => {
    setSkillsStatus(null);
    openSkillEditor(null);
  });

  skillsEditBtnEl?.addEventListener('click', async () => {
    if (!selectedSkillName) return;
    try {
      // touch=false: browsing into Edit isn't Mana actually reaching for
      // the skill -- shouldn't bump lastUsed/un-stale it just because the
      // user opened (and maybe cancelled) the editor.
      const skill = await fetchJson(
        `${BACKEND_URL}/skills/${encodeURIComponent(selectedSkillName)}?touch=false`,
      );
      setSkillsStatus(null);
      openSkillEditor(skill);
    } catch (e) {
      setSkillsStatus(`Failed to load skill: ${e.message}`, true);
    }
  });

  skillCancelBtnEl?.addEventListener('click', closeSkillEditor);

  skillSaveBtnEl?.addEventListener('click', async () => {
    const name = skillNameInputEl?.value.trim();
    const description = skillDescriptionInputEl?.value.trim();
    const body = skillBodyInputEl?.value.trim();
    if (!name || !description || !body) return;
    skillSaveBtnEl.disabled = true;
    try {
      if (editingSkillName) {
        await fetchJson(`${BACKEND_URL}/skills/${encodeURIComponent(editingSkillName)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description, body }),
        });
        setSkillsStatus('Skill updated.');
      } else {
        const outcome = await fetchJson(`${BACKEND_URL}/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, body }),
        });
        if (outcome.status === 'pending' && outcome.requestId) {
          if (!outcome.flags || outcome.flags.length === 0) {
            // Nothing the content scan flagged, and a human just typed
            // this in directly -- auto-clear the hold instead of a
            // redundant second confirmation step.
            await fetchJson(`${BACKEND_URL}/approvals/${outcome.requestId}/decide`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision: 'allow-once' }),
            });
            setSkillsStatus('Skill created.');
          } else {
            // Flagged -- leave it genuinely pending rather than rubber-
            // stamping past the scan's own tripwire; shows up in the
            // pending-review list above for an explicit decision.
            setSkillsStatus(`Staged for review (flagged: ${outcome.flags.join(', ')}).`);
          }
        } else {
          setSkillsStatus('Skill created.');
        }
      }
      closeSkillEditor();
      setSelectedSkillName(name);
      await refreshSkillsList();
    } catch (e) {
      setSkillsStatus(`Failed to save skill: ${e.message}`, true);
    } finally {
      skillSaveBtnEl.disabled = false;
    }
  });

  skillsDeleteBtnEl?.addEventListener('click', async () => {
    if (!selectedSkillName) return;
    const confirmed = window.confirm(`Delete skill "${selectedSkillName}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      await fetchJson(`${BACKEND_URL}/skills/${encodeURIComponent(selectedSkillName)}`, { method: 'DELETE' });
      setSkillsStatus('Skill deleted.');
      setSelectedSkillName('');
      await refreshSkillsList();
    } catch (e) {
      setSkillsStatus(`Failed to delete skill: ${e.message}`, true);
    }
  });

  // Plugins (Settings > Plugins): optional integrations -- FFXIV Market
  // Watch, stock market, job search -- toggled per plugin, backed by
  // node-bot's plugin-settings-store.js via GET/POST /plugins.
  async function loadPlugins() {
    if (!pluginsListEl) return;
    try {
      const j = await fetchJson(`${BACKEND_URL}/plugins`);
      const rows = [];
      for (const category of Object.keys(j.plugins || {})) {
        for (const plugin of j.plugins[category]) {
          rows.push(`
            <div class="plugin-row">
              <div class="plugin-row-info">
                <strong>${escapeHtml(plugin.name)}</strong>
                <span>${escapeHtml(plugin.description || category)}</span>
              </div>
              <button class="plugin-switch ${plugin.enabled ? 'on' : ''}" data-plugin-key="${escapeHtml(plugin.key)}" aria-pressed="${plugin.enabled}" title="${plugin.enabled ? 'Enabled' : 'Disabled'}"></button>
            </div>`);
        }
      }
      pluginsListEl.innerHTML = rows.join('') || '<p class="subtitle">No plugins installed.</p>';
    } catch (e) {
      pluginsListEl.innerHTML = `<p class="subtitle">Failed to load plugins: ${escapeHtml(e.message)}</p>`;
    }
  }
  pluginsListEl?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.plugin-switch');
    if (!btn || btn.disabled) return;
    const key = btn.dataset.pluginKey;
    const nextEnabled = !btn.classList.contains('on');
    btn.disabled = true;
    try {
      await fetchJson(`${BACKEND_URL}/plugins/${encodeURIComponent(key)}/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      btn.classList.toggle('on', nextEnabled);
      btn.setAttribute('aria-pressed', String(nextEnabled));
      btn.title = nextEnabled ? 'Enabled' : 'Disabled';
    } catch (e) {
      console.warn('Mana plugin toggle failed:', e);
      loadPlugins();
    } finally {
      btn.disabled = false;
    }
  });
  loadPlugins();

  // Memory (Settings > Memory, issue #324): browse/manage acp-memory-store's
  // remembered facts (memory__remember), including the unverifiedSource flag
  // from issue #317 -- previously only inspectable by reading facts.json by
  // hand. Mirrors the Plugins panel above.
  const memoryFactsListEl = document.getElementById('memoryFactsList');
  const memorySearchInputEl = document.getElementById('memorySearchInput');
  let latestMemoryFacts = [];

  function renderMemoryFactsList(query = '') {
    if (!memoryFactsListEl) return;
    const normalizedQuery = query.trim().toLowerCase();
    const facts = latestMemoryFacts.filter(
      (fact) =>
        !normalizedQuery ||
        fact.key.toLowerCase().includes(normalizedQuery) ||
        (fact.text || '').toLowerCase().includes(normalizedQuery),
    );
    if (facts.length === 0) {
      memoryFactsListEl.innerHTML = `<p class="subtitle">${
        latestMemoryFacts.length ? `No facts match "${escapeHtml(query)}".` : 'No remembered facts yet.'
      }</p>`;
      return;
    }
    memoryFactsListEl.innerHTML = facts
      .map(
        (fact) => `
          <div class="plugin-row">
            <div class="plugin-row-info">
              <strong>${escapeHtml(fact.key)}</strong>
              <span>${escapeHtml(fact.text)}</span>
              ${fact.unverifiedSource ? '<span class="memory-fact-flag">Unverified source</span>' : ''}
            </div>
            ${
              fact.status === 'active'
                ? `<button class="memory-archive-btn" data-fact-key="${escapeHtml(fact.key)}" title="Archive">Archive</button>`
                : `<span class="subtitle">${escapeHtml(fact.status)}</span>`
            }
          </div>`,
      )
      .join('');
  }

  async function loadMemoryFacts() {
    if (!memoryFactsListEl) return;
    try {
      const j = await fetchJson(`${BACKEND_URL}/admin/memory/facts`);
      latestMemoryFacts = j.facts || [];
      renderMemoryFactsList(memorySearchInputEl?.value || '');
    } catch (e) {
      memoryFactsListEl.innerHTML = `<p class="subtitle">Failed to load memory: ${escapeHtml(e.message)}</p>`;
    }
  }
  memorySearchInputEl?.addEventListener('input', () => {
    renderMemoryFactsList(memorySearchInputEl.value);
  });
  memoryFactsListEl?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.memory-archive-btn');
    if (!btn || btn.disabled) return;
    const key = btn.dataset.factKey;
    btn.disabled = true;
    try {
      await fetchJson(`${BACKEND_URL}/admin/memory/facts/${encodeURIComponent(key)}/archive`, { method: 'POST' });
      await loadMemoryFacts();
    } catch (e) {
      console.warn('Mana fact archive failed:', e);
      btn.disabled = false;
    }
  });
  loadMemoryFacts();

  // Model selection (Settings > Model + onboarding's "Local AI model" item):
  // scan the PC for .gguf files or browse to one directly, then persist the
  // pick via node-bot's /models/path -- see model-management.js's
  // scanForModels/setModelPath on the backend.
  function formatModelBytes(n) {
    if (!Number.isFinite(n)) return '';
    const gb = n / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${(n / (1024 ** 2)).toFixed(0)} MB`;
  }

  function renderModelScanList(containerEl, scanResult, onPick) {
    const models = scanResult.found || [];
    if (!models.length) {
      containerEl.innerHTML = `<p class="subtitle">No .gguf files found${scanResult.truncated ? ' (scan stopped early -- try Browse instead for a specific file).' : '.'}</p>`;
    } else {
      containerEl.innerHTML = models.map((m, i) => `
        <div class="model-scan-item" data-scan-index="${i}">
          <div class="model-scan-item-info">
            <strong>${escapeHtml(m.name)}</strong>
            <span>${escapeHtml(m.path)}</span>
          </div>
          <span class="model-scan-item-size">${escapeHtml(formatModelBytes(m.sizeBytes))}</span>
        </div>`).join('');
      containerEl.querySelectorAll('[data-scan-index]').forEach((row) => {
        row.addEventListener('click', () => onPick(models[Number(row.dataset.scanIndex)].path));
      });
    }
    containerEl.hidden = false;
  }

  async function selectModelPath(modelPath) {
    return fetchJson(`${BACKEND_URL}/models/path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath }),
    });
  }

  async function loadModelSettings() {
    if (!modelCurrentEl) return;
    try {
      const status = await fetchJson(`${BACKEND_URL}/models/status`);
      if (status.selectedModelPath) {
        modelCurrentEl.textContent = `Using: ${basename(status.selectedModelPath)}`;
      } else {
        const active = status.profiles ? status.profiles[status.activeProfile] : null;
        modelCurrentEl.textContent = active && active.available
          ? `Auto-detected: ${basename(active.selectedModel)} (${active.label})`
          : 'No local model detected yet.';
      }
      if (modelClearBtnEl) modelClearBtnEl.hidden = !status.selectedModelPath;
    } catch (e) {
      modelCurrentEl.textContent = `Failed to load model status: ${e.message}`;
    }
  }

  modelScanBtnEl?.addEventListener('click', async () => {
    modelScanBtnEl.disabled = true;
    const prevText = modelScanBtnEl.textContent;
    modelScanBtnEl.textContent = 'Scanning...';
    try {
      const result = await fetchJson(`${BACKEND_URL}/models/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      renderModelScanList(modelScanResultsEl, result, async (path) => {
        await selectModelPath(path);
        modelScanResultsEl.hidden = true;
        await loadModelSettings();
      });
    } catch (e) {
      modelScanResultsEl.innerHTML = `<p class="subtitle">Scan failed: ${escapeHtml(e.message)}</p>`;
      modelScanResultsEl.hidden = false;
    } finally {
      modelScanBtnEl.disabled = false;
      modelScanBtnEl.textContent = prevText;
    }
  });

  modelBrowseBtnEl?.addEventListener('click', async () => {
    if (!window.electronAPI?.browseModelFile) return;
    const picked = await window.electronAPI.browseModelFile();
    if (picked.canceled) return;
    try {
      await selectModelPath(picked.filePath);
      await loadModelSettings();
    } catch (e) {
      modelCurrentEl.textContent = `Failed to use that file: ${e.message}`;
    }
  });

  modelClearBtnEl?.addEventListener('click', async () => {
    try {
      await selectModelPath(null);
      await loadModelSettings();
    } catch (e) {
      modelCurrentEl.textContent = `Failed to clear: ${e.message}`;
    }
  });

  loadModelSettings();

  // Brain provider: local llama-server (profile buttons above) vs. any
  // OpenAI-compatible endpoint -- self-hosted (Ollama, LM Studio, vLLM,
  // text-generation-webui, ...) or a real API. See node-bot's
  // shouldUseRemoteAi (ai/local-ai.js) for why a local endpoint here doesn't
  // need MANA_ALLOW_REMOTE_AI. Vision GGUF + mmproj override behaves the
  // same way as the desktop-side model picker above.
  let brainProviderPresets = [];

  async function loadBrainProviderPresets() {
    if (!brainProviderSelectEl) return;
    try {
      brainProviderPresets = await fetchJson(`${BACKEND_URL}/models/brain-providers`);
      brainProviderSelectEl.innerHTML = '';
      for (const preset of brainProviderPresets) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.label;
        brainProviderSelectEl.appendChild(option);
      }
    } catch (e) {
      console.warn('Mana brain provider presets failed:', e);
    }
  }

  // Only overwrite the brain/vision fields with what the backend has stored
  // when the user isn't actively mid-edit, since this polls alongside the
  // rest of Settings.
  async function loadBrainAndVisionSettings() {
    try {
      const status = await fetchJson(`${BACKEND_URL}/models/status`);
      const brain = status.brain || { type: 'local', baseUrl: '', model: '' };
      const isEditing = [brainBaseUrlEl, brainModelEl, brainApiKeyEl].includes(document.activeElement);
      if (!isEditing) {
        if (useRemoteAiToggleEl) useRemoteAiToggleEl.checked = brain.type === 'openai_compatible';
        if (brainProviderFieldsEl) brainProviderFieldsEl.hidden = brain.type !== 'openai_compatible';
        if (brainProviderSelectEl) {
          const matched = brainProviderPresets.find((p) => p.baseUrl === brain.baseUrl);
          brainProviderSelectEl.value = matched ? matched.id : 'custom';
        }
        if (brainBaseUrlEl) brainBaseUrlEl.value = brain.baseUrl || '';
        if (brainModelEl) brainModelEl.value = brain.model || '';
        if (brainApiKeyEl) brainApiKeyEl.placeholder = brain.hasApiKey ? '(key saved -- leave blank to keep it)' : 'leave blank for local servers';
      }
      const vision = status.vision || { modelPath: '', mmprojPath: '' };
      if (visionModelPathEl) visionModelPathEl.value = vision.modelPath || '';
      if (visionMmprojPathEl) visionMmprojPathEl.value = vision.mmprojPath || '';
    } catch (e) {
      console.warn('Mana brain/vision status failed:', e);
    }
  }

  function toggleBrainProviderFields() {
    if (brainProviderFieldsEl) brainProviderFieldsEl.hidden = !useRemoteAiToggleEl?.checked;
  }
  useRemoteAiToggleEl?.addEventListener('change', toggleBrainProviderFields);

  // Picking a preset auto-fills its baseUrl; "Custom" clears it for manual entry.
  brainProviderSelectEl?.addEventListener('change', () => {
    const preset = brainProviderPresets.find((p) => p.id === brainProviderSelectEl.value);
    if (brainBaseUrlEl) brainBaseUrlEl.value = preset?.baseUrl || '';
  });

  brainProviderConnectBtnEl?.addEventListener('click', async () => {
    if (brainProviderStatusEl) brainProviderStatusEl.textContent = 'Connecting...';
    try {
      const result = await fetchJson(`${BACKEND_URL}/models/brain-provider/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: brainBaseUrlEl?.value || '', apiKey: brainApiKeyEl?.value || '' }),
      });
      if (brainProviderStatusEl) {
        brainProviderStatusEl.textContent = result.ok
          ? `Connected${typeof result.modelCount === 'number' ? ` -- ${result.modelCount} model(s) available` : ''}.`
          : `Connection failed: ${result.error || `HTTP ${result.status}`}`;
      }
    } catch (e) {
      if (brainProviderStatusEl) brainProviderStatusEl.textContent = `Connection failed: ${e.message}`;
    }
  });

  brainProviderSaveBtnEl?.addEventListener('click', async () => {
    const type = useRemoteAiToggleEl?.checked ? 'openai_compatible' : 'local';
    const body = { type };
    if (type === 'openai_compatible') {
      body.baseUrl = brainBaseUrlEl?.value || '';
      body.model = brainModelEl?.value || '';
      // Blank means "keep whatever's already saved" -- re-saving
      // baseUrl/model shouldn't wipe a key the user isn't looking at.
      if (brainApiKeyEl?.value) body.apiKey = brainApiKeyEl.value;
    }
    if (brainProviderStatusEl) brainProviderStatusEl.textContent = 'Saving...';
    try {
      await fetchJson(`${BACKEND_URL}/models/brain-provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (brainApiKeyEl) brainApiKeyEl.value = '';
      await loadBrainAndVisionSettings();
      if (brainProviderStatusEl) brainProviderStatusEl.textContent = 'Saved.';
    } catch (e) {
      if (brainProviderStatusEl) brainProviderStatusEl.textContent = `Failed to save: ${e.message}`;
    }
  });

  async function browseAndSetVisionField(fieldName) {
    if (!window.electronAPI?.browseModelFile) return;
    try {
      const picked = await window.electronAPI.browseModelFile();
      if (picked.canceled) return;
      await fetchJson(`${BACKEND_URL}/models/vision-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [fieldName]: picked.filePath }),
      });
      await loadBrainAndVisionSettings();
    } catch (e) {
      if (visionModelStatusEl) visionModelStatusEl.textContent = `Failed: ${e.message}`;
    }
  }
  visionModelBrowseBtnEl?.addEventListener('click', () => browseAndSetVisionField('modelPath'));
  visionMmprojBrowseBtnEl?.addEventListener('click', () => browseAndSetVisionField('mmprojPath'));

  visionModelClearBtnEl?.addEventListener('click', async () => {
    try {
      await fetchJson(`${BACKEND_URL}/models/vision-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelPath: '', mmprojPath: '' }),
      });
      await loadBrainAndVisionSettings();
      if (visionModelStatusEl) visionModelStatusEl.textContent = 'Cleared -- back to auto-detect.';
    } catch (e) {
      if (visionModelStatusEl) visionModelStatusEl.textContent = `Failed: ${e.message}`;
    }
  });

  loadBrainProviderPresets().then(loadBrainAndVisionSettings);

  refreshPresetList();
  setSelectedPresetId(selectedPresetId);

  // Compare mode: an opt-in side-by-side view (not part of the normal
  // record/transcribe flow) that sends one typed prompt to two model
  // profiles via the existing /reply endpoint -- no new backend inference
  // path, no sessionId (so these exploratory replies don't get saved to
  // chat/session memory).
  let compareModeActive = false;
  let compareRunning = false;
  let compareAbortController = null;
  let latestCompareProfiles = {};

  function updateCompareLabels(){
    if (compareLabelAEl) {
      compareLabelAEl.textContent = formatCompareProfileLabel(compareProfileAEl?.value, latestCompareProfiles);
    }
    if (compareLabelBEl) {
      compareLabelBEl.textContent = formatCompareProfileLabel(compareProfileBEl?.value, latestCompareProfiles);
    }
  }

  function populateCompareSelects(profiles){
    if (!compareProfileAEl || !compareProfileBEl) return;
    latestCompareProfiles = profiles || {};
    const keys = Object.keys(latestCompareProfiles);
    const availableKeys = keys.filter((key) => latestCompareProfiles[key]?.available);
    const previousA = compareProfileAEl.value;
    const previousB = compareProfileBEl.value;

    for (const selectEl of [compareProfileAEl, compareProfileBEl]) {
      selectEl.innerHTML = '';
      for (const key of keys) {
        const profile = latestCompareProfiles[key];
        const option = document.createElement('option');
        option.value = key;
        option.textContent = profile?.available ? (profile.label || key) : `${profile?.label || key} (unavailable)`;
        option.disabled = !profile?.available;
        selectEl.appendChild(option);
      }
    }

    const pickFrom = availableKeys.length ? availableKeys : keys;
    const [defaultA, defaultB] = pickDefaultCompareProfiles(pickFrom);
    compareProfileAEl.value = availableKeys.includes(previousA) ? previousA : defaultA;
    compareProfileBEl.value = availableKeys.includes(previousB) ? previousB : defaultB;

    updateCompareLabels();
  }

  compareProfileAEl?.addEventListener('change', updateCompareLabels);
  compareProfileBEl?.addEventListener('change', updateCompareLabels);

  async function refreshCompareModelStatus(){
    try {
      const resp = await fetch('http://127.0.0.1:5005/models/status');
      if (!resp.ok) return;
      const status = await resp.json();
      populateCompareSelects(status.profiles);
    } catch (e) {
      console.warn('Compare mode: model status unavailable:', e);
    }
  }

  const defaultMessageInputPlaceholder = messageInputEl?.placeholder || '';

  function setCompareModeActive(active){
    compareModeActive = active;
    btnCompareEl?.classList.toggle('active', active);
    if (comparePanelEl) comparePanelEl.hidden = !active;
    if (messageInputEl) {
      messageInputEl.placeholder = active
        ? 'Type a prompt and press Enter to compare...'
        : defaultMessageInputPlaceholder;
    }
  }

  btnCompareEl?.addEventListener('click', () => { setCompareModeActive(!compareModeActive); });

  function setComparePreferred(column){
    compareColumnAEl?.classList.toggle('preferred', column === 'a');
    compareColumnBEl?.classList.toggle('preferred', column === 'b');
  }

  comparePreferAEl?.addEventListener('click', () => setComparePreferred('a'));
  comparePreferBEl?.addEventListener('click', () => setComparePreferred('b'));

  async function fetchCompareReply(text, profile, signal){
    const resp = await fetch('http://127.0.0.1:5005/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, modelProfile: profile }),
      signal,
    });
    if (!resp.ok) {
      const message = await resp.text();
      throw new Error(message || `Reply failed (${resp.status})`);
    }
    const result = await resp.json();
    return result.reply || '';
  }

  function describeCompareOutcome(settledResult){
    if (settledResult.status === 'fulfilled') return settledResult.value;
    if (settledResult.reason?.name === 'AbortError') return 'Cancelled.';
    return `Failed: ${settledResult.reason.message}`;
  }

  async function runCompare(){
    if (!messageInputEl || compareRunning) return;
    const text = messageInputEl.value.trim();
    if (!text) return;
    messageInputEl.value = '';
    compareRunning = true;
    setComparePreferred(null);
    if (compareCancelBtnEl) compareCancelBtnEl.hidden = false;

    const profileA = compareProfileAEl?.value || 'default';
    const profileB = compareProfileBEl?.value || 'default';
    updateCompareLabels();
    if (compareResultAEl) compareResultAEl.textContent = 'Thinking...';
    if (compareResultBEl) compareResultBEl.textContent = 'Thinking...';

    compareAbortController = new AbortController();
    const { signal } = compareAbortController;

    const [resultA, resultB] = await Promise.allSettled([
      fetchCompareReply(text, profileA, signal),
      fetchCompareReply(text, profileB, signal),
    ]);

    if (compareResultAEl) compareResultAEl.textContent = describeCompareOutcome(resultA);
    if (compareResultBEl) compareResultBEl.textContent = describeCompareOutcome(resultB);
    compareAbortController = null;
    compareRunning = false;
    if (compareCancelBtnEl) compareCancelBtnEl.hidden = true;
  }

  compareCancelBtnEl?.addEventListener('click', () => { compareAbortController?.abort(); });

  let sendingTextMessage = false;
  async function sendTextMessage() {
    if (!messageInputEl || sendingTextMessage) return;
    const text = messageInputEl.value.trim();
    if (!text) return;
    messageInputEl.value = '';
    sendingTextMessage = true;
    appendMessage('user', text);
    statusEl.textContent = 'Thinking...';
    try {
      // Issue #331 review (Finding 1): append to the chat log as soon as
      // the final event names the reply, not after speakStreamingReply
      // resolves -- that await also waits for every queued chunk to finish
      // *playing*.
      const result = await speakStreamingReply(
        {
          text,
          sessionId: ensureSessionId(),
          presetId: selectedPresetId || undefined,
        },
        (finalEvent) => {
          if (!finalEvent.error && finalEvent.reply) appendMessage('assistant', finalEvent.reply);
        },
      );
      // /reply/stream has no HTTP-level error status (always 200) -- errors
      // surface as an `error` field on the final event instead.
      if (result.error) throw new Error(result.error);
      statusEl.textContent = 'Idle';
    } catch (e) {
      statusEl.textContent = 'Error';
      await window.electronAPI.showError(String(e));
      setSprite('idle');
    } finally {
      sendingTextMessage = false;
    }
  }

  messageInputEl?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (compareModeActive) runCompare();
    else sendTextMessage();
  });

  refreshCompareModelStatus();

  // First-run setup wizard (issue #123). Structured per-item status instead
  // of a raw /doctor JSON dump, and shown whenever the local model or
  // Whisper genuinely aren't set up yet -- not a one-time "seen it" flag,
  // so it keeps helping until the thing it's nudging about is actually
  // fixed, then stays out of the way for good.
  function showOnboarding(){
    document.getElementById('onboardingModal').setAttribute('aria-hidden','false');
  }
  function hideOnboarding(){
    document.getElementById('onboardingModal').setAttribute('aria-hidden','true');
  }
  function setSetupStatus(iconEl, detailEl, status, message){
    iconEl.className = 'setup-status-icon' + (status ? ' ' + status : '');
    iconEl.textContent = status === 'pass' ? '✓' : status === 'fail' ? '!' : '-';
    detailEl.textContent = message;
  }
  function basename(p){
    return String(p || '').split(/[\\/]/).pop();
  }

  const setupModelIconEl = document.getElementById('setupModelIcon');
  const setupModelDetailEl = document.getElementById('setupModelDetail');
  const setupModelActionsEl = document.getElementById('setupModelActions');
  const setupModelScanBtnEl = document.getElementById('setupModelScanBtn');
  const setupModelBrowseBtnEl = document.getElementById('setupModelBrowseBtn');
  const setupModelScanResultsEl = document.getElementById('setupModelScanResults');
  const setupWhisperIconEl = document.getElementById('setupWhisperIcon');
  const setupWhisperDetailEl = document.getElementById('setupWhisperDetail');
  const setupAvatarIconEl = document.getElementById('setupAvatarIcon');
  const setupAvatarDetailEl = document.getElementById('setupAvatarDetail');
  const fetchAvatarBtnEl = document.getElementById('fetchAvatarBtn');
  const onboardDetailsEl = document.getElementById('onboardDetails');
  const onboardTextEl = document.getElementById('onboardText');

  async function runOnboardingChecks(){
    let modelOk = false;
    let whisperOk = false;
    onboardDetailsEl.hidden = true;

    try {
      // /doctor deliberately returns HTTP 503 whenever any check fails --
      // that's a real, parseable "here's what's wrong" response, not an
      // unreachable backend, so read the body regardless of .ok. Only a
      // network-level failure (caught below) means the backend truly isn't
      // reachable yet.
      const [doctorResp, modelsResp] = await Promise.all([
        fetch('http://127.0.0.1:5005/doctor'),
        fetch('http://127.0.0.1:5005/models/status'),
      ]);
      const doctor = await doctorResp.json();
      const models = await modelsResp.json();

      const whisperCheck = (doctor.checks || []).find((c) => c.id === 'whisper-config');
      whisperOk = Boolean(whisperCheck && whisperCheck.status === 'pass');
      if (whisperOk) {
        setSetupStatus(setupWhisperIconEl, setupWhisperDetailEl, 'pass',
          `Using ${basename(whisperCheck.details.bin)} + ${basename(whisperCheck.details.model)}.`);
      } else {
        setSetupStatus(setupWhisperIconEl, setupWhisperDetailEl, 'warn',
          'Not found. Get whisper.cpp (whisper-cli.exe) and a ggml model (e.g. ggml-base.en.bin), place them under tools/whisper/, then click Recheck. See docs/quick_start_windows.md.');
      }

      const rec = models.recommendation;
      const profile = rec && models.profiles ? models.profiles[rec.profile] : null;
      modelOk = Boolean(profile && profile.available);
      if (modelOk) {
        setSetupStatus(setupModelIconEl, setupModelDetailEl, 'pass',
          `Using ${profile.label}: ${basename(profile.selectedModel) || profile.selectedModel}.`);
      } else if (profile) {
        setSetupStatus(setupModelIconEl, setupModelDetailEl, 'warn',
          `Recommended for your hardware: ${profile.label}. ${rec.reason} Scan for a model on this PC, browse to one directly, or download one of: ${profile.missing.join(', ')} and place it under tools/llama/, then click Recheck.`);
      } else {
        setSetupStatus(setupModelIconEl, setupModelDetailEl, 'warn', 'Could not determine a recommendation.');
      }
      if (setupModelActionsEl) setupModelActionsEl.hidden = modelOk;
      if (modelOk && setupModelScanResultsEl) setupModelScanResultsEl.hidden = true;
    } catch (e) {
      setSetupStatus(setupModelIconEl, setupModelDetailEl, 'warn', 'Backend not reachable yet.');
      setSetupStatus(setupWhisperIconEl, setupWhisperDetailEl, 'warn', 'Backend not reachable yet.');
      if (setupModelActionsEl) setupModelActionsEl.hidden = true;
      onboardDetailsEl.hidden = false;
      onboardDetailsEl.textContent = 'Setup check failed: ' + (e.message || e);
    }

    try {
      const resolved = window.electronAPI.resolveAvatarModel
        ? await window.electronAPI.resolveAvatarModel()
        : null;
      if (resolved && resolved.modelJson) {
        setSetupStatus(setupAvatarIconEl, setupAvatarDetailEl, 'pass', 'Avatar model found.');
        fetchAvatarBtnEl.hidden = true;
      } else {
        setSetupStatus(setupAvatarIconEl, setupAvatarDetailEl, 'warn',
          "No avatar model yet -- Mana falls back to a simple sprite. Optional, and free to fetch below.");
        fetchAvatarBtnEl.hidden = false;
      }
    } catch (e) {
      setSetupStatus(setupAvatarIconEl, setupAvatarDetailEl, 'warn', 'Could not check.');
    }

    onboardTextEl.textContent = (modelOk && whisperOk)
      ? "You're all set!"
      : 'A couple of things still need setup for the full experience:';

    return { modelOk, whisperOk };
  }

  setupModelScanBtnEl?.addEventListener('click', async () => {
    setupModelScanBtnEl.disabled = true;
    const prevText = setupModelScanBtnEl.textContent;
    setupModelScanBtnEl.textContent = 'Scanning...';
    try {
      const result = await fetchJson(`${BACKEND_URL}/models/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      renderModelScanList(setupModelScanResultsEl, result, async (path) => {
        await selectModelPath(path);
        setupModelScanResultsEl.hidden = true;
        await runOnboardingChecks();
      });
    } catch (e) {
      setupModelScanResultsEl.innerHTML = `<p class="subtitle">Scan failed: ${escapeHtml(e.message)}</p>`;
      setupModelScanResultsEl.hidden = false;
    } finally {
      setupModelScanBtnEl.disabled = false;
      setupModelScanBtnEl.textContent = prevText;
    }
  });

  setupModelBrowseBtnEl?.addEventListener('click', async () => {
    if (!window.electronAPI?.browseModelFile) return;
    const picked = await window.electronAPI.browseModelFile();
    if (picked.canceled) return;
    await selectModelPath(picked.filePath);
    await runOnboardingChecks();
  });

  document.getElementById('recheckSetupBtn').addEventListener('click', async () => {
    const { modelOk, whisperOk } = await runOnboardingChecks();
    if (modelOk && whisperOk) {
      hideOnboarding();
    }
  });
  fetchAvatarBtnEl.addEventListener('click', async () => {
    fetchAvatarBtnEl.disabled = true;
    const prevText = fetchAvatarBtnEl.textContent;
    fetchAvatarBtnEl.textContent = 'Fetching...';
    try {
      const res = await window.electronAPI.fetchSampleAvatar();
      if (!res || !res.ok) {
        setupAvatarDetailEl.textContent = 'Fetch failed: ' + (res && res.message ? res.message : 'unknown error');
      }
      await runOnboardingChecks();
    } finally {
      fetchAvatarBtnEl.disabled = false;
      fetchAvatarBtnEl.textContent = prevText;
    }
  });
  document.getElementById('dismissOnboarding').addEventListener('click', ()=>{ hideOnboarding(); });
  document.getElementById('openDocsBtn').addEventListener('click', async ()=>{ try{ await window.electronAPI.openDocs(); } catch(e){ window.open('../BUILD_DESKTOP.md','_blank'); } });

  if (updateVersionEl && window.electronAPI?.getAppVersion) {
    window.electronAPI.getAppVersion().then((v) => { updateVersionEl.textContent = `Version ${v}`; }).catch(()=>{});
  }
  if (window.electronAPI?.onUpdateStatus) {
    window.electronAPI.onUpdateStatus((status) => {
      if (updateStatusEl) updateStatusEl.textContent = status.message || status.state;
    });
  }
  if (checkUpdatesBtnEl) {
    checkUpdatesBtnEl.addEventListener('click', async () => {
      checkUpdatesBtnEl.disabled = true;
      if (updateStatusEl) updateStatusEl.textContent = 'Checking for updates...';
      try {
        const res = await window.electronAPI.checkForUpdates();
        if (res && !res.ok && updateStatusEl) updateStatusEl.textContent = res.message || 'Check failed.';
      } finally {
        checkUpdatesBtnEl.disabled = false;
      }
    });
  }

  // Show whenever the model or Whisper setup genuinely isn't done yet --
  // not a one-time flag, so dismissing just means "later, this session,"
  // and it naturally stops appearing once actually fixed.
  //
  // This runs the instant the renderer loads, which routinely races
  // spawnBackend() in main.js -- the backend does background-memory setup
  // before it ever calls app.listen(), so the very first fetch attempt on
  // a normal launch can hit a port nothing is listening on yet ("Failed to
  // fetch") well before anything is actually wrong. Retry a few times
  // before concluding it's really unreachable, so a normal launch doesn't
  // flash a false "not reachable" that only a manual Recheck would clear.
  (async () => {
    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { modelOk, whisperOk } = await runOnboardingChecks();
        if (!modelOk || !whisperOk) showOnboarding();
        return;
      } catch (e) {
        if (attempt === maxAttempts) { showOnboarding(); return; }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  })();

  init();
  // Resume whatever session was active last launch (id already survives in
  // localStorage) by replaying its most recent turns back into the chat log
  // -- otherwise a restart looks like history was lost even though it's
  // still on disk.
  loadInitialHistory(ensureSessionId());
})();

// Issue #362: consume the caption feed node-bot has been broadcasting on
// /ws/captions since caption-server.js landed. Purely additive -- if the
// socket never connects, everything else behaves exactly as before.
(function initCaptions() {
  try {
    if (typeof createCaptionClient !== "function") return;
    const el = document.getElementById("mana-captions");
    if (!el) return;
    createCaptionClient({
      onCaption: ({ text }) => {
        el.textContent = text;
        el.hidden = false;
      },
    }).connect();
  } catch (e) {
    // Captions must never take the conversation down with them.
  }
})();
