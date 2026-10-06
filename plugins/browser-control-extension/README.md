# Mana Browser Connection

This companion extension controls only the Chrome web tabs explicitly selected
for one Mana chat. It is separate from the passive-context extension.

## Install Once

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select this `plugins/browser-control-extension` folder.
3. Pin **Mana Browser Connection** to Chrome's toolbar.

No personal profile directory, cookie database, password database, or general
Mana admin key is copied into the extension. Chrome's debugger permission is
required; Chrome also shows its own debugging indicator while attached.

## Connect A Session

1. Choose a chat in Mana and open its **Browser** panel.
2. Choose **Connect Chrome**, confirm access, and optionally provide exact allowed
   site origins, such as `https://example.com` (comma separated).
3. Copy the displayed connection code into the extension, select up to five web
   tabs, and choose **Connect selected tabs**.

The code is single-use and expires after five minutes. Reading uses the selected
tabs' existing logins. Each proposed click, typing/submission, navigation, key
press, selection, drag, or tab switch requires a fresh approval in Mana. General
"always allow" settings cannot suppress these personal-browser approvals.
Approvals expire after two minutes and reject stale page ownership.

**Take over** shows the page inside Mana, with mouse, keyboard, and scrolling.
Your manual input does not enter the model's activity log. **Done** resumes Mana;
old agent handles and pending proposals cannot act through the previous owner.

**Stop** in Mana or **Disconnect Mana** in the extension detaches debugger access
without closing your tabs or Chrome. Connections expire after five minutes with
no browser work. Closing Chrome, detaching its debugger, leaving the allowed
sites, or losing the backend connection also ends access. Permission is not
restored automatically on the next session.

Chrome must remain running for this mode. Mana's dedicated headless browser is
still the default for autonomous work, site tests, uploads, and developer tools.
Personal mode never creates or closes your tabs; select additional tabs through
a new explicit connection instead.

## Verification

`plugins/browser-automation/test/browser-control-extension-integration.test.js`
loads this real extension in an isolated Chromium profile, exercises reading,
screenshots and clicking, verifies debugger detachment, and leaves the original
page usable. Set `MANA_EXTENSION_TEST_EXECUTABLE` to a Chromium executable that
supports loading unpacked extensions to run it. This does not install anything
in your personal browser profile.

`npm test` in `plugins/browser-automation` runs fixtures sequentially so the
opt-in real browser processes do not contend with one another. CI skips those
two browser fixtures unless their executable paths are supplied; deterministic
transport, approval, ownership and lifecycle tests still run.
