(function(root) {
function createDesktopUI(context) {
async function init() {
    try {
      const st = await window.electronAPI.backendStatus();
      context.statusEl.textContent = st.running ? 'Backend running' : 'Backend not running';
      if (!st.running) startLoadingAnimation();
    } catch (e) { context.statusEl.textContent = 'Backend unknown'; startLoadingAnimation(); }

    // backend logs: append and use first log to stop loading animation
    window.electronAPI.backendLog((s)=>{ context.logsEl.textContent += s + '\n'; context.logsEl.scrollTop = context.logsEl.scrollHeight; stopLoadingAnimation();
      // also detect excite marker
      try{ if (String(s).includes('__MANA_EXCITE__')) setSprite('excited'); }catch(e){}
    });

    window.electronAPI.backendExit((info)=>{ context.statusEl.textContent = 'Backend exited'; startLoadingAnimation(); });

    initLive2dAvatar();
    // Finding 2: awaited so getUserMedia() has resolved and `mediaStream` is
    // set before the autostart check below can call startListening() -->
    // listenLoop() --> recordUntilSilence() --> ensureMediaStream(). Without
    // this, ensureMediaStream() could see mediaStream still null and open a
    // second, orphaned MediaStream (duplicate device capture, and
    // push-to-talk possibly ending up bound to a different stream than the
    // listen loop).
    await context.setupRecording();
    if (localStorage.getItem(context.LISTENING_AUTOSTART_STORAGE_KEY) === '1') {
      context.startListening();
    }
  }

function live2dStateFor(spriteState){
    if (spriteState === 'listening' || spriteState === 'speaking') return 'talking';
    return spriteState || 'idle';
  }

async function initLive2dAvatar(){
    if (!context.live2dCanvas) return;
    try {
      context.live2dAvatar = await context.createLive2dAvatar({
        canvas: context.live2dCanvas,
        width: context.live2dCanvas.clientWidth,
        height: context.live2dCanvas.clientHeight,
      });
      if (context.live2dAvatar) {
        context.live2dAvatar.setState(live2dStateFor(context._prevSpriteState));
      }
    } catch (e) {
      console.warn('Live2D avatar failed to load:', e);
    }
  }

function setSprite(state){
    // handle transient excited state, which should revert to the underlying
    // state (idle/speaking) after a beat
    if (state === 'excited'){
      const base = context._prevSpriteState || 'idle';
      if (context.live2dAvatar) context.live2dAvatar.setState('excited');
      const durationMs = 320;
      const iterations = 5;
      setTimeout(()=>{
        if (context.live2dAvatar) context.live2dAvatar.setState(live2dStateFor(base));
      }, durationMs * iterations);
      return;
    }
    context._prevSpriteState = state || 'idle';
    if (context.live2dAvatar) context.live2dAvatar.setState(live2dStateFor(context._prevSpriteState));
  }

function startLoadingAnimation(){
    context.statusEl.textContent = 'Backend starting...';
  }

function stopLoadingAnimation(){
    context.statusEl.textContent = 'Backend running';
  }

function stopLipSync(){
    if (context.lipSyncRafId !== null) {
      cancelAnimationFrame(context.lipSyncRafId);
      context.lipSyncRafId = null;
    }
    if (context.live2dAvatar) context.live2dAvatar.setMouthTarget(0, 0);
  }

function startLipSync(audioCtx, sourceNode){
    if (!context.live2dAvatar) return;
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
          context.live2dAvatar.setMouthTarget(rms, centroidHz, viseme);
        }
        context.lipSyncRafId = requestAnimationFrame(tick);
      };
      context.lipSyncRafId = requestAnimationFrame(tick);
    } catch (e) {
      // Lip sync is a nicety; never let it break audio playback.
      console.warn('Lip sync failed to start:', e);
    }
  }

function showView(view) {
    const isSettings = view === 'settings';
    const isSessions = view === 'sessions';
    const isHome = view === 'home';
    if (context.homeViewEl) context.homeViewEl.hidden = !isHome;
    if (context.settingsViewEl) context.settingsViewEl.hidden = !isSettings;
    if (context.sessionsViewEl) context.sessionsViewEl.hidden = !isSessions;
    context.navHomeBtnEl?.classList.toggle('active', isSessions);
    context.navSettingsBtnEl?.classList.toggle('active', isSettings);
  }

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

