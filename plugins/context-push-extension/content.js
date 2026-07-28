// Issue #189: gathers page context and hands it to background.js, which
// decides whether capture is actually enabled -- keeps the on/off source
// of truth in one place instead of duplicating storage reads/races across
// every open tab's content script instance.

const MAX_TEXT_CHARS = 4000;
const SEND_INTERVAL_MS = 20000;

function readVisibleYouTubeCaptions() {
  // YouTube's live caption overlay -- reads whatever's currently on screen
  // if the user has captions on. No captions API/permission needed; this
  // is just DOM text, same as reading the rest of the page. Out of scope
  // per the issue: actual audio/video decoding for videos without visible
  // captions on.
  const segments = document.querySelectorAll(".ytp-caption-segment");
  if (!segments.length) return "";
  return Array.from(segments)
    .map((el) => el.textContent.trim())
    .filter(Boolean)
    .join(" ");
}

function gatherContext() {
  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || "").slice(0, MAX_TEXT_CHARS),
    videoSubtitle: readVisibleYouTubeCaptions(),
  };
}

function sendContext() {
  try {
    chrome.runtime.sendMessage({ type: "page-context", ...gatherContext() });
  } catch (e) {
    // Extension context invalidated (e.g. reloaded) -- nothing to do
    // beyond stopping quietly until the page itself reloads.
  }
}

sendContext();
setInterval(sendContext, SEND_INTERVAL_MS);
