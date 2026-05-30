const talkBtn = document.getElementById("talk");
const statusEl = document.getElementById("statustxt");
const transcriptEl = document.getElementById("transcript");
const replyEl = document.getElementById("modelReply");
const openWebUIButton = document.getElementById("openWebUI");

let mediaRecorder = null;
let audioChunks = [];

openWebUIButton.addEventListener("click", () => {
  const { shell } = require("electron");
  shell.openExternal("http://localhost:7860");
});

async function checkServices() {
  try {
    const r = await fetch("http://localhost:5005", { method: "GET" });
    statusEl.textContent = "Voice bridge running";
  } catch (e) {
    statusEl.textContent =
      "Voice bridge not reachable (start the app or check WSL)";
  }
}

checkServices();

async function startRecording() {
  transcriptEl.textContent = "";
  replyEl.textContent = "";
  audioChunks = [];

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: "audio/webm" });
    const arrayBuffer = await blob.arrayBuffer();

    statusEl.textContent = "Converting to WAV...";
    // Decode WebM/Opus in the browser and re-encode as WAV (PCM 16-bit)
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      // convert AudioBuffer to WAV (16-bit PCM)
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

      // Use browser TTS to speak the reply
      if ("speechSynthesis" in window) {
        const utter = new SpeechSynthesisUtterance(m);
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utter);
      } else {
        console.warn("speechSynthesis not available in this environment");
      }

      statusEl.textContent = "Done";
    } catch (e) {
      console.error(e);
      statusEl.textContent =
        "Error converting or contacting voice bridge: " + e.message;
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

// Push-to-talk behavior
talkBtn
  .addEventListener("mousedown", async () => {
    talkBtn.textContent = "Recording...";
    talkBtn.style.background = "#c0392b";
    await startRecording();
  })

  [
    // stop on mouseup or mouseleave
    ("mouseup", "mouseleave")
  ].forEach((ev) => {
    talkBtn.addEventListener(ev, () => {
      talkBtn.textContent = "Push to talk (hold)";
      talkBtn.style.background = "#0b84ff";
      stopRecording();
    });
  });

// touch support
talkBtn.addEventListener("touchstart", async (e) => {
  e.preventDefault();
  talkBtn.textContent = "Recording...";
  talkBtn.style.background = "#c0392b";
  await startRecording();
});
talkBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  talkBtn.textContent = "Push to talk (hold)";
  talkBtn.style.background = "#0b84ff";
  stopRecording();
});
