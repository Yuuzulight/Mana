/**
 * Add-on Loader (Lazy, Consent-Gated)
 * 
 * Dual-tier architecture:
 * - plugins/   : wired at server startup in server.js
 * - addons/    : loaded dynamically via this module after consent approval
 */

const fs = require('fs');
const path = require('path');

// In-memory registry of registered addons
const addons = new Map();

/**
 * Register an addon module (called only after /addons/consent/:id approval)
 * @param {string} id - Addon ID from manifest.json
 * @param {object} addonModule - The exported addon object/module
 */
function registerAddon(id, addonModule) {
  if (!id || typeof id !== 'string') {
    throw new Error('Invalid addon id');
  }

  // Validate required fields
  const required = ['name', 'version', 'tier'];
  for (const field of required) {
    if (!(field in addonModule)) {
      throw new Error(`Addon ${id} missing required field: ${field}`);
    }
  }

  addons.set(id, addonModule);
  console.log(`[Addons] Registered: ${addonModule.name} (v${addonModule.version})`);
}

/**
 * Get an addon by ID
 * @param {string} id 
 * @returns {object|null}
 */
function getAddon(id) {
  return addons.get(id) || null;
}

/**
 * Check if an addon is registered (for consent validation)
 * @param {string} id 
 * @returns {boolean}
 */
function hasAddon(id) {
  return addons.has(id);
}

/**
 * Unregister an addon (cleanup on uninstall/consent withdrawal)
 * @param {string} id 
 */
function unregisterAddon(id) {
  addons.delete(id);
  console.log(`[Addons] Unregistered: ${id}`);
}

module.exports = {
  registerAddon,
  getAddon,
  hasAddon,
  unregisterAddon,
};
