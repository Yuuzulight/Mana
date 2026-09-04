// Test addon loading integration
const { registerAddon } = require('./addons-loader');
const path = require('path');

console.log('[Test] Current working directory:', process.cwd());

// From node-bot, parent is mana-refactor, then addons/short-video-gen/index.js
const addonPath = path.resolve(__dirname, '../addons/short-video-gen/index.js');
console.log('[Test] Resolved addon path:', addonPath);

try {
  const addonModule = require(addonPath);
  console.log('[Test] Addon module loaded:', typeof addonModule);
  
  // Register via the exported function
  registerAddon('short-video-gen', addonModule);
  
  // Verify it's registered
  const retrieved = require('./addons-loader').getAddon('short-video-gen');
  if (retrieved && retrieved.name === 'Short Video Generator + Auto-Publish') {
    console.log('[Test] ✅ SUCCESS: Addon registered and retrievable');
  } else {
    console.log('[Test] ❌ FAIL: Addon not found in registry');
  }
} catch (err) {
  console.error('[Test] Error:', err.message);
}
