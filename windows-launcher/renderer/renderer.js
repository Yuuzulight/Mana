const talkBtn = document.getElementById("talk");
const statusEl = document.getElementById("statustxt");
const transcriptEl = document.getElementById("transcript");
const replyEl = document.getElementById("modelReply");
const openWebUIButton = document.getElementById("openWebUI");

let mediaRecorder = null;
let audioChunks = [];
let mediaStream = null;
let currentReplyAudio = null;
let currentReplyUrl = null;

openWebUIButton.addEventListener("click", () => {
  const { shell } = require("electron");
  shell.openExternal("http://localhost:7860");
});

async function checkServices() {
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
// Keep the status fresh.
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

  currentReplyAudio.addEventListener(
    "ended",
    () => {
      stopReplyAudio();
    },
    { once: true },
  );

  currentReplyAudio.addEventListener(
    "error",
    () => {
      stopReplyAudio();
    },
    { once: true },
  );

  await currentReplyAudio.play();
}

async function startRecording() {
  transcriptEl.textContent = "";
  replyEl.textContent = "";
  audioChunks = [];

  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm" });
  mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: "audio/webm" });
    const arrayBuffer = await blob.arrayBuffer();
    let audioCtx = null;

    statusEl.textContent = "Converting to WAV...";
    // Convert browser audio to WAV before upload.
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      // Send the backend a simple audio format.
      const wavBytes = audioBufferToWav(audioBuffer);
      const wavBlob = new Blob([wavBytes], { type: "audio/wav" });

      const fdata = new FormData();
      fdata.append("file", wavBlob, "recording.wav");

      statusEl.textContent = "Uploading audio...";
      const resp = await fetch("http://localhost:5005/transcribe", {
        method: "POST",
        body: fdata,
      });
      if (!resp.ok) {
        const txt = await resp.text();
        statusEl.textContent = "Error from bridge: " + txt;
        return;
      }

      const j = await resp.json();
      const t = j.transcript || "";
      const m = j.reply || "";
      transcriptEl.textContent = "You: " + t;
      replyEl.textContent = "Bot: " + m;

      if (j.ttsConfigured) {
        await playReplyAudio(m);
      } else {
        stopReplyAudio();
        statusEl.textContent = "Reply ready (TTS not configured)";
        return;
      }

      statusEl.textContent = "Done";
    } catch (e) {
      console.error(e);
      statusEl.textContent =
        "Error converting audio or contacting backend: " + e.message;
    } finally {
      // Clean up mic and audio resources after each recording.
      if (audioCtx) {
        await audioCtx.close().catch(() => {});
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
    }
  };
  mediaRecorder.start();
}

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

  /* RIFF identifier */ writeString(view, 0, "RIFF");
  /* file length */ view.setUint32(
    4,
    36 + samples.length * bytesPerSample,
    true,
  );
  /* RIFF type */ writeString(view, 8, "WAVE");
  /* format chunk identifier */ writeString(view, 12, "fmt ");
  /* format chunk length */ view.setUint32(16, 16, true);
  /* sample format (raw) */ view.setUint16(20, format, true);
  /* channel count */ view.setUint16(22, numChannels, true);
  /* sample rate */ view.setUint32(24, sampleRate, true);
  /* byte rate (sampleRate * blockAlign) */ view.setUint32(
    28,
    sampleRate * blockAlign,
    true,
  );
  /* block align (channel count * bytes per sample) */ view.setUint16(
    32,
    blockAlign,
    true,
  );
  /* bits per sample */ view.setUint16(34, bitDepth, true);
  /* data chunk identifier */ writeString(view, 36, "data");
  /* data chunk length */ view.setUint32(
    40,
    samples.length * bytesPerSample,
    true,
  );

  // write the PCM samples
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

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

// Stop recording on release or when the pointer leaves the button.
talkBtn.addEventListener("mousedown", async () => {
  try {
    talkBtn.textContent = "Recording...";
    talkBtn.style.background = "#c0392b";
    await startRecording();
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Microphone access failed: " + e.message;
    talkBtn.textContent = "Push to talk (hold)";
    talkBtn.style.background = "#0b84ff";
  }
});

["mouseup", "mouseleave"].forEach((ev) => {
  talkBtn.addEventListener(ev, () => {
    talkBtn.textContent = "Push to talk (hold)";
    talkBtn.style.background = "#0b84ff";
    stopRecording();
  });
});

// Same flow for touch.
talkBtn.addEventListener("touchstart", async (e) => {
  e.preventDefault();
  try {
    talkBtn.textContent = "Recording...";
    talkBtn.style.background = "#c0392b";
    await startRecording();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Microphone access failed: " + err.message;
    talkBtn.textContent = "Push to talk (hold)";
    talkBtn.style.background = "#0b84ff";
  }
});
talkBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  talkBtn.textContent = "Push to talk (hold)";
  talkBtn.style.background = "#0b84ff";
  stopRecording();
});
