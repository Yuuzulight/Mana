(async function(){
  const statusEl = document.getElementById('status');
  const transcriptEl = document.getElementById('transcript');
  const replyEl = document.getElementById('reply');
  const logsEl = document.getElementById('backendLogs');
  const spriteEl = document.getElementById('sprite');

  let mediaStream = null;
  let recorder = null;
  let chunks = [];

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

    setupRecording();
  }

  let _prevSpriteState = 'idle';
  function setSprite(state){
    // handle transient excited state which should hop but keep the underlying sprite (idle/speaking)
    if (state === 'excited'){
      // keep previous visual (or default to idle)
      const base = _prevSpriteState || 'idle';
      spriteEl.className = 'sprite ' + base + ' excited';
      // remove excited after a few hops (duration * iterations)
      const durationMs = 320; // must match CSS animation-duration
      const iterations = 5; // number of hops
      setTimeout(()=>{
        // restore to base state
        spriteEl.className = 'sprite ' + base;
      }, durationMs * iterations);
      return;
    }
    _prevSpriteState = state || 'idle';
    spriteEl.className = 'sprite ' + _prevSpriteState;
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
        try {
          const sresp = await fetch('http://127.0.0.1:5005/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: j.reply }) });
          if (sresp.ok) {
            const arr = await sresp.arrayBuffer();
            const audioCtx = new AudioContext();
            const buf = await audioCtx.decodeAudioData(arr);
            const src = audioCtx.createBufferSource();
            src.buffer = buf;
            src.connect(audioCtx.destination);
            src.onended = ()=> setSprite('idle');
            src.start();
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
  document.getElementById('openDocsBtn').addEventListener('click', ()=>{ window.open('../BUILD_DESKTOP.md','_blank'); });

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
