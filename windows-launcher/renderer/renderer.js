const listenBtn = document.getElementById("listenToggle");
const statusEl = document.getElementById("statustxt");
const transcriptEl = document.getElementById("transcript");
const replyEl = document.getElementById("modelReply");
const openWebUIButton = document.getElementById("openWebUI");
const { ipcRenderer } = require("electron");

const WAKE_WORD = "mana";
const LISTEN_CHUNK_MS = 3500;
const LISTEN_PAUSE_MS = 250;

let mediaStream = null;
let currentReplyAudio = null;
let currentReplyUrl = null;
let listening = false;
let processing = false;

function setAvatarState(state) {
  ipcRenderer.send("avatar:set-state", state);
}

openWebUIButton.addEventListener("click", () => {
  const { shell } = require("electron");
  shell.openExternal("http://localhost:7860");
});

async function checkServices() {
  if (listening) {
    return;
  }

  try {
    const response = await fetch("http://localhost:5005/health", {
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`Health check returned ${response.status}`);
    }
    const health = await response.json();
    statusEl.textContent = health.ttsConfigured
      ? "Local backend running"
      : "Local backend running (TTS not configured)";
  } catch (e) {
    statusEl.textContent = "Local backend not reachable";
  }
}

checkServices();
setAvatarState("idle");
setInterval(checkServices, 5000);

function stopReplyAudio() {
  if (currentReplyAudio) {
    currentReplyAudio.pause();
    currentReplyAudio = null;
  }
  if (currentReplyUrl) {
    URL.revokeObjectURL(currentReplyUrl);
    currentReplyUrl = null;
  }
  setAvatarState("idle");
}

async function playReplyAudio(text) {
  statusEl.textContent = "Synthesizing reply...";
  const response = await fetch("http://localhost:5005/synthesize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message);
  }

  const audioBlob = await response.blob();
  stopReplyAudio();
  currentReplyUrl = URL.createObjectURL(audioBlob);
  currentReplyAudio = new Audio(currentReplyUrl);

  currentReplyAudio.addEventListener("ended", stopReplyAudio, { once: true });
  currentReplyAudio.addEventListener("error", stopReplyAudio, { once: true });

  setAvatarState("talking");
  await currentReplyAudio.play();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordAudioChunk(durationMs) {
  if (!mediaStream) {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    const recorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm" });

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onerror = (event) => reject(event.error);
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: "audio/webm" }));
    };

    recorder.start();
    setTimeout(() => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }, durationMs);
  });
}

async function webmBlobToWavBlob(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const wavBytes = audioBufferToWav(audioBuffer);
    return new Blob([wavBytes], { type: "audio/wav" });
  } finally {
    await audioCtx.close().catch(() => {});
  }
}

async function transcribeBlob(blob) {
  const wavBlob = await webmBlobToWavBlob(blob);
  const formData = new FormData();
  formData.append("file", wavBlob, "listening.wav");

  const response = await fetch("http://localhost:5005/transcribe-only", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message);
  }

  return await response.json();
}

function extractWakeCommand(transcript) {
  const normalized = transcript.trim();
  const wakePattern = new RegExp(`\\b${WAKE_WORD}\\b[\\s,.:;!?-]*`, "i");
  const wakeMatch = normalized.match(wakePattern);
  if (!wakeMatch) {
    return null;
  }

  const command = normalized.slice(wakeMatch.index + wakeMatch[0].length).trim();
  return command || normalized;
}

async function requestReply(text) {
  const response = await fetch("http://localhost:5005/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message);
  }

  return await response.json();
}

async function handleTranscript(transcript) {
  // Quick rundown: ignore normal room audio until the transcript includes "Mana".
  const command = extractWakeCommand(transcript);
  if (!command) {
    statusEl.textContent = "Listening for Mana...";
    transcriptEl.textContent = transcript ? `Heard: ${transcript}` : "";
    return;
  }

  processing = true;
  statusEl.textContent = "Mana heard her name...";
  transcriptEl.textContent = `You: ${transcript}`;

  try {
    const replyResult = await requestReply(command);
    const reply = replyResult.reply || "";
    replyEl.textContent = `Mana: ${reply}`;

    if (replyResult.ttsConfigured) {
      await playReplyAudio(reply);
    }

    statusEl.textContent = listening ? "Listening for Mana..." : "Stopped";
  } finally {
    processing = false;
  }
}

async function listenLoop() {
  // Quick rundown: record short chunks, transcribe them, and only reply after the wake word.
  while (listening) {
    if (processing || currentReplyAudio) {
      await wait(LISTEN_PAUSE_MS);
      continue;
    }

    try {
      statusEl.textContent = "Listening for Mana...";
      const chunk = await recordAudioChunk(LISTEN_CHUNK_MS);
      if (!listening) {
        break;
      }

      const result = await transcribeBlob(chunk);
      await handleTranscript(result.transcript || "");
    } catch (error) {
      console.error(error);
      statusEl.textContent = `Listening error: ${error.message}`;
      await wait(1500);
    }
  }
}

async function startListening() {
  if (listening) {
    return;
  }

  transcriptEl.textContent = "";
  replyEl.textContent = "";
  listening = true;
  listenBtn.textContent = "Stop listening";
  listenBtn.classList.add("active");
  await listenLoop();
}

function stopListening() {
  listening = false;
  listenBtn.textContent = "Start listening";
  listenBtn.classList.remove("active");
  statusEl.textContent = "Stopped";
  stopReplyAudio();

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}

listenBtn.addEventListener("click", async () => {
  if (listening) {
    stopListening();
    return;
  }

  try {
    await startListening();
  } catch (error) {
    console.error(error);
    stopListening();
    statusEl.textContent = `Microphone access failed: ${error.message}`;
  }
});

// helper: convert AudioBuffer to WAV bytes (16-bit PCM)
function audioBufferToWav(buffer, opt) {
  opt = opt || {};
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = opt.float32 ? 3 : 1; // 3 = IEEE float, 1 = PCM
  const bitDepth = format === 3 ? 32 : 16;

  let result;
  if (numChannels === 2) {
    result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
  } else {
    result = buffer.getChannelData(0);
  }

  return encodeWAV(result, numChannels, sampleRate, bitDepth, format);
}

function interleave(inputL, inputR) {
  const length = inputL.length + inputR.length;
  const result = new Float32Array(length);
  let index = 0,
    inputIndex = 0;
  while (index < length) {
    result[index++] = inputL[inputIndex];
    result[index++] = inputR[inputIndex];
    inputIndex++;
  }
  return result;
}

function encodeWAV(samples, numChannels, sampleRate, bitDepth, format) {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  if (bitDepth === 16) {
    floatTo16BitPCM(view, 44, samples);
  } else {
    writeFloat32(view, 44, samples);
  }

  return buffer;
}

function floatTo16BitPCM(output, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

function writeFloat32(output, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 4) {
    output.setFloat32(offset, input[i], true);
  }
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
