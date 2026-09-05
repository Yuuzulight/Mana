// Issue #500: extracted from renderer.js -- already fully self-contained
// (only touches createCaptionClient, a global from caption-client.js, and
// its own by-id DOM lookup), so moved out verbatim.
//
// Issue #362: consume the caption feed node-bot has been broadcasting on
// /ws/captions since caption-server.js landed. Purely additive -- if the
// socket never connects, everything else behaves exactly as before.
(function initCaptions() {
  try {
    if (typeof createCaptionClient !== "function") return;
    const el = document.getElementById("mana-captions");
    if (!el) return;
    createCaptionClient({
      onCaption: ({ text }) => {
        el.textContent = text;
        el.hidden = false;
      },
    }).connect();
  } catch (e) {
    // Captions must never take the conversation down with them.
  }
})();
