// nodeIntegration is off (see main.js) -- these come from plain classic
// <script> tags loaded before this one (see index_fixed.html), same as
// PIXI/Live2DCubismCore already do, not require().
const { createLive2dAvatar } = window.ManaLive2DAvatar;
const { detectReplyEmotion } = window.ManaReplyEmotion;
const { formatCompareProfileLabel, pickDefaultCompareProfiles } = window.ManaCompareMode;

// Theme (Settings > Appearance): applied at the top level, before the async
// IIFE below does anything else, so there's no flash of the wrong theme
// while backend calls are still in flight. "System" (the default) just
// means no data-theme attribute -- style.css's prefers-color-scheme media
// query is then the only source of truth; Light/Dark set the attribute,
// which wins over that media query regardless of the OS setting (see the
// :root[data-theme] rules in style.css).
const THEME_STORAGE_KEY = 'manaTheme';
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

  // Renders `text` as sanitized markdown into `div`, and -- if a big or
  // ```html fenced block is found (issue #148) -- replaces it with a
  // button that opens the full content in its own window instead of
  // dominating the bubble.
  function renderBubbleContent(div, text) {
    const artifact = window.electronAPI.extractArtifact(text);
    const displayText = artifact ? text.replace(artifact.matchedText, '').trim() : text;
    div.innerHTML = window.electronAPI.renderMarkdownToSafeHtml(displayText);

    if (artifact) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-artifact-open';
      button.textContent = `Open ${artifact.language} content in new window`;
      button.addEventListener('click', () => window.electronAPI.openArtifact(artifact));
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
    renderBubbleContent(div, text);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function prependTurns(turns) {
    if (!messagesEl || !turns || !turns.length) return;
    const frag = document.createDocumentFragment();
    for (const turn of turns) {
      if (turn.user) {
        const u = document.createElement('div');
        u.className = 'message system';
        renderBubbleContent(u, turn.user);
        frag.appendChild(u);
      }
      if (turn.assistant) {
        const a = document.createElement('div');
        a.className = 'message assistant';
        renderBubbleContent(a, turn.assistant);
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
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(audioCtx.destination);
        src.onended = () => { stopLipSync(); setSprite('idle'); };
        src.start();
        startLipSync(audioCtx, src);
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

  function playDecodedChunk(audioCtx, audioBuffer, text) {
    return new Promise((resolve) => {
      setSprite('speaking');
      if (live2dAvatar) live2dAvatar.setState(detectReplyEmotion(text));
      const src = audioCtx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(audioCtx.destination);
      src.onended = () => { stopLipSync(); resolve(); };
      src.start();
      startLipSync(audioCtx, src);
    });
  }

  let desktopReplyPlaybackToken = 0;

  function stopStreamingReply() {
    desktopReplyPlaybackToken += 1;
  }

  // Same pushChunk/markDone/cancelPending/run shape as windows-launcher's
  // createStreamingChunkQueue (Task 4), adapted to this app's synthesize-
  // then-decode-then-play primitives instead of blob-based Audio elements.
  // Kept as a near-duplicate rather than a shared module, matching how
  // desktop-client and windows-launcher already each define their own
  // stopLipSync/startLipSync rather than sharing one.
  //
  // cancelPending() only drops chunks that haven't started synthesizing or
  // playing yet -- whatever's already in flight (synthesizing or mid-
  // playback) always finishes naturally. Unlike windows-launcher's <audio>
  // element (where a mid-chunk pause() can leave a playback promise waiting
  // on an "ended" event that never fires), a BufferSourceNode here is never
  // stopped early at all -- playDecodedChunk's promise only ever resolves
  // via the node's own onended, so there's no abrupt cut and no equivalent
  // hang risk to design around. cancelPending() just stops new chunks from
  // being queued/started after the one already running.
  function createDesktopStreamingChunkQueue(playbackToken, audioCtx) {
    const pending = [];
    let waiter = null;
    let closed = false;

    function pushChunk(text) {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ text, done: false });
      } else {
        pending.push(text);
      }
    }

    function markDone() {
      closed = true;
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve({ text: null, done: true });
      }
    }

    function cancelPending() {
      pending.length = 0;
      markDone();
    }

    function nextChunk() {
      if (pending.length) return Promise.resolve({ text: pending.shift(), done: false });
      if (closed) return Promise.resolve({ text: null, done: true });
      return new Promise((resolve) => { waiter = resolve; });
    }

    async function synthesizeChunk(text) {
      try {
        return await synthesizeAndDecodeChunk(text, audioCtx);
      } catch (e) {
        console.warn('Speech synthesis failed for a streamed chunk:', e.message);
        return null;
      }
    }

    async function run() {
      let current = await nextChunk();
      if (current.done) return;
      let inFlight = synthesizeChunk(current.text);

      for (;;) {
        if (desktopReplyPlaybackToken !== playbackToken) return;
        const audioBuffer = await inFlight;
        if (desktopReplyPlaybackToken !== playbackToken) return;

        const next = await nextChunk();
        inFlight = next.done ? null : synthesizeChunk(next.text);

        if (audioBuffer) {
          await playDecodedChunk(audioCtx, audioBuffer, current.text);
        }

        if (next.done) {
          // Mirrors speakReply's own tail: reset to idle once the queue has
          // genuinely run out, but only if nothing else has taken over
          // playback in the meantime.
          if (desktopReplyPlaybackToken === playbackToken) setSprite('idle');
          return;
        }
        current = next;
      }
    }

    return { pushChunk, markDone, cancelPending, run };
  }

  // Replaces the fetch('/reply') -> res.json() -> speakReply flow at this
  // app's two reply call sites. Sentences arrive incrementally from POST
  // /reply/stream and are queued for TTS/playback as they arrive; on the
  // final event, if what was already streamed doesn't match the true final
  // reply (changed:true -- covers both "nothing streamed" and a
  // regeneration pass rewriting it), drop whatever's still queued but not
  // yet in flight and fall back to speakReply's synthesize-the-whole-thing-
  // at-once path once the in-flight chunk (if any) has finished.
  async function speakStreamingReply(requestBody) {
    stopStreamingReply();
    const playbackToken = desktopReplyPlaybackToken;
    const audioCtx = new AudioContext();
    const queue = createDesktopStreamingChunkQueue(playbackToken, audioCtx);
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
    }

    const result = finalEvent || { reply: '', ttsConfigured: false };

    if (desktopReplyPlaybackToken === playbackToken && result.changed && result.reply) {
      stopStreamingReply();
      await speakReply(result.reply, result.expression);
    }

    return result;
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
    setupRecording();
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

  async function onRecordingStop(){
    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    try{
      // Issue #331: transcription and reply generation are now two calls
      // instead of one -- /transcribe-only has no streaming equivalent
      // (it's a plain multipart upload), so it just gets the transcript;
      // the reply itself goes through /reply/stream (via
      // speakStreamingReply) the same way sendTextMessage's does, so voice
      // replies get the same early-audio-start pipelining as typed ones.
      const form = new FormData();
      form.append('file', blob, 'voice.webm');
      const resp = await fetch('http://127.0.0.1:5005/transcribe-only', { method: 'POST', body: form });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error('transcribe failed: ' + resp.status + ' ' + txt);
      }
      const j = await resp.json().catch(()=>null);
      if (j && j.transcript) appendMessage('user', j.transcript);
      else appendMessage('user', JSON.stringify(j));

      if (j && j.transcript) {
        const result = await speakStreamingReply({
          text: j.transcript,
          sessionId: ensureSessionId(),
          presetId: selectedPresetId || undefined,
        });
        if (result.error) throw new Error(result.error);
        if (result.reply) appendMessage('assistant', result.reply);
      }

      statusEl.textContent = 'Idle';
    } catch (e){
      statusEl.textContent = 'Error';
      await window.electronAPI.showError(String(e));
      setSprite('idle');
    }
  }

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
      const result = await speakStreamingReply({
        text,
        sessionId: ensureSessionId(),
        presetId: selectedPresetId || undefined,
      });
      // /reply/stream has no HTTP-level error status (always 200) -- errors
      // surface as an `error` field on the final event instead.
      if (result.error) throw new Error(result.error);
      if (result.reply) {
        appendMessage('assistant', result.reply);
      }
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
