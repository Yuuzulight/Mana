/*
 * Plugin store and management endpoints (dual-tier architecture)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration
const PLUGINS_DIR = process.env.MANA_PLUGINS_DIR || path.join(__dirname, '..', 'plugins');
const INSTALL_LOG_FILE = path.join(PLUGINS_DIR, '.install_log.json');

function handleGetPluginsStore(req, res) {
  try {
    // Scan plugins directory for manifest files
    const manifests = [];
    
    if (!fs.existsSync(PLUGINS_DIR)) {
      return res.status(500).json({ error: 'Plugins directory not found' });
    }
    
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        
        // Check for tier field (dual-tier support)
        const tier = manifest.tier || 'standard';
        const isAdvanced = tier === 'advanced';
        
        // Determine installation status
        let installed = false;
        try {
          const log = JSON.parse(fs.readFileSync(INSTALL_LOG_FILE, 'utf-8') || '{}');
          installed = !!log[manifest.id];
        } catch (e) {}
        
        manifests.push({
          id: manifest.id,
          name: manifest.name,
          description: manifest.description || '',
          type: manifest.type || 'general',
          tier: isAdvanced ? 'advanced' : 'standard',
          installed,
          version: manifest.version || '1.0.0',
          author: manifest.author || 'Unknown',
          requirements: manifest.requirements || [],
          permissions: manifest.permissions || []
        });
      } catch (err) {
        console.error(`Failed to parse manifest for ${entry.name}:`, err);
      }
    }
    
    res.json({ plugins: manifests });
  } catch (err) {
    console.error('Get plugins store error:', err);
    res.status(500).json({ error: 'Failed to load plugin store' });
  }
}

function handleInstallPlugin(req, res) {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: 'Missing plugin ID' });
    }
    
    // Find plugin directory
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    let pluginDir = null;
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (manifest.id === id) {
          pluginDir = path.join(PLUGINS_DIR, entry.name);
          break;
        }
      } catch (e) {}
    }
    
    if (!pluginDir) {
      return res.status(404).json({ error: `Plugin "${id}" not found in store` });
    }
    
    // Check for consent file (dual-tier requirement)
    const consentPath = path.join(pluginDir, '.consent');
    let requiresConsent = false;
    
    if (!fs.existsSync(consentPath)) {
      // No consent file means standard tier or auto-approved
      try {
        installPlugin(pluginDir);
        logInstallation(id, 'installed');
        res.json({ success: true, message: `Plugin "${id}" installed successfully.` });
      } catch (err) {
        console.error('Install error:', err);
        return res.status(500).json({ error: 'Failed to install plugin', message: err.message });
      }
    } else {
      // Consent file exists - advanced tier requires explicit consent
      try {
        const consentData = fs.readFileSync(consentPath, 'utf-8');
        const consent = JSON.parse(consentData);
        
        if (!consent.granted || consent.expired) {
          return res.status(403).json({ 
            error: 'Consent required',
            message: `Plugin "${id}" requires explicit user consent before installation.`,
            details: consent.reason || 'Advanced tier plugin'
          });
        }
        
        installPlugin(pluginDir);
        logInstallation(id, 'installed');
        res.json({ success: true, message: `Plugin "${id}" installed successfully.` });
      } catch (err) {
        console.error('Consent check error:', err);
        return res.status(500).json({ error: 'Failed to verify consent' });
      }
    }
  } catch (err) {
    console.error('Install plugin error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

function handleUninstallPlugin(req, res) {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: 'Missing plugin ID' });
    }
    
    // Find and remove plugin directory
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    let removed = false;
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (manifest.id === id) {
          fs.rmSync(path.join(PLUGINS_DIR, entry.name), { recursive: true });
          
          // Update installation log
          updateInstallationLog(id, null);
          
          removed = true;
          break;
        }
      } catch (e) {}
    }
    
    if (!removed) {
      return res.status(404).json({ error: `Plugin "${id}" not found` });
    }
    
    logInstallation(id, 'uninstalled');
    res.json({ success: true, message: `Plugin "${id}" uninstalled successfully.` });
  } catch (err) {
    console.error('Uninstall plugin error:', err);
    res.status(500).json({ error: 'Failed to uninstall plugin', message: err.message });
  }
}

function installPlugin(pluginDir) {
  // Copy plugin files to installation directory
  const destDir = path.join(__dirname, '..', 'installed-plugins');
  
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  
  const destPath = path.join(destDir, path.basename(pluginDir));
  
  // Copy all files except consent and metadata
  const entries = fs.readdirSync(pluginDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    
    const srcPath = path.join(pluginDir, entry.name);
    const destFilePath = path.join(destPath, entry.name);
    
    // Skip consent and metadata files
    if (entry.name === '.consent' || entry.name.startsWith('.')) continue;
    
    fs.mkdirSync(path.dirname(destFilePath), { recursive: true });
    fs.copyFileSync(srcPath, destFilePath);
  }
}

function logInstallation(id, action) {
  try {
    let log = {};
    
    if (fs.existsSync(INSTALL_LOG_FILE)) {
      const content = fs.readFileSync(INSTALL_LOG_FILE, 'utf-8');
      log = JSON.parse(content || '{}');
    }
    
    log[id] = {
      action: action || 'installed',
      timestamp: Date.now()
    };
    
    fs.writeFileSync(INSTALL_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error('Failed to write installation log:', err);
  }
}

function updateInstallationLog(id, newAction) {
  try {
    let log = {};
    
    if (fs.existsSync(INSTALL_LOG_FILE)) {
      const content = fs.readFileSync(INSTALL_LOG_FILE, 'utf-8');
      log = JSON.parse(content || '{}');
    }
    
    log[id] = {
      action: newAction,
      timestamp: Date.now()
    };
    
    fs.writeFileSync(INSTALL_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error('Failed to update installation log:', err);
  }
}

function handlePluginConsent(req, res) {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: 'Missing plugin ID' });
    }
    
    // Find consent file
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    let pluginDir = null;
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (manifest.id === id) {
          pluginDir = path.join(PLUGINS_DIR, entry.name);
          break;
        }
      } catch (e) {}
    }
    
    if (!pluginDir) {
      return res.status(404).json({ error: `Plugin "${id}" not found` });
    }
    
    const consentPath = path.join(pluginDir, '.consent');
    
    // If no consent file exists, create one with auto-approval (standard tier behavior)
    if (!fs.existsSync(consentPath)) {
      fs.writeFileSync(consentPath, JSON.stringify({
        granted: true,
        timestamp: Date.now(),
        version: '1.0'
      }));
      
      res.json({ 
        consentRequired: false, 
        message: `Plugin "${id}" does not require explicit consent.` 
      });
    } else {
      // Read existing consent
      const consentData = fs.readFileSync(consentPath, 'utf-8');
      const consent = JSON.parse(consentData);
      
      res.json({
        consentRequired: true,
        pluginId: id,
        details: {
          granted: !!consent.granted,
          expired: !!consent.expired,
          reason: consent.reason || 'Advanced tier plugin'
        }
      });
    }
  } catch (err) {
    console.error('Consent check error:', err);
    res.status(500).json({ error: 'Failed to check consent status' });
  }
}

module.exports = {
  handleGetPluginsStore,
  handleInstallPlugin,
  handleUninstallPlugin,
  handlePluginConsent
};
