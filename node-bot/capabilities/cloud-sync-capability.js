// Stub capability for cloud sync (Issue #492 Add-on tier)
module.exports = {
  key: 'cloud-sync',
  name: 'Cloud Sync',
  description: 'Cloud backup and restore operations',
  requiresConsent: true, // Add-on tier feature
};
