// Stub plugin store for dual-tier architecture (Issue #492 Add-on tier)
module.exports = {
  name: 'plugin-store',
  description: 'Dual-tier plugin and add-on installation management',
  requiresConsent: true, // Add-on tier feature
};
