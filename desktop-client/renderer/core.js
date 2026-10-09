(function(root) {
function createVoiceCore(context) {
function bargeInEnabled() {
    return context.listening && localStorage.getItem(context.BARGE_IN_STORAGE_KEY) !== '0';
  }

function getSileroVad() {
    if (context.VAD_DISABLED || context.sileroVadLoadFailed || typeof window.ort === 'undefined') {
      return null;
    }
    if (!context.sileroVad) {
      context.sileroVad = context.createSileroVad({
        ort: window.ort,
        modelUrl: context.VAD_MODEL_URL,
        threshold: context.VAD_THRESHOLD,
      });
    }
    return context.sileroVad;
  }

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

async function ensureMediaStream() {
    if (!context.mediaStream) {
      context.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    return context.mediaStream;
  }

async function setupRecording(){
    try{
      context.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    clearBtn.addEventListener('click', ()=>{ context.clearMessages(); });
  }

function startRecording(){
    if (!context.mediaStream) return;
    context.chunks = [];
    context.recorder = new MediaRecorder(context.mediaStream);
    context.recorder.ondataavailable = (e)=>{ if (e.data && e.data.size) context.chunks.push(e.data); };
    context.recorder.onstop = onRecordingStop;
    context.recorder.start();
    context.setSprite('listening');
    context.statusEl.textContent = 'Listening...';
  }

async function stopRecording(){
    try{ if (context.recorder && context.recorder.state !== 'inactive') context.recorder.stop(); } catch(e){}
    context.setSprite('idle');
    context.statusEl.textContent = 'Processing...';
  }

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

async function handleTranscriptText(transcript) {
    try{
      context.appendMessage('user', transcript);
      // Issue #331 review (Finding 1): append to the chat log as soon as
      // the final event names the reply, not after speakStreamingReply
      // resolves -- that await also waits for every queued chunk to
      // finish *playing*.
      const result = await context.speakStreamingReply(
        {
          text: transcript,
          sessionId: context.ensureSessionId(),
          presetId: context.selectedPresetId || undefined,
        },
        (finalEvent) => {
          if (!finalEvent.error && finalEvent.reply) context.appendMessage('assistant', finalEvent.reply);
        },
      );
      if (result.error) throw new Error(result.error);
      context.statusEl.textContent = 'Idle';
    } catch (e){
      context.statusEl.textContent = 'Error';
      await window.electronAPI.showError(String(e));
      context.setSprite('idle');
    }
  }

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
      context.statusEl.textContent = 'Error';
      await window.electronAPI.showError(String(e));
      context.setSprite('idle');
    }
  }

async function onRecordingStop(){
    const blob = new Blob(context.chunks, { type: context.chunks[0]?.type || 'audio/webm' });
    await handleVoiceTurn(blob);
  }

async function recordUntilSilence({
    maxWaitForSpeechMs = context.MAX_WAIT_FOR_SPEECH_MS,
    silenceBufferMs = context.SILENCE_BUFFER_MS,
    maxDurationMs = context.MAX_UTTERANCE_MS,
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
      sampleRate: context.VAD_SAMPLE_RATE,
    });
    const source = audioCtx.createMediaStreamSource(context.mediaStream);
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
          const frame = samples.subarray(samples.length - context.VAD_FRAME_SAMPLES);
          const probability = await vad.processFrame(frame);
          return vad.isSpeech(probability);
        } catch (e) {
          console.warn('Silero VAD inference failed, falling back to RMS for this session:', e);
          context.sileroVadLoadFailed = true;
        }
      }
      return currentRms() >= context.MIN_SPEECH_RMS;
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
      const localRecorder = new MediaRecorder(context.mediaStream, { mimeType: 'audio/webm' });
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
      const partialAbortController = new context.AbortController();
      let stopped = false;
      let noSpeechResult = false;
      const startedAt = context.performance.now();

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
            context.statusEl.textContent = `Hearing: "${data.transcript}"`;
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

      localRecorder.start(context.SILENCE_METER_INTERVAL_MS);
      partialTimer = setInterval(pollPartialTranscript, context.PARTIAL_TRANSCRIPT_POLL_MS);

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
        if (context.replyInProgress && !isBargeInCapture) {
          noSpeechResult = true;
          if (localRecorder.state !== 'inactive') {
            localRecorder.stop();
          }
          return;
        }

        if (await isSpeechNow()) {
          if (!hasHeardSpeech) {
            context.statusEl.textContent = 'Listening...';
          }
          hasHeardSpeech = true;
          lastSpeechAt = context.performance.now();
        }
        if (stopped) return;

        const stopReason = context.shouldStopRecording({
          hasHeardSpeech,
          elapsedMs: context.performance.now() - startedAt,
          msSinceLastSpeech: hasHeardSpeech ? context.performance.now() - lastSpeechAt : 0,
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
        meterTimer = setTimeout(tick, context.SILENCE_METER_INTERVAL_MS);
      }
      meterTimer = setTimeout(tick, context.SILENCE_METER_INTERVAL_MS);
    });
  }

async function listenLoop(myGeneration) {
    while (context.listening && context.listenGeneration === myGeneration) {
      // replyInProgress is set for the full duration of speakStreamingReply
      // (see its declaration above) -- covers both push-to-talk's and this
      // loop's own reply, so two recordings can never overlap a reply.
      // bargeInCaptureCount catches the gap between a barge-in stopping
      // playback (replyInProgress can flip false within a few ticks) and
      // that interruption's own capture/classify/dispatch actually finishing
      // -- see its declaration above.
      if (context.replyInProgress || context.bargeInCaptureCount > 0) {
        await wait(context.LISTEN_PAUSE_MS);
        continue;
      }
      try {
        context.statusEl.textContent = 'Waiting for you...';
        const blob = await recordUntilSilence();
        if (!context.listening || context.listenGeneration !== myGeneration) break;
        if (!blob) continue; // Finding 1: nothing was actually said -- don't transcribe/display it
        await handleVoiceTurn(blob);
      } catch (error) {
        console.error(error);
        context.statusEl.textContent = `Listening error: ${error.message}`;
        await wait(1500);
      }
    }
  }

function startListening() {
    if (context.listening) return;
    context.listening = true;
    const myGeneration = ++context.listenGeneration;
    const btn = document.getElementById('btnListen');
    if (btn) {
      btn.textContent = 'Stop Listening';
      btn.classList.add('active');
    }
    listenLoop(myGeneration);
  }

function stopListening() {
    context.listening = false;
    context.heldReply = null;
    const btn = document.getElementById('btnListen');
    if (btn) {
      btn.textContent = 'Start Listening';
      btn.classList.remove('active');
    }
    context.statusEl.textContent = 'Idle';
  }

  return { bargeInEnabled, getSileroVad, wait, ensureMediaStream, setupRecording, startRecording, stopRecording, transcribeBlob, handleTranscriptText, handleVoiceTurn, onRecordingStop, recordUntilSilence, listenLoop, startListening, stopListening };
}

const api = { createVoiceCore };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.ManaVoiceCore = api;
})(typeof window === 'undefined' ? globalThis : window);
