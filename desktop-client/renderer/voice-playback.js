(function(root) {
function createVoicePlayback(context) {
async function speakReply(replyText, preferredExpression) {
    context.setSprite('speaking');
    if (context.live2dAvatar) context.live2dAvatar.setState(context.detectReplyEmotion(replyText), preferredExpression);
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
          context.currentChunkSource = src;
          src.onended = () => {
            if (context.currentChunkSource === src) context.currentChunkSource = null;
            context.stopLipSync();
            context.setSprite('idle');
            audioCtx.close().catch(() => {}); // Finding 6: don't leak AudioContexts
            resolve();
          };
          src.start();
          context.startLipSync(audioCtx, src);
          if (context.bargeInEnabled()) {
            const playbackTokenAtStart = context.desktopReplyPlaybackToken;
            watchForBargeIn(
              () => context.currentChunkSource !== null && context.desktopReplyPlaybackToken === playbackTokenAtStart,
              () => {
                if (context.currentChunkSource) context.currentChunkSource.stop();
                stopStreamingReply();
                handleDesktopBargeInTrigger().catch((e) =>
                  console.warn('Barge-in interruption handling failed:', e.message),
                );
              },
            ).catch((e) => console.warn('Voice barge-in monitor failed:', e.message));
          }
        });
      } else {
        context.setSprite('idle');
      }
    } catch (e) {
      context.setSprite('idle');
    }
  }

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

