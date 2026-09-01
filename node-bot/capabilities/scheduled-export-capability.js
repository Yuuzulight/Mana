// Stub capability for scheduled exports (Issue #492 Add-on tier)
module.exports = {
  key: 'scheduled-export',
  name: 'Scheduled Export',
  description: 'Automated session and memory exports',
  requiresConsent: true, // Add-on tier feature
};