function showDoctorBubble(issueBtn) {
    if (!context.doctorBubbleEl) return;
    context.doctorBubbleTitleEl.textContent = issueBtn.querySelector('strong')?.textContent || '';
    context.doctorBubbleMessageEl.textContent = issueBtn.dataset.doctorMessage || '';
    context.doctorBubbleEl.hidden = false;
    const rect = issueBtn.getBoundingClientRect();
    const bubbleRect = context.doctorBubbleEl.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - bubbleRect.width - 12);
    const fitsBelow = rect.bottom + 8 + bubbleRect.height <= window.innerHeight - 12;
    const top = fitsBelow ? rect.bottom + 8 : Math.max(12, rect.top - bubbleRect.height - 8);
    context.doctorBubbleEl.style.left = `${Math.max(12, left)}px`;
    context.doctorBubbleEl.style.top = `${top}px`;
  }

function hideDoctorBubble() {
    if (context.doctorBubbleEl) context.doctorBubbleEl.hidden = true;
  }

function openNavInfo(title, bodyHtml) {
    hideDoctorBubble();
    context.navInfoTitleEl.textContent = title;
    context.navInfoBodyEl.innerHTML = bodyHtml;
    context.navInfoModalEl.setAttribute('aria-hidden', 'false');
  }

function closeNavInfo() {
    context.navInfoModalEl.setAttribute('aria-hidden', 'true');
    hideDoctorBubble();
  }

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

async function runOnboardingChecks(){
    let modelOk = false;
    let whisperOk = false;
    context.onboardDetailsEl.hidden = true;

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
        setSetupStatus(context.setupWhisperIconEl, context.setupWhisperDetailEl, 'pass',
          `Using ${basename(whisperCheck.details.bin)} + ${basename(whisperCheck.details.model)}.`);
      } else {
        setSetupStatus(context.setupWhisperIconEl, context.setupWhisperDetailEl, 'warn',
          'Not found. Get whisper.cpp (whisper-cli.exe) and a ggml model (e.g. ggml-base.en.bin), place them under tools/whisper/, then click Recheck. See docs/quick_start_windows.md.');
      }

      const rec = models.recommendation;
      const profile = rec && models.profiles ? models.profiles[rec.profile] : null;
      modelOk = Boolean(profile && profile.available);
      if (modelOk) {
        setSetupStatus(context.setupModelIconEl, context.setupModelDetailEl, 'pass',
          `Using ${profile.label}: ${basename(profile.selectedModel) || profile.selectedModel}.`);
      } else if (profile) {
        setSetupStatus(context.setupModelIconEl, context.setupModelDetailEl, 'warn',
          `Recommended for your hardware: ${profile.label}. ${rec.reason} Scan for a model on this PC, browse to one directly, or download one of: ${profile.missing.join(', ')} and place it under tools/llama/, then click Recheck.`);
      } else {
        setSetupStatus(context.setupModelIconEl, context.setupModelDetailEl, 'warn', 'Could not determine a recommendation.');
      }
      if (context.setupModelActionsEl) context.setupModelActionsEl.hidden = modelOk;
      if (modelOk && context.setupModelScanResultsEl) context.setupModelScanResultsEl.hidden = true;
    } catch (e) {
      setSetupStatus(context.setupModelIconEl, context.setupModelDetailEl, 'warn', 'Backend not reachable yet.');
      setSetupStatus(context.setupWhisperIconEl, context.setupWhisperDetailEl, 'warn', 'Backend not reachable yet.');
      if (context.setupModelActionsEl) context.setupModelActionsEl.hidden = true;
      context.onboardDetailsEl.hidden = false;
      context.onboardDetailsEl.textContent = 'Setup check failed: ' + (e.message || e);
    }

    try {
      const resolved = window.electronAPI.resolveAvatarModel
        ? await window.electronAPI.resolveAvatarModel()
        : null;
      if (resolved && resolved.modelJson) {
        setSetupStatus(context.setupAvatarIconEl, context.setupAvatarDetailEl, 'pass', 'Avatar model found.');
        context.fetchAvatarBtnEl.hidden = true;
      } else {
        setSetupStatus(context.setupAvatarIconEl, context.setupAvatarDetailEl, 'warn',
          "No avatar model yet -- Mana falls back to a simple sprite. Optional, and free to fetch below.");
        context.fetchAvatarBtnEl.hidden = false;
      }
    } catch (e) {
      setSetupStatus(context.setupAvatarIconEl, context.setupAvatarDetailEl, 'warn', 'Could not check.');
    }

    context.onboardTextEl.textContent = (modelOk && whisperOk)
      ? "You're all set!"
      : 'A couple of things still need setup for the full experience:';

    return { modelOk, whisperOk };
  }

  return { init, live2dStateFor, initLive2dAvatar, setSprite, startLoadingAnimation, stopLoadingAnimation, stopLipSync, startLipSync, showView, escapeHtml, showDoctorBubble, hideDoctorBubble, openNavInfo, closeNavInfo, showOnboarding, hideOnboarding, setSetupStatus, basename, runOnboardingChecks };
}

const api = { createDesktopUI };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.ManaDesktopUI = api;
})(typeof window === 'undefined' ? globalThis : window);
