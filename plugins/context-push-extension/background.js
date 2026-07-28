// Issue #189: single source of truth for on/off state lives here, not in
// each content script instance -- avoids every open tab independently
// racing to read/interpret storage. The toolbar icon is the "hard to miss"
// indicator the issue requires (a full color swap, not a subtle badge
// dot), and a single click is the off switch -- both non-negotiable per
// the issue's own reasoning about consent.

const DEFAULT_BACKEND_URL = "http://127.0.0.1:5005";
const ICON_SIZES = ["16", "48", "128"];

function iconPaths(state) {
  const paths = {};
  for (const size of ICON_SIZES) paths[size] = `icons/icon-${state}-${size}.png`;
  return paths;
}

async function getState() {
  const stored = await chrome.storage.local.get(["enabled", "backendUrl"]);
  return {
    enabled: Boolean(stored.enabled),
    backendUrl: stored.backendUrl || DEFAULT_BACKEND_URL,
  };
}

async function applyIconForState(enabled) {
  await chrome.action.setIcon({ path: iconPaths(enabled ? "on" : "off") });
  await chrome.action.setTitle({
    title: enabled
      ? "Mana web context: ON -- reading this page (click to turn off)"
      : "Mana web context: off (click to turn on)",
  });
}

async function setEnabled(enabled) {
  await chrome.storage.local.set({ enabled });
  await applyIconForState(enabled);
}

// First install: capture starts OFF until the user has actually seen and
// acknowledged the onboarding explanation -- "always-on by default" refers
// to not needing a per-tab toggle afterward, not to skipping informed
// consent on first install.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await setEnabled(false);
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  } else {
    const { enabled } = await getState();
    await applyIconForState(enabled);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const { enabled } = await getState();
  await applyIconForState(enabled);
});

chrome.action.onClicked.addListener(async () => {
  const { enabled } = await getState();
  await setEnabled(!enabled);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "onboarding-complete") {
    setEnabled(true).then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async response
  }

  if (message?.type === "page-context") {
    (async () => {
      const { enabled, backendUrl } = await getState();
      if (!enabled) return;
      try {
        await fetch(`${backendUrl}/context/push`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: message.url,
            title: message.title,
            text: message.text,
            videoSubtitle: message.videoSubtitle,
          }),
        });
      } catch (e) {
        // Mana's backend not running, or not reachable -- not worth
        // surfacing to the user per-page; the toolbar icon still honestly
        // reflects "capture is on", not "capture is reaching Mana".
      }
    })();
  }
});
