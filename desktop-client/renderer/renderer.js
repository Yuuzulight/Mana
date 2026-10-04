// nodeIntegration is off (see main.js) -- these come from plain classic
// <script> tags loaded before this one (see index_fixed.html), same as
// PIXI/Live2DCubismCore already do, not require().
const { createLive2dAvatar } = window.ManaLive2DAvatar;
const { detectReplyEmotion } = window.ManaReplyEmotion;
const { createDesktopStreamingChunkQueue } = window.ManaStreamingChunkQueue;

// Issue #500: theme toggle (applyTheme/THEME_STORAGE_KEY) moved to theme.js,
// loaded immediately before this file so it still runs at the same point in
// page load it always did. LISTENING_AUTOSTART_STORAGE_KEY/BARGE_IN_STORAGE_KEY
// stay here -- used throughout this file's own IIFE below, not part of the
// theme toggle.
const LISTENING_AUTOSTART_STORAGE_KEY = 'mana_listening_autostart';
const BARGE_IN_STORAGE_KEY = 'mana_barge_in_enabled';

// Issue #500: startup/shutdown overlay logic moved to startup-overlay.js,
// loaded immediately before this file so it still runs at the same point
// in page load it always did.

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
  const navProposalsBtnEl = document.getElementById('navProposalsBtn');
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
  const voiceCore = window.ManaVoiceCore.createVoiceCore({
    get AbortController() { return AbortController; },
    get appendMessage() { return appendMessage; },
    get BARGE_IN_STORAGE_KEY() { return BARGE_IN_STORAGE_KEY; },
    get bargeInCaptureCount() { return bargeInCaptureCount; },
    get chunks() { return chunks; },
    set chunks(value) { chunks = value; },
    get clearMessages() { return clearMessages; },
    get createSileroVad() { return createSileroVad; },
    get ensureSessionId() { return ensureSessionId; },
    get heldReply() { return heldReply; },
    set heldReply(value) { heldReply = value; },
    get LISTEN_PAUSE_MS() { return LISTEN_PAUSE_MS; },
    get listenGeneration() { return listenGeneration; },
    set listenGeneration(value) { listenGeneration = value; },
    get listening() { return listening; },
    set listening(value) { listening = value; },
    get MAX_UTTERANCE_MS() { return MAX_UTTERANCE_MS; },
    get MAX_WAIT_FOR_SPEECH_MS() { return MAX_WAIT_FOR_SPEECH_MS; },
    get mediaStream() { return mediaStream; },
    set mediaStream(value) { mediaStream = value; },
    get MIN_SPEECH_RMS() { return MIN_SPEECH_RMS; },
    get PARTIAL_TRANSCRIPT_POLL_MS() { return PARTIAL_TRANSCRIPT_POLL_MS; },
    get performance() { return performance; },
    get recorder() { return recorder; },
    set recorder(value) { recorder = value; },
    get replyInProgress() { return replyInProgress; },
    get selectedPresetId() { return selectedPresetId; },
    get setSprite() { return setSprite; },
    get shouldStopRecording() { return shouldStopRecording; },
    get SILENCE_BUFFER_MS() { return SILENCE_BUFFER_MS; },
    get SILENCE_METER_INTERVAL_MS() { return SILENCE_METER_INTERVAL_MS; },
    get sileroVad() { return sileroVad; },
    set sileroVad(value) { sileroVad = value; },
    get sileroVadLoadFailed() { return sileroVadLoadFailed; },
    set sileroVadLoadFailed(value) { sileroVadLoadFailed = value; },
    get speakStreamingReply() { return speakStreamingReply; },
    get statusEl() { return statusEl; },
    get VAD_DISABLED() { return VAD_DISABLED; },
    get VAD_FRAME_SAMPLES() { return VAD_FRAME_SAMPLES; },
    get VAD_MODEL_URL() { return VAD_MODEL_URL; },
    get VAD_SAMPLE_RATE() { return VAD_SAMPLE_RATE; },
    get VAD_THRESHOLD() { return VAD_THRESHOLD; },
  });
  function bargeInEnabled(...args) { return voiceCore.bargeInEnabled(...args); }

  let sileroVad = null;
  let sileroVadLoadFailed = false;
  let listening = false;

  function getSileroVad(...args) { return voiceCore.getSileroVad(...args); }

  function wait(...args) { return voiceCore.wait(...args); }

  function ensureMediaStream(...args) { return voiceCore.ensureMediaStream(...args); }

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

  const chatHistory = window.ManaChatHistory.createChatHistory({
    get CSS() { return CSS; },
    get currentSessionId() { return currentSessionId; },
    set currentSessionId(value) { currentSessionId = value; },
    get hasMoreHistory() { return hasMoreHistory; },
    set hasMoreHistory(value) { hasMoreHistory = value; },
    get historyLoadingEl() { return historyLoadingEl; },
    get loadingHistory() { return loadingHistory; },
    set loadingHistory(value) { loadingHistory = value; },
    get messageInputEl() { return messageInputEl; },
    get messagesEl() { return messagesEl; },
    get nextBeforeCursor() { return nextBeforeCursor; },
    set nextBeforeCursor(value) { nextBeforeCursor = value; },
    get SESSION_STORAGE_KEY() { return SESSION_STORAGE_KEY; },
    get sessionArtifacts() { return sessionArtifacts; },
    set sessionArtifacts(value) { sessionArtifacts = value; },
    get sessionListEl() { return sessionListEl; },
    get SESSIONS_API() { return SESSIONS_API; },
    get showView() { return showView; },
  });
  function makeSessionId(...args) { return chatHistory.makeSessionId(...args); }
  function ensureSessionId(...args) { return chatHistory.ensureSessionId(...args); }

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
  function renderBubbleContent(...args) { return chatHistory.renderBubbleContent(...args); }

  // Appends one new bubble to the live end of the conversation (a message
  // just sent or just replied to) -- as opposed to prependTurns() below,
  // which inserts older history at the top during scroll-back.
  function appendMessage(...args) { return chatHistory.appendMessage(...args); }

  function prependTurns(...args) { return chatHistory.prependTurns(...args); }

  function clearMessages(...args) { return chatHistory.clearMessages(...args); }

  function fetchHistoryPage(...args) { return chatHistory.fetchHistoryPage(...args); }

  function loadInitialHistory(...args) { return chatHistory.loadInitialHistory(...args); }

  // Scrolling near the top loads the next chunk further back in time.
  // Scroll position is preserved by measuring how much the content grew and
  // shifting scrollTop by exactly that -- otherwise prepending content above
  // the viewport yanks the view down to a random spot.
  function loadOlderMessages(...args) { return chatHistory.loadOlderMessages(...args); }

  function switchToSession(...args) { return chatHistory.switchToSession(...args); }

  function startNewChat(...args) { return chatHistory.startNewChat(...args); }

  function formatSessionDate(...args) { return chatHistory.formatSessionDate(...args); }

  function beginInlineRename(...args) { return chatHistory.beginInlineRename(...args); }

  function renderSessionList(...args) { return chatHistory.renderSessionList(...args); }

  function refreshSessionList(...args) { return chatHistory.refreshSessionList(...args); }

  messagesEl?.addEventListener('scroll', () => {
    if (messagesEl.scrollTop < 80) loadOlderMessages();
  });

  // Issue #253: preferredExpression is the model's own expression__set tool
  // choice for this reply (from the /reply or /transcribe response's
  // `expression` field, if any) -- passed alongside the automatically-
  // detected state, not instead of it.
  const voicePlayback = window.ManaVoicePlayback.createVoicePlayback({
    get activeStreamingQueue() { return activeStreamingQueue; },
    set activeStreamingQueue(value) { activeStreamingQueue = value; },
    get BARGE_IN_HOLD_MS() { return BARGE_IN_HOLD_MS; },
    get BARGE_IN_MIN_DBFS() { return BARGE_IN_MIN_DBFS; },
    get BARGE_IN_POLL_MS() { return BARGE_IN_POLL_MS; },
    get bargeInCaptureCount() { return bargeInCaptureCount; },
    set bargeInCaptureCount(value) { bargeInCaptureCount = value; },
    get bargeInEnabled() { return bargeInEnabled; },
    get bargeInMonitor() { return bargeInMonitor; },
    set bargeInMonitor(value) { bargeInMonitor = value; },
    get createDesktopStreamingChunkQueue() { return createDesktopStreamingChunkQueue; },
    get currentChunkSource() { return currentChunkSource; },
    set currentChunkSource(value) { currentChunkSource = value; },
    get dbfsFromSamples() { return dbfsFromSamples; },
    get desktopReplyPlaybackToken() { return desktopReplyPlaybackToken; },
    set desktopReplyPlaybackToken(value) { desktopReplyPlaybackToken = value; },
    get detectReplyEmotion() { return detectReplyEmotion; },
    get ensureMediaStream() { return ensureMediaStream; },
    get getSileroVad() { return getSileroVad; },
    get handleTranscriptText() { return handleTranscriptText; },
    get heldReply() { return heldReply; },
    set heldReply(value) { heldReply = value; },
    get live2dAvatar() { return live2dAvatar; },
    get mediaStream() { return mediaStream; },
    get nextBargeInState() { return nextBargeInState; },
    get performance() { return performance; },
    get readNdjsonEvents() { return readNdjsonEvents; },
    get recordUntilSilence() { return recordUntilSilence; },
    get replyInProgress() { return replyInProgress; },
    set replyInProgress(value) { replyInProgress = value; },
    get setSprite() { return setSprite; },
    get startLipSync() { return startLipSync; },
    get stopLipSync() { return stopLipSync; },
    get transcribeBlob() { return transcribeBlob; },
    get VAD_FRAME_SAMPLES() { return VAD_FRAME_SAMPLES; },
    get VAD_SAMPLE_RATE() { return VAD_SAMPLE_RATE; },
    get wait() { return wait; },
  });
  function speakReply(...args) { return voicePlayback.speakReply(...args); }

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
  function synthesizeAndDecodeChunk(...args) { return voicePlayback.synthesizeAndDecodeChunk(...args); }

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
  function watchForBargeIn(...args) { return voicePlayback.watchForBargeIn(...args); }

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

  function playDecodedChunk(...args) { return voicePlayback.playDecodedChunk(...args); }

  let desktopReplyPlaybackToken = 0;
  // Set for the full duration of speakStreamingReply -- the /reply/stream
  // fetch, every streamed chunk's synthesis/playback, and (if the streamed
  // draft turned out stale) the speakReply fallback it awaits before
  // returning. listenLoop's gate below reads this to avoid starting a new
  // recording while Mana is still talking, e.g. if push-to-talk is used
  // while continuous listening is also toggled on.
  let replyInProgress = false;

  function stopStreamingReply(...args) { return voicePlayback.stopStreamingReply(...args); }

  // Sub-project B: re-speaks a held reply's remaining sentences from the cut
  // point, reusing the same one-ahead synthesize/play queue
  // speakStreamingReply uses -- not a new playback primitive, just a second
  // entry point into it, sourced from the held array instead of an NDJSON
  // stream. Held state is text only; this re-synthesizes rather than
  // replaying cached audio.
  function resumeHeldReply(...args) { return voicePlayback.resumeHeldReply(...args); }

  function classifyBargeInText(...args) { return voicePlayback.classifyBargeInText(...args); }

  // Acts on a classified interruption against the currently-held reply.
  // `heldReply` must already be set (non-null) when this is called for the
  // non-nested path -- see handleDesktopBargeInTrigger.
  function handleDesktopBargeInInterruption(...args) { return voicePlayback.handleDesktopBargeInInterruption(...args); }

  // Fired from watchForBargeIn's onTrigger once a trigger holds for
  // BARGE_IN_HOLD_MS (the caller has already stopped the audible playback by
  // this point -- see playDecodedChunk/speakReply's watchForBargeIn call
  // sites). Captures the current reply's not-yet-played sentences, records
  // the interruption immediately, transcribes and classifies it, then
  // dispatches to resume/discard/insert.
  function handleDesktopBargeInTrigger(...args) { return voicePlayback.handleDesktopBargeInTrigger(...args); }

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
  function speakStreamingReply(...args) { return voicePlayback.speakStreamingReply(...args); }

  const desktopUI = window.ManaDesktopUI.createDesktopUI({
    get _prevSpriteState() { return _prevSpriteState; },
    set _prevSpriteState(value) { _prevSpriteState = value; },
    get createLive2dAvatar() { return createLive2dAvatar; },
    get doctorBubbleEl() { return doctorBubbleEl; },
    get doctorBubbleMessageEl() { return doctorBubbleMessageEl; },
    get doctorBubbleTitleEl() { return doctorBubbleTitleEl; },
    get fetchAvatarBtnEl() { return fetchAvatarBtnEl; },
    get homeViewEl() { return homeViewEl; },
    get lipSyncRafId() { return lipSyncRafId; },
    set lipSyncRafId(value) { lipSyncRafId = value; },
    get LISTENING_AUTOSTART_STORAGE_KEY() { return LISTENING_AUTOSTART_STORAGE_KEY; },
    get live2dAvatar() { return live2dAvatar; },
    set live2dAvatar(value) { live2dAvatar = value; },
    get live2dCanvas() { return live2dCanvas; },
    get logsEl() { return logsEl; },
    get navHomeBtnEl() { return navHomeBtnEl; },
    get navInfoBodyEl() { return navInfoBodyEl; },
    get navInfoModalEl() { return navInfoModalEl; },
    get navInfoTitleEl() { return navInfoTitleEl; },
    get navSettingsBtnEl() { return navSettingsBtnEl; },
    get onboardDetailsEl() { return onboardDetailsEl; },
    get onboardTextEl() { return onboardTextEl; },
    get sessionsViewEl() { return sessionsViewEl; },
    get settingsViewEl() { return settingsViewEl; },
    get setupAvatarDetailEl() { return setupAvatarDetailEl; },
    get setupAvatarIconEl() { return setupAvatarIconEl; },
    get setupModelActionsEl() { return setupModelActionsEl; },
    get setupModelDetailEl() { return setupModelDetailEl; },
    get setupModelIconEl() { return setupModelIconEl; },
    get setupModelScanResultsEl() { return setupModelScanResultsEl; },
    get setupRecording() { return setupRecording; },
    get setupWhisperDetailEl() { return setupWhisperDetailEl; },
    get setupWhisperIconEl() { return setupWhisperIconEl; },
    get startListening() { return startListening; },
    get statusEl() { return statusEl; },
  });
  function init(...args) { return desktopUI.init(...args); }

  // Live2D speaks a richer state vocabulary (idle/talking/excited/angry/
  // sad/disgusted) than the simple state names used elsewhere in this file
  // (idle/listening/speaking/excited); this maps those onto the closest
  // Live2D one for the generic (non-reply) cases. A reply's actual detected
  // emotion (see onRecordingStop) overrides this afterward.
  function live2dStateFor(...args) { return desktopUI.live2dStateFor(...args); }

  function initLive2dAvatar(...args) { return desktopUI.initLive2dAvatar(...args); }

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
  function setSprite(...args) { return desktopUI.setSprite(...args); }

  function startLoadingAnimation(...args) { return desktopUI.startLoadingAnimation(...args); }
  function stopLoadingAnimation(...args) { return desktopUI.stopLoadingAnimation(...args); }

  // Lip sync: sample the playing reply audio's RMS amplitude and forward it
  // to the Live2D avatar's mouth parameter. No-op when Live2D isn't loaded.
  let lipSyncRafId = null;
  function stopLipSync(...args) { return desktopUI.stopLipSync(...args); }
  function startLipSync(...args) { return desktopUI.startLipSync(...args); }

  function setupRecording(...args) { return voiceCore.setupRecording(...args); }

  function startRecording(...args) { return voiceCore.startRecording(...args); }

  function stopRecording(...args) { return voiceCore.stopRecording(...args); }

  // Issue #331: transcription and reply generation are now two calls
  // instead of one -- /transcribe-only has no streaming equivalent (it's a
  // plain multipart upload), so it just gets the transcript; the reply
  // itself goes through /reply/stream (via speakStreamingReply) the same
  // way sendTextMessage's does, so voice replies get the same
  // early-audio-start pipelining as typed ones.
  function transcribeBlob(...args) { return voiceCore.transcribeBlob(...args); }

  // Shared by handleVoiceTurn (push-to-talk/continuous-listening) and the
  // barge-in interruption dispatcher (Sub-project B) -- both end up with a
  // known transcript string and need the exact same reply-generation
  // handling.
  function handleTranscriptText(...args) { return voiceCore.handleTranscriptText(...args); }

  // Shared by push-to-talk (onRecordingStop) and continuous listening
  // (listenLoop) -- both produce a recorded utterance as a Blob and need
  // the exact same transcribe-then-reply handling.
  function handleVoiceTurn(...args) { return voiceCore.handleVoiceTurn(...args); }

  function onRecordingStop(...args) { return voiceCore.onRecordingStop(...args); }

  // Continuous listening (issue #135 port): records one utterance at a
  // time, using Silero VAD (falling back to a plain RMS threshold if the
  // model failed to load) to detect when the user has stopped talking,
  // instead of requiring a held-down button. Uses local recorder/chunks
  // variables rather than the module-scope ones startRecording/stopRecording
  // use above -- push-to-talk and continuous listening must not share
  // mutable state, since a user could in principle trigger both at once.
  function recordUntilSilence(...args) { return voiceCore.recordUntilSilence(...args); }

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

  function listenLoop(...args) { return voiceCore.listenLoop(...args); }

  function startListening(...args) { return voiceCore.startListening(...args); }

  function stopListening(...args) { return voiceCore.stopListening(...args); }

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
  function showView(...args) { return desktopUI.showView(...args); }
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

  function escapeHtml(...args) { return desktopUI.escapeHtml(...args); }

  // Doctor issue detail popover: cards show just the label, click one to
  // see the full message in a small bubble anchored to it. position:fixed
  // (see style.css) so it's placed relative to the viewport, not clipped
  // by navInfoBody's own overflow-y:auto scroll area.
  const doctorBubbleEl = document.getElementById('doctorBubble');
  const doctorBubbleTitleEl = doctorBubbleEl?.querySelector('.doctor-bubble-title');
  const doctorBubbleMessageEl = doctorBubbleEl?.querySelector('.doctor-bubble-message');
  function showDoctorBubble(...args) { return desktopUI.showDoctorBubble(...args); }
  function hideDoctorBubble(...args) { return desktopUI.hideDoctorBubble(...args); }
  document.addEventListener('click', (e) => {
    if (!doctorBubbleEl || doctorBubbleEl.hidden) return;
    if (!doctorBubbleEl.contains(e.target) && !e.target.closest('.doctor-issue')) {
      hideDoctorBubble();
    }
  });

  function openNavInfo(...args) { return desktopUI.openNavInfo(...args); }
  function closeNavInfo(...args) { return desktopUI.closeNavInfo(...args); }
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
    const reviewBtn = e.target.closest('.proposal-review-btn');
    if (reviewBtn) openProposalReview(reviewBtn.dataset.proposalId);
    if (e.target.closest('#proposalReviewBackBtn')) refreshProposalsPanel();
    if (e.target.closest('#proposalReviewApproveBtn')) approveSelectedProposalHunks();
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

  // Issue #427: hunk-level accept/reject for editor-handoff diff proposals,
  // from whichever editor was connected -- generic, not Zed-specific.
  let currentProposalReviewId = null;

  function hunkLineClass(line) {
    const prefix = line.charAt(0);
    return prefix === '+' ? 'hunk-line-add' : prefix === '-' ? 'hunk-line-del' : 'hunk-line-ctx';
  }

  function renderProposalsPanel(proposals) {
    currentProposalReviewId = null;
    const pending = proposals.filter((p) => p.status === 'pending');
    if (!pending.length) {
      navInfoBodyEl.innerHTML = '<p class="subtitle">No pending edits.</p>';
      return;
    }
    navInfoBodyEl.innerHTML = `
      <p class="subtitle">Diff proposals from a connected editor wait here for review -- accept or reject individual hunks before anything is written.</p>
      ${pending.map((p) => `
        <div class="snapshot-item">
          <div class="snapshot-item-info">
            <div class="snapshot-item-path">${escapeHtml(p.relativePath || '(unknown file)')}</div>
            <div class="snapshot-item-meta">${escapeHtml(p.summary || 'Edit')} · ${p.hunkCount || 0} hunk${p.hunkCount === 1 ? '' : 's'}</div>
          </div>
          <button type="button" class="proposal-review-btn primary" data-proposal-id="${escapeHtml(p.id)}">Review</button>
        </div>`).join('')}
    `;
  }

  async function refreshProposalsPanel() {
    openNavInfo('Pending edits', '<p class="subtitle">Loading...</p>');
    try {
      const result = await fetchJson(`${BACKEND_URL}/editors/workspace/proposals`);
      renderProposalsPanel(result.proposals || []);
    } catch (e) {
      navInfoBodyEl.innerHTML = `<p class="subtitle">Failed to reach backend: ${escapeHtml(e.message)}</p>`;
    }
  }

  navProposalsBtnEl?.addEventListener('click', () => {
    refreshProposalsPanel();
  });

  async function openProposalReview(id) {
    try {
      const result = await fetchJson(`${BACKEND_URL}/editors/workspace/proposals/${encodeURIComponent(id)}`);
      const proposal = result.proposal;
      currentProposalReviewId = proposal.id;
      navInfoBodyEl.innerHTML = `
        <button type="button" id="proposalReviewBackBtn" class="primary">&larr; Back</button>
        <div id="proposalReviewPath">${escapeHtml(proposal.relativePath || '')}</div>
        <p class="subtitle">${escapeHtml(proposal.summary || '')}</p>
        ${(proposal.hunks || []).map((h) => `
          <div class="hunk-card">
            <label class="hunk-card-header">
              <input type="checkbox" class="hunk-accept-checkbox" data-hunk-id="${escapeHtml(h.id)}" checked />
              Accept this hunk (line ${h.newStart})
            </label>
            <pre class="hunk-diff">${h.lines.map((line) => `<span class="${hunkLineClass(line)}">${escapeHtml(line)}</span>`).join('\n')}</pre>
          </div>`).join('')}
        <button type="button" id="proposalReviewApproveBtn" class="primary">Approve selected hunks</button>
      `;
    } catch (e) {
      navInfoBodyEl.innerHTML = `<p class="subtitle">Failed to reach backend: ${escapeHtml(e.message)}</p>`;
    }
  }

  async function approveSelectedProposalHunks() {
    if (!currentProposalReviewId) return;
    const acceptedHunkIds = [...navInfoBodyEl.querySelectorAll('.hunk-accept-checkbox')]
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.dataset.hunkId);
    try {
      const result = await fetchJson(
        `${BACKEND_URL}/editors/workspace/proposals/${encodeURIComponent(currentProposalReviewId)}/approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ acceptedHunkIds }),
        },
      );
      if (!result.proposal) throw new Error('Approve failed');
      await refreshProposalsPanel();
    } catch (e) {
      console.warn('Mana proposal approve failed:', e);
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

  const desktopSettings = window.ManaDesktopSettings.createDesktopSettings({
    get BACKEND_URL() { return BACKEND_URL; },
    get basename() { return basename; },
    get brainApiKeyEl() { return brainApiKeyEl; },
    get brainBaseUrlEl() { return brainBaseUrlEl; },
    get brainModelEl() { return brainModelEl; },
    get brainProviderFieldsEl() { return brainProviderFieldsEl; },
    get brainProviderPresets() { return brainProviderPresets; },
    set brainProviderPresets(value) { brainProviderPresets = value; },
    get brainProviderSelectEl() { return brainProviderSelectEl; },
    get editingPresetId() { return editingPresetId; },
    set editingPresetId(value) { editingPresetId = value; },
    get editingSkillName() { return editingSkillName; },
    set editingSkillName(value) { editingSkillName = value; },
    get escapeHtml() { return escapeHtml; },
    get fetchJson() { return fetchJson; },
    get latestMemoryFacts() { return latestMemoryFacts; },
    set latestMemoryFacts(value) { latestMemoryFacts = value; },
    get latestPresets() { return latestPresets; },
    set latestPresets(value) { latestPresets = value; },
    get latestSkills() { return latestSkills; },
    set latestSkills(value) { latestSkills = value; },
    get memoryFactsListEl() { return memoryFactsListEl; },
    get memorySearchInputEl() { return memorySearchInputEl; },
    get modelClearBtnEl() { return modelClearBtnEl; },
    get modelCurrentEl() { return modelCurrentEl; },
    get PRESET_STORAGE_KEY() { return PRESET_STORAGE_KEY; },
    get presetDeleteBtnEl() { return presetDeleteBtnEl; },
    get presetEditBtnEl() { return presetEditBtnEl; },
    get presetEditorEl() { return presetEditorEl; },
    get presetInstructionsInputEl() { return presetInstructionsInputEl; },
    get presetNameInputEl() { return presetNameInputEl; },
    get presetSelectEl() { return presetSelectEl; },
    get selectedPresetId() { return selectedPresetId; },
    set selectedPresetId(value) { selectedPresetId = value; },
    get selectedSkillName() { return selectedSkillName; },
    set selectedSkillName(value) { selectedSkillName = value; },
    get SKILL_WRITE_ACTION_TYPES() { return SKILL_WRITE_ACTION_TYPES; },
    get skillBodyInputEl() { return skillBodyInputEl; },
    get skillDescriptionInputEl() { return skillDescriptionInputEl; },
    get skillNameInputEl() { return skillNameInputEl; },
    get skillsDeleteBtnEl() { return skillsDeleteBtnEl; },
    get skillsEditBtnEl() { return skillsEditBtnEl; },
    get skillsEditorEl() { return skillsEditorEl; },
    get skillsPendingEl() { return skillsPendingEl; },
    get skillsPendingListEl() { return skillsPendingListEl; },
    get skillsSelectEl() { return skillsSelectEl; },
    get skillsStatusEl() { return skillsStatusEl; },
    get useRemoteAiToggleEl() { return useRemoteAiToggleEl; },
    get visionMmprojPathEl() { return visionMmprojPathEl; },
    get visionModelPathEl() { return visionModelPathEl; },
    get visionModelStatusEl() { return visionModelStatusEl; },
  });
  function setSelectedPresetId(...args) { return desktopSettings.setSelectedPresetId(...args); }

  function renderPresetSelect(...args) { return desktopSettings.renderPresetSelect(...args); }

  function refreshPresetList(...args) { return desktopSettings.refreshPresetList(...args); }

  function closePresetEditor(...args) { return desktopSettings.closePresetEditor(...args); }

  function openPresetEditor(...args) { return desktopSettings.openPresetEditor(...args); }

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

  function setSkillsStatus(...args) { return desktopSettings.setSkillsStatus(...args); }

  function setSelectedSkillName(...args) { return desktopSettings.setSelectedSkillName(...args); }

  function renderSkillsSelect(...args) { return desktopSettings.renderSkillsSelect(...args); }

  function renderPendingSkills(...args) { return desktopSettings.renderPendingSkills(...args); }

  function decidePendingSkill(...args) { return desktopSettings.decidePendingSkill(...args); }

  function refreshPendingSkills(...args) { return desktopSettings.refreshPendingSkills(...args); }

  function refreshSkillsList(...args) { return desktopSettings.refreshSkillsList(...args); }
  refreshSkillsList();
  // A proposal (idle or from elsewhere) can land while Settings just sits
  // open -- poll the lightweight pending-only endpoint so it shows up
  // without requiring a local save/delete/decide action first.
  setInterval(refreshPendingSkills, 15000);

  function closeSkillEditor(...args) { return desktopSettings.closeSkillEditor(...args); }

  function openSkillEditor(...args) { return desktopSettings.openSkillEditor(...args); }

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

  // Plugins (Settings > Plugins): optional integrations -- FFXIV Market, etc.
  // Watch, stock market, job search -- toggled per plugin, backed by
  // node-bot's new dual-tier plugin store API via GET/POST /plugins/store.
  const pluginsUI = window.ManaPlugins.createPluginsUI({
    get BACKEND_URL() { return BACKEND_URL; },
    get escapeHtml() { return escapeHtml; },
    get fetchJson() { return fetchJson; },
    get pluginsListEl() { return pluginsListEl; },
  });
  function loadPlugins(...args) { return pluginsUI.loadPlugins(...args); }

  // Plugin details modal (#499): opened from each row's button. Always
  // refetches so install/uninstall state is never stale; buttons are wired
  // with listeners because inline onclick can't see this closure's functions.
  function showPluginDetails(...args) { return pluginsUI.showPluginDetails(...args); }

  function hidePluginDetails(...args) { return pluginsUI.hidePluginDetails(...args); }

  pluginsListEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('.plugin-details-btn');
    if (btn) showPluginDetails(btn.dataset.plugin);
  });

  // Close on a click on the backdrop itself (not inside the dialog) or Escape.
  document.addEventListener('click', (e) => {
    if (e.target.id === 'pluginDetailsModal') hidePluginDetails();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePluginDetails();
  });

  // Install new plugin from GitHub or local file
  function installPlugin(...args) { return pluginsUI.installPlugin(...args); }

  // Show status message in the plugins section
  function setPluginsStatus(...args) { return pluginsUI.setPluginsStatus(...args); }

  // Install button handler (can be wired from the UI)
  window.installPlugin = installPlugin;
  loadPlugins();

  // Memory (Settings > Memory, issue #324): browse/manage acp-memory-store's
  // remembered facts (memory__remember), including the unverifiedSource flag
  // from issue #317 -- previously only inspectable by reading facts.json by
  // hand. Mirrors the Plugins panel above.
  const memoryFactsListEl = document.getElementById('memoryFactsList');
  const memorySearchInputEl = document.getElementById('memorySearchInput');
  let latestMemoryFacts = [];

  function renderMemoryFactsList(...args) { return desktopSettings.renderMemoryFactsList(...args); }

  function loadMemoryFacts(...args) { return desktopSettings.loadMemoryFacts(...args); }
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
  function formatModelBytes(...args) { return desktopSettings.formatModelBytes(...args); }

  function renderModelScanList(...args) { return desktopSettings.renderModelScanList(...args); }

  function selectModelPath(...args) { return desktopSettings.selectModelPath(...args); }

  function loadModelSettings(...args) { return desktopSettings.loadModelSettings(...args); }

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

  function loadBrainProviderPresets(...args) { return desktopSettings.loadBrainProviderPresets(...args); }

  // Only overwrite the brain/vision fields with what the backend has stored
  // when the user isn't actively mid-edit, since this polls alongside the
  // rest of Settings.
  function loadBrainAndVisionSettings(...args) { return desktopSettings.loadBrainAndVisionSettings(...args); }

  function toggleBrainProviderFields(...args) { return desktopSettings.toggleBrainProviderFields(...args); }
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

  function browseAndSetVisionField(...args) { return desktopSettings.browseAndSetVisionField(...args); }
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
  // Issue #500: compare-mode UI logic (state, DOM wiring, the actual
  // compare fetch/run flow) moved to compare-mode-ui.js, loaded immediately
  // before this file. window.ManaCompareModeUI is that file's own exposed
  // handoff for the Enter-key handler below.
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
    if (window.ManaCompareModeUI?.isActive()) window.ManaCompareModeUI.run();
    else sendTextMessage();
  });

  // First-run setup wizard (issue #123). Structured per-item status instead
  // of a raw /doctor JSON dump, and shown whenever the local model or
  // Whisper genuinely aren't set up yet -- not a one-time "seen it" flag,
  // so it keeps helping until the thing it's nudging about is actually
  // fixed, then stays out of the way for good.
  function showOnboarding(...args) { return desktopUI.showOnboarding(...args); }
  function hideOnboarding(...args) { return desktopUI.hideOnboarding(...args); }
  function setSetupStatus(...args) { return desktopUI.setSetupStatus(...args); }
  function basename(...args) { return desktopUI.basename(...args); }

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

  function runOnboardingChecks(...args) { return desktopUI.runOnboardingChecks(...args); }

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

// Issue #500: captions init (issue #362) moved to caption-init.js, loaded
// immediately after this file so it still runs at the same point in page
// load it always did.