async function watchForBargeIn(isStillPlaying, onTrigger) {
    if (context.bargeInMonitor) {
      return;
    }
    const self = { stopped: false };
    context.bargeInMonitor = self;

    try {
      await context.ensureMediaStream();
      const vad = context.getSileroVad();
      if (!vad) {
        return;
      }
      vad.reset();

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: context.VAD_SAMPLE_RATE,
      });
      const source = audioCtx.createMediaStreamSource(context.mediaStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);

      let speechStartedAt = null;
      try {
        while (!self.stopped && isStillPlaying()) {
          await context.wait(context.BARGE_IN_POLL_MS);
          if (self.stopped || !isStillPlaying()) {
            break;
          }

          let isSpeech = false;
          try {
            analyser.getFloatTimeDomainData(samples);
            const frame = samples.subarray(samples.length - context.VAD_FRAME_SAMPLES);
            const probability = await vad.processFrame(frame);
            isSpeech = vad.isSpeech(probability);
          } catch (e) {
            isSpeech = false;
          }

          const isLoudEnough = context.dbfsFromSamples(samples) >= context.BARGE_IN_MIN_DBFS;

          const state = context.nextBargeInState({
            isSpeech,
            isLoudEnough,
            speechStartedAt,
            now: context.performance.now(),
            holdMs: context.BARGE_IN_HOLD_MS,
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
      context.bargeInMonitor = null;
    }
  }

function playDecodedChunk(audioCtx, audioBuffer, text) {
    return new Promise((resolve) => {
      context.setSprite('speaking');
      if (context.live2dAvatar) context.live2dAvatar.setState(context.detectReplyEmotion(text));
      const src = audioCtx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(audioCtx.destination);
      context.currentChunkSource = src;
      src.onended = () => {
        if (context.currentChunkSource === src) context.currentChunkSource = null;
        context.stopLipSync();
        resolve();
      };
      src.start();
      context.startLipSync(audioCtx, src);
      if (context.bargeInEnabled()) {
        const playbackTokenAtStart = context.desktopReplyPlaybackToken;
        watchForBargeIn(
          () => context.currentChunkSource !== null && context.desktopReplyPlaybackToken === playbackTokenAtStart,
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
            if (context.currentChunkSource) context.currentChunkSource.stop();
            stopStreamingReply();
            handleDesktopBargeInTrigger().catch((e) =>
              console.warn('Barge-in interruption handling failed:', e.message),
            );
          },
        ).catch((e) => console.warn('Voice barge-in monitor failed:', e.message));
      }
    });
  }

function stopStreamingReply() {
    context.desktopReplyPlaybackToken += 1;
  }

async function resumeHeldReply() {
    const sentences = context.heldReply ? context.heldReply.sentences : null;
    context.heldReply = null;
    if (!sentences || sentences.length === 0) {
      return;
    }

    stopStreamingReply();
    const playbackToken = context.desktopReplyPlaybackToken;
    const audioCtx = new AudioContext();
    const queue = context.createDesktopStreamingChunkQueue({
      synthesize: (text) => synthesizeAndDecodeChunk(text, audioCtx),
      play: (audioBuffer, text) => playDecodedChunk(audioCtx, audioBuffer, text),
      isCurrent: () => context.desktopReplyPlaybackToken === playbackToken,
      onIdle: () => context.setSprite('idle'),
    });
    context.activeStreamingQueue = queue;
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
      if (context.activeStreamingQueue === queue) {
        context.activeStreamingQueue = null;
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

async function handleDesktopBargeInInterruption(category, transcript) {
    // Captured once up front: a nested interruption's own capture window can
    // overlap this one's `await handleTranscriptText` below (see
    // bargeInCaptureCount's doc comment) and replace the module-global
    // `heldReply` with a new hold before this call resumes -- comparing
    // identity against `hold` rather than re-reading the global lets this
    // dispatch stay correct regardless of that ordering.
    const hold = context.heldReply;

    if (category === 'amend') {
      // Same shape as correction (discard, no resume -- the amended reply
      // replaces what was being said, it doesn't supplement it), except the
      // transcript is wrapped so the model steers using the original reply
      // it already has in session history (see the design doc's Key Finding:
      // buildAssistantReply appends the full reply to session history before
      // /reply/stream's final event, well before any barge-in can fire).
      context.heldReply = null;
      if (transcript) {
        // Kept parenthesis-free to match windows-launcher's wrapper exactly
        // (its cleanTranscriptText() would strip a "(...)"-wrapped prefix
        // entirely -- this app doesn't have that stripping, but the wording
        // is kept identical across both apps for parity).
        await context.handleTranscriptText(`Amending what you just said: ${transcript}`);
      }
      return;
    }

    if (category === 'correction') {
      context.heldReply = null;
      if (transcript) {
        await context.handleTranscriptText(transcript);
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
        await context.handleTranscriptText(transcript);
      }
      // A nested interruption during the line above discards heldReply
      // itself (see handleDesktopBargeInTrigger's wasNested branch) -- only
      // resume if it's still the same hold.
      if (context.heldReply === hold) {
        await resumeHeldReply();
      }
      return;
    }

    // backchannel or unclassified: resume from the cut point, no new turn.
    await resumeHeldReply();
  }

async function handleDesktopBargeInTrigger() {
    const wasNested = Boolean(context.heldReply && context.heldReply.stackDepth >= 1);
    const heldSentences = context.activeStreamingQueue ? context.activeStreamingQueue.peekPending() : [];

    if (wasNested) {
      // A second interruption arrived while an inserted new-question answer
      // was playing -- per the depth-1 cap, the outer held reply is
      // discarded outright (not stacked); this interruption becomes a fresh
      // top-level turn, no classification needed since there's nothing left
      // to resume/discard against.
      context.heldReply = null;
      context.bargeInCaptureCount += 1;
      try {
        const blob = await context.recordUntilSilence({ isBargeInCapture: true });
        if (!blob) return;
        const transcript = await context.transcribeBlob(blob);
        if (transcript) {
          await context.handleTranscriptText(transcript);
        }
      } catch (e) {
        console.warn('Barge-in interruption capture failed:', e.message);
      } finally {
        context.bargeInCaptureCount -= 1;
      }
      return;
    }

    if (heldSentences.length === 0) {
      // Nothing left to hold -- equivalent to today's stop-and-discard; the
      // normal listen loop picks up whatever comes next.
      return;
    }

    context.heldReply = { sentences: heldSentences, stackDepth: 0 };
    context.bargeInCaptureCount += 1;
    try {
      const blob = await context.recordUntilSilence({ isBargeInCapture: true });
      if (!blob) {
        await resumeHeldReply();
        return;
      }
      const transcript = await context.transcribeBlob(blob);
      const { category } = await classifyBargeInText(transcript);
      await handleDesktopBargeInInterruption(category, transcript);
    } catch (e) {
      console.warn('Barge-in interruption capture failed:', e.message);
      context.heldReply = null;
    } finally {
      context.bargeInCaptureCount -= 1;
    }
  }

async function speakStreamingReply(requestBody, onFinal) {
    context.replyInProgress = true;
    try {
      stopStreamingReply();
      const playbackToken = context.desktopReplyPlaybackToken;
      const audioCtx = new AudioContext();
      const queue = context.createDesktopStreamingChunkQueue({
        synthesize: (text) => synthesizeAndDecodeChunk(text, audioCtx),
        play: (audioBuffer, text) => playDecodedChunk(audioCtx, audioBuffer, text),
        isCurrent: () => context.desktopReplyPlaybackToken === playbackToken,
        onIdle: () => context.setSprite('idle'),
      });
      context.activeStreamingQueue = queue;
      const runPromise = queue.run();

      let finalEvent = null;
      try {
        const response = await fetch('http://127.0.0.1:5005/reply/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        for await (const event of context.readNdjsonEvents(response)) {
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
        if (context.activeStreamingQueue === queue) {
          context.activeStreamingQueue = null;
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

      if (context.desktopReplyPlaybackToken === playbackToken && result.changed && result.reply) {
        stopStreamingReply();
        await speakReply(result.reply, result.expression);
      }

      return result;
    } finally {
      context.replyInProgress = false;
    }
  }

  return { speakReply, synthesizeAndDecodeChunk, watchForBargeIn, playDecodedChunk, stopStreamingReply, resumeHeldReply, classifyBargeInText, handleDesktopBargeInInterruption, handleDesktopBargeInTrigger, speakStreamingReply };
}

const api = { createVoicePlayback };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.ManaVoicePlayback = api;
})(typeof window === 'undefined' ? globalThis : window);
