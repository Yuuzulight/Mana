// Compare mode picks two starting model profiles to preselect in the two
// dropdowns so the panel opens with a meaningful contrast (default vs.
// quality) rather than the same profile twice, when both are available.
function pickDefaultCompareProfiles(profileKeys) {
  const keys = Array.from(profileKeys || []);
  if (!keys.length) {
    return [null, null];
  }
  if (keys.includes("default") && keys.includes("quality")) {
    return ["default", "quality"];
  }
  const second = keys.find((key) => key !== keys[0]);
  return [keys[0], second || keys[0]];
}

// Labels a compare column with which GGUF a profile is actually using
// (profiles silently fall back to a smaller model when the preferred file
// isn't downloaded, which would otherwise make two "different" profiles
// compare identically with no indication why) or flags it as unavailable
// when no matching GGUF exists at all.
function formatCompareProfileLabel(key, profiles) {
  const profile = profiles?.[key];
  if (!profile) {
    return key || "";
  }
  if (!profile.available) {
    return `${profile.label || key} (unavailable)`;
  }
  const modelFile = profile.selectedModel
    ? profile.selectedModel.split(/[\\/]/).pop()
    : null;
  return modelFile ? `${profile.label || key} (${modelFile})` : profile.label || key;
}

module.exports = {
  formatCompareProfileLabel,
  pickDefaultCompareProfiles,
};
