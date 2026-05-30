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

    // Convert webm to WAV server-side; the bridge expects a WAV/PCM stream.
    // We'll send the webm file and let the bridge try to decode it (soundfile can read many formats).
    const fdata = new FormData();
    fdata.append("file", new Blob([arrayBuffer]), "recording.webm");

    statusEl.textContent = "Uploading audio...";
    try {
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
      statusEl.textContent = "Error contacting voice bridge: " + e.message;
    }
  };
  mediaRecorder.start();
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
