// Separate file, not inline -- MV3's default CSP blocks inline <script>.
document.getElementById("start").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "onboarding-complete" });
  window.close();
});
