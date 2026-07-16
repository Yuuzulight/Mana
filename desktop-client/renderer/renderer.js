const { createLive2dAvatar } = require('../avatar/live2d-avatar');
const { detectReplyEmotion } = require('./reply-emotion');
const { formatCompareProfileLabel, pickDefaultCompareProfiles } = require('./compare-mode');

(async function(){
  const statusEl = document.getElementById('status');
  const transcriptEl = document.getElementById('transcript');
  const replyEl = document.getElementById('reply');
  const logsEl = document.getElementById('backendLogs');
  const spriteEl = document.getElementById('sprite');
  const live2dCanvas = document.getElementById('live2dCanvas');
  const avatarZoomBtn = document.getElementById('btnAvatarZoom');
  const avatarNoticeLink = document.getElementById('avatarNoticeLink');
  const messageInputEl = document.getElementById('messageInput');
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

  let mediaStream = null;
  let recorder = null;
  let chunks = [];
  let live2dAvatar = null;

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
  // sad/disgusted) than the small header/input-bar PNG sprites do
  // (idle/listening/speaking/excited); this maps the sprite's states onto
  // the closest Live2D one for the generic (non-reply) cases. A reply's
  // actual detected emotion (see onRecordingStop) overrides this afterward.
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
      console.warn('Live2D avatar failed to load; using sprite avatar:', e);
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
    // handle transient excited state which should hop but keep the underlying sprite (idle/speaking)
    if (state === 'excited'){
      // keep previous visual (or default to idle)
      const base = _prevSpriteState || 'idle';
      spriteEl.className = 'sprite ' + base + ' excited';
      if (live2dAvatar) live2dAvatar.setState('excited');
      // remove excited after a few hops (duration * iterations)
      const durationMs = 320; // must match CSS animation-duration
      const iterations = 5; // number of hops
      setTimeout(()=>{
        // restore to base state
        spriteEl.className = 'sprite ' + base;
        if (live2dAvatar) live2dAvatar.setState(live2dStateFor(base));
      }, durationMs * iterations);
      return;
    }
    _prevSpriteState = state || 'idle';
    spriteEl.className = 'sprite ' + _prevSpriteState;
    if (live2dAvatar) live2dAvatar.setState(live2dStateFor(_prevSpriteState));
  }

  // Loading animation (cycles the three loading sprites)
  let _loadingInterval = null;
  let _loadingIndex = 0;
  function startLoadingAnimation(){
    if (_loadingInterval) return;
    _loadingIndex = 0;
    // set initial loading sprite
    try { spriteEl.style.backgroundImage = `url('../../sprites/sprite-loading-${_loadingIndex+1}.png')`; } catch(e){}
    _loadingInterval = setInterval(()=>{
      _loadingIndex = (_loadingIndex + 1) % 3;
      try { spriteEl.style.backgroundImage = `url('../../sprites/sprite-loading-${_loadingIndex+1}.png')`; } catch(e){}
    }, 300);
    statusEl.textContent = 'Backend starting...';
  }
  function stopLoadingAnimation(){
    if (!_loadingInterval) return;
    clearInterval(_loadingInterval);
    _loadingInterval = null;
    _loadingIndex = 0;
    // restore to current base sprite
    try { spriteEl.style.backgroundImage = ''; } catch(e){}
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
    if (live2dAvatar) live2dAvatar.setMouthTarget(0);
  }
  function startLipSync(audioCtx, sourceNode){
    if (!live2dAvatar) return;
    try {
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      sourceNode.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
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
          live2dAvatar.setMouthTarget(rms);
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
    clearBtn.addEventListener('click', ()=>{ transcriptEl.textContent=''; replyEl.textContent=''; });
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
      // send to /transcribe-only or /transcribe
      const form = new FormData();
      form.append('file', blob, 'voice.webm');
      const resp = await fetch('http://127.0.0.1:5005/transcribe', { method: 'POST', body: form });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error('transcribe failed: ' + resp.status + ' ' + txt);
      }
      const j = await resp.json().catch(()=>null);
      // show transcript or reply
      if (j && j.transcript) transcriptEl.textContent = j.transcript;
      else if (j && j.reply) transcriptEl.textContent = j.reply;
      else transcriptEl.textContent = JSON.stringify(j);

      // if reply present, show and optionally synthesize
      if (j && j.reply) {
        replyEl.textContent = j.reply;
        setSprite('speaking');
        if (live2dAvatar) live2dAvatar.setState(detectReplyEmotion(j.reply));
        try {
          const sresp = await fetch('http://127.0.0.1:5005/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: j.reply }) });
          if (sresp.ok) {
            const arr = await sresp.arrayBuffer();
            const audioCtx = new AudioContext();
            const buf = await audioCtx.decodeAudioData(arr);
            const src = audioCtx.createBufferSource();
            src.buffer = buf;
            src.connect(audioCtx.destination);
            src.onended = ()=> { stopLipSync(); setSprite('idle'); };
            src.start();
            startLipSync(audioCtx, src);
          } else {
            setSprite('idle');
          }
        } catch (e) { setSprite('idle'); }
      }

      statusEl.textContent = 'Idle';
    } catch (e){
      statusEl.textContent = 'Error';
      await window.electronAPI.showError(String(e));
      setSprite('idle');
    }
  }

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

  // desktop-client has no existing text-send flow to hook into (messageInput
  // is otherwise unwired), so Enter only does anything here while Compare
  // mode is active -- it's not stealing behavior from anything else.
  messageInputEl?.addEventListener('keydown', (event) => {
    if (compareModeActive && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      runCompare();
    }
  });

  refreshCompareModelStatus();

  // Onboarding helpers
  function showOnboarding(details){
    const modal = document.getElementById('onboardingModal');
    const text = document.getElementById('onboardText');
    const detailsEl = document.getElementById('onboardDetails');
    text.textContent = 'System check results:';
    detailsEl.textContent = details.join('\n');
    modal.setAttribute('aria-hidden','false');
  }
  function hideOnboarding(){
    const modal = document.getElementById('onboardingModal');
    modal.setAttribute('aria-hidden','true');
  }

  document.getElementById('dismissOnboarding').addEventListener('click', ()=>{ localStorage.setItem('mana_seen_onboarding','1'); hideOnboarding(); });
  document.getElementById('openDocsBtn').addEventListener('click', async ()=>{ try{ await window.electronAPI.openDocs(); } catch(e){ window.open('../BUILD_DESKTOP.md','_blank'); } });
  document.getElementById('runDoctorBtn').addEventListener('click', ()=>{ runOnboardingChecks(); });

  async function runOnboardingChecks(){
    const details = [];
    try{
      const resp = await fetch('http://127.0.0.1:5005/doctor');
      if (resp.ok){
        const j = await resp.json();
        details.push(JSON.stringify(j,null,2));
      } else {
        details.push('Doctor endpoint not reachable (backend may not be running).');
      }
    } catch (e){
      details.push('Doctor check failed: ' + (e.message || e));
    }
    showOnboarding(details);
  }

  // show onboarding if not seen
  try{
    const seen = localStorage.getItem('mana_seen_onboarding');
    if (!seen){
      // run checks but still init app
      runOnboardingChecks().catch(()=>{});
    }
  }catch(e){}

  init();
})();
