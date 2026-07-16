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

module.exports = {
  pickDefaultCompareProfiles,
};
