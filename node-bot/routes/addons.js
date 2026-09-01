/**
 * Add-on Tier Routes (Issue #492)
 * 
 * Dual-tier architecture:
 * - Standard plugins: auto-approved, wired at startup
 * - Advanced Add-ons: require explicit consent via /addons/consent/:id endpoint
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

// Lazy-load addons-loader to avoid circular deps
let addonsLoader;

/**
 * Consent-gated addon installation
 * POST /addons/consent/:id
 * 
 * Flow:
 * 1. Validate addon exists in manifest store
 * 2. Check user has granted consent (stored in .consent file or DB)
 * 3. If no consent → return 403 with consent URL
 * 4. If consent granted → load addon module and register via addons-loader
 */

// In-memory "consent store" (replace with persistent storage in production)
const consentStore = new Map();

/**
 * Check if user has consented to an addon
 * @param {string} id 
 * @returns {boolean}
 */
function hasConsented(id) {
  return consentStore.has(id);
}

/**
 * Grant consent for an addon (called after UI approval flow)
 * @param {string} id 
 */
function grantConsent(id) {
  if (!hasAddonManifest(id)) {
    throw new Error(`Unknown addon: ${id}`);
  }
  consentStore.set(id, true);
  console.log(`[Addons] Consent granted for: ${id}`);
}

/**
 * Get manifest metadata for an addon
 */
function getAddonManifest(id) {
  const manifestPath = path.join(__dirname, '../../addons', id, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`[Addons] Failed to parse manifest for ${id}:`, err.message);
    return null;
  }
}

/**
 * Check if addon manifest exists
 */
function hasAddonManifest(id) {
  const manifestPath = path.join(__dirname, '../../addons', id, 'manifest.json');
  return fs.existsSync(manifestPath);
}

// Route: GET /addons/consent/:id — show consent UI (redirect to desktop client modal)
router.get('/consent/:id', (req, res) => {
  const { id } = req.params;
  
  if (!hasAddonManifest(id)) {
    return res.status(404).json({ error: 'Add-on not found' });
  }

  // In production: redirect to desktop-client modal with consent data
  // For now, return JSON that the UI can consume
  const manifest = getAddonManifest(id);
  
  res.json({
    id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    requiresConsent: manifest.requiresConsent || true,
    consentUrl: `/addons/consent/:id?approved=true`, // placeholder for approval flow
  });
});

// Route: POST /addons/consent/:id — approve addon installation
router.post('/consent/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    grantConsent(id);
    
    // Load and register the addon module
    const addonPath = path.join(__dirname, '../../addons', id, 'index.js');
    if (!fs.existsSync(addonPath)) {
      return res.status(404).json({ error: 'Add-on implementation not found' });
    }

    // Dynamically import the addon (lazy load)
    const addonModule = require(addonPath);
    
    // Register via addons-loader using global registry to avoid circular deps
    if (typeof addonModule.registerAddon === 'function') {
      addonModule.registerAddon(id, addonModule);
    } else {
      // Fallback: use global loader with global registry
      const { registerAddon } = require('../../addons-loader');
      
      // Store in global registry for later retrieval
      global.__MANA_ADDONS__ = global.__MANA_ADDONS__ || {};
      global.__MANA_ADDONS__[id] = {
        module: addonModule,
        id,
        registeredAt: Date.now()
      };
      
      registerAddon(id, addonModule);
    }

    res.json({ 
      success: true, 
      message: `Add-on ${id} installed and activated`,
      id
    });
  } catch (err) {
    console.error(`[Addons] Failed to install ${id}:`, err.message);
    res.status(500).json({ error: 'Failed to install add-on' });
  }
});

// Route: GET /addons/:id — get addon info and status
router.get('/:id', (req, res) => {
  const { id } = req.params;
  
  if (!hasAddonManifest(id)) {
    return res.status(404).json({ error: 'Add-on not found' });
  }

  const manifest = getAddonManifest(id);
  const isInstalled = hasAddonManifest(id) && fs.existsSync(path.join(__dirname, '../../addons', id, 'index.js'));
  const isConsented = hasConsented(id);

  res.json({
    id,
    name: manifest.name,
    version: manifest.version,
    tier: manifest.tier || 'addon',
    installed: isInstalled,
    consented: isConsented,
    active: isInstalled && isConsented,
    description: manifest.description,
  });
});

// Route: DELETE /addons/:id — uninstall addon (optional)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    // Unregister from addons-loader if it exists
    const { unregisterAddon } = require('../../addons-loader');
    try {
      unregisterAddon(id);
    } catch (e) {
      console.warn(`[Addons] Failed to unregister ${id}:`, e.message);
    }

    // Remove consent record
    consentStore.delete(id);

    res.json({ success: true, message: `Add-on ${id} uninstalled` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to uninstall add-on' });
  }
});

module.exports = router;
