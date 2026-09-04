// Cloud Sync Capability (#496) — wires cloud-sync-plugin into Mana's capability system
const fs = require("node:fs");
const path = require("node:path");

/**
 * Default data directory for plugin settings. Can be overridden via env var.
 */
const DEFAULT_DATA_DIR = "tools/data";

function createCloudSyncCapability(options = {}) {
  const key = options.key || "@mana/cloud-sync";
  const name = options.name || "Cloud Sync";
  const description = options.description || "Virtual drive integration for Google Drive, Dropbox, and OneDrive";
  
  // Data directory for this capability's settings (same pattern as plugin-settings-store.js)
  const dataDir = options.dataDir || process.env.MANA_CLOUD_SYNC_DATA_DIR || path.join(DEFAULT_DATA_DIR, key);

  return {
    key,
    name,
    description,
    category: "Cloud Storage", // Groups it in GET /plugins under this label
    // Issue found in review: the plugin this wraps
    // (plugins/cloud-sync-plugin/src/index.js) doesn't exist yet -- every
    // route 500s "not found" until it's built. Defaulting to enabled would
    // show this as active in Settings > Plugins while doing nothing;
    // matches every other capability wrapping a not-yet-built/optional
    // plugin elsewhere in this codebase (matrixBridge, telegramBridge,
    // etc.), all opt-in by default.
    defaultEnabled: false,
    
    /**
     * Registers API routes for cloud sync operations.
     */
    registerRoutes(app, context) {
      const pluginSettingsStore = context.pluginSettingsStore;
      
      if (!pluginSettingsStore) return;

      app.get("/cloud-sync/status", async (req, res) => {
        try {
          // Load the cloud-sync-plugin module dynamically
          let CloudSyncPlugin;
          try {
            CloudSyncPlugin = require("./../plugins/cloud-sync-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Cloud sync plugin not found" });
          }

          const cloudSync = CloudSyncPlugin.cloudSyncPlugin;
          
          if (!cloudSync) {
            return res.status(500).json({ error: "Cloud sync instance not initialized" });
          }

          const status = await cloudSync.getStatus();
          res.json(status);
        } catch (error) {
          console.error("[CloudSyncCapability] Status check failed:", error.message);
          res.status(500).json({ error: `Failed to get status: ${error.message}` });
        }
      });

      app.post("/cloud-sync/authenticate", async (req, res) => {
        try {
          const { providerName, options = {} } = req.body;
          
          if (!providerName || typeof providerName !== "string") {
            return res.status(400).json({ error: "Provider name is required" });
          }

          let CloudSyncPlugin;
          try {
            CloudSyncPlugin = require("./../plugins/cloud-sync-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Cloud sync plugin not found" });
          }

          const cloudSync = CloudSyncPlugin.cloudSyncPlugin;
          
          if (!cloudSync) {
            return res.status(500).json({ error: "Cloud sync instance not initialized" });
          }

          try {
            const result = await cloudSync.authenticate(providerName, options);
            res.json(result);
          } catch (error) {
            console.error("[CloudSyncCapability] Authentication failed:", error.message);
            res.status(400).json({ error: `Authentication failed: ${error.message}` });
          }
        } catch (error) {
          console.error("[CloudSyncCapability] Auth endpoint error:", error.message);
          res.status(500).json({ error: `Server error: ${error.message}` });
        }
      });

      app.post("/cloud-sync/refresh", async (req, res) => {
        try {
          const { providerName } = req.body;
          
          if (!providerName || typeof providerName !== "string") {
            return res.status(400).json({ error: "Provider name is required" });
          }

          let CloudSyncPlugin;
          try {
            CloudSyncPlugin = require("./../plugins/cloud-sync-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Cloud sync plugin not found" });
          }

          const cloudSync = CloudSyncPlugin.cloudSyncPlugin;
          
          if (!cloudSync) {
            return res.status(500).json({ error: "Cloud sync instance not initialized" });
          }

          try {
            await cloudSync.refresh(providerName);
            res.json({ success: true, message: `Refreshed ${providerName}` });
          } catch (error) {
            console.error("[CloudSyncCapability] Refresh failed:", error.message);
            res.status(400).json({ error: `Refresh failed: ${error.message}` });
          }
        } catch (error) {
          console.error("[CloudSyncCapability] Refresh endpoint error:", error.message);
          res.status(500).json({ error: `Server error: ${error.message}` });
        }
      });

      app.get("/cloud-sync/list", async (req, res) => {
        try {
          const { providerName } = req.query;
          
          let CloudSyncPlugin;
          try {
            CloudSyncPlugin = require("./../plugins/cloud-sync-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Cloud sync plugin not found" });
          }

          const cloudSync = CloudSyncPlugin.cloudSyncPlugin;
          
          if (!cloudSync) {
            return res.status(500).json({ error: "Cloud sync instance not initialized" });
          }

          try {
            const result = await cloudSync.list(providerName || undefined, req.query);
            res.json(result);
          } catch (error) {
            console.error("[CloudSyncCapability] List failed:", error.message);
            res.status(400).json({ error: `List failed: ${error.message}` });
          }
        } catch (error) {
          console.error("[CloudSyncCapability] List endpoint error:", error.message);
          res.status(500).json({ error: `Server error: ${error.message}` });
        }
      });

      app.post("/cloud-sync/read", async (req, res) => {
        try {
          const { providerName, filePath } = req.body;
          
          if (!providerName || !filePath) {
            return res.status(400).json({ error: "Provider name and file path are required" });
          }

          let CloudSyncPlugin;
          try {
            CloudSyncPlugin = require("./../plugins/cloud-sync-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Cloud sync plugin not found" });
          }

          const cloudSync = CloudSyncPlugin.cloudSyncPlugin;
          
          if (!cloudSync) {
            return res.status(500).json({ error: "Cloud sync instance not initialized" });
          }

          try {
            const result = await cloudSync.read(providerName, filePath);
            // Strip sensitive metadata for JSON response
            delete result.resolved;
            res.json(result);
          } catch (error) {
            console.error("[CloudSyncCapability] Read failed:", error.message);
            res.status(400).json({ error: `Read failed: ${error.message}` });
          }
        } catch (error) {
          console.error("[CloudSyncCapability] Read endpoint error:", error.message);
          res.status(500).json({ error: `Server error: ${error.message}` });
        }
      });

      app.post("/cloud-sync/write", async (req, res) => {
        try {
          const { providerName, filePath, content, options = {} } = req.body;
          
          if (!providerName || !filePath || typeof content !== "string") {
            return res.status(400).json({ error: "Provider name, file path, and content are required" });
          }

          let CloudSyncPlugin;
          try {
            CloudSyncPlugin = require("./../plugins/cloud-sync-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Cloud sync plugin not found" });
          }

          const cloudSync = CloudSyncPlugin.cloudSyncPlugin;
          
          if (!cloudSync) {
            return res.status(500).json({ error: "Cloud sync instance not initialized" });
          }

          try {
            await cloudSync.write(providerName, filePath, content, options);
            res.json({ success: true, message: `Wrote ${filePath} to ${providerName}` });
          } catch (error) {
            console.error("[CloudSyncCapability] Write failed:", error.message);
            res.status(400).json({ error: `Write failed: ${error.message}` });
          }
        } catch (error) {
          console.error("[CloudSyncCapability] Write endpoint error:", error.message);
          res.status(500).json({ error: `Server error: ${error.message}` });
        }
      });

      app.post("/cloud-sync/delete", async (req, res) => {
        try {
          const { providerName, filePath } = req.body;
          
          if (!providerName || !filePath) {
            return res.status(400).json({ error: "Provider name and file path are required" });
          }

          let CloudSyncPlugin;
          try {
            CloudSyncPlugin = require("./../plugins/cloud-sync-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Cloud sync plugin not found" });
          }

          const cloudSync = CloudSyncPlugin.cloudSyncPlugin;
          
          if (!cloudSync) {
            return res.status(500).json({ error: "Cloud sync instance not initialized" });
          }

          try {
            await cloudSync.delete(providerName, filePath);
            res.json({ success: true, message: `Deleted ${filePath} from ${providerName}` });
          } catch (error) {
            console.error("[CloudSyncCapability] Delete failed:", error.message);
            res.status(400).json({ error: `Delete failed: ${error.message}` });
          }
        } catch (error) {
          console.error("[CloudSyncCapability] Delete endpoint error:", error.message);
          res.status(500).json({ error: `Server error: ${error.message}` });
        }
      });

      // Optional: contribute context when user mentions cloud files in chat
      this.contributePromptContext = async (text, context) => {
        if (!pluginSettingsStore.isEnabled(key)) return "";
        
        try {
          const cloudSync = CloudSyncPlugin.cloudSyncPlugin;
          
          // Simple heuristic: if text contains file paths or "cloud", suggest using cloud sync
          if (/\.(\w+)$|cloud|drive|dropbox/i.test(text)) {
            return `
# Cloud Storage Context

Mana can access files from your connected cloud storage providers. To enable this feature, go to Settings > Plugins and toggle on "Cloud Sync". Once enabled, you can:

- Upload documents for analysis
- Access research materials stored in the cloud
- Stream audio content directly from cloud drives

Current status: ${pluginSettingsStore.isEnabled(key) ? "Enabled" : "Disabled"}
            `.trim();
          }
        } catch (error) {
          console.warn("[CloudSyncCapability] Context contribution failed:", error.message);
        }
        
        return "";
      };
    },

    /**
     * Reports health status for the /health endpoint.
     */
    getHealth(context) {
      const pluginSettingsStore = context.pluginSettingsStore;
      
      if (!pluginSettingsStore || !pluginSettingsStore.isEnabled(key)) {
        return {
          status: "disabled",
          configured: false,
          message: `Cloud sync is disabled. Enable it in Settings > Plugins to access virtual drive features.`,
        };
      }

      try {
        let CloudSyncPlugin;
        try {
          CloudSyncPlugin = require("./../plugins/cloud-sync-plugin/src/index.js");
        } catch (e) {
          return {
            status: "error",
            configured: true,
            message: `Cloud sync plugin module not found at expected path.`,
          };
        }

        const cloudSync = CloudSyncPlugin.cloudSyncPlugin;
        
        if (!cloudSync) {
          return {
            status: "error",
            configured: true,
            message: "Cloud sync instance not initialized.",
          };
        }

        try {
          const status = cloudSync.getStatus();
          
          // Count how many providers are mounted
          let mountedCount = 0;
          for (const [name, info] of Object.entries(status)) {
            if (info.mounted) mountedCount++;
          }

          return {
            status: "healthy",
            configured: true,
            mountedProviders: mountedCount,
            totalProviders: Object.keys(status).length,
            message: `Cloud sync is ready. ${mountedCount} provider(s) mounted and active.`,
          };
        } catch (error) {
          return {
            status: "degraded",
            configured: true,
            message: `Cloud sync detected but unable to verify connection: ${error.message}`,
          };
        }
      } catch (error) {
        console.error("[CloudSyncCapability] Health check failed:", error.message);
        return {
          status: "error",
          configured: true,
          message: `Failed to initialize cloud sync health check: ${error.message}`,
        };
      }
    },

    /**
     * Optional: contribute context when user mentions cloud files in chat.
     */
    contributePromptContext(text, context) {
      if (!pluginSettingsStore.isEnabled(key)) return "";
      
      try {
        const cloudSync = CloudSyncPlugin.cloudSyncPlugin;
        
        // Simple heuristic: if text contains file paths or "cloud", suggest using cloud sync
        if (/\.(\w+)$|cloud|drive|dropbox/i.test(text)) {
          return `
# Cloud Storage Context

Mana can access files from your connected cloud storage providers. To enable this feature, go to Settings > Plugins and toggle on "Cloud Sync". Once enabled, you can:

- Upload documents for analysis
- Access research materials stored in the cloud
- Stream audio content directly from cloud drives

Current status: ${pluginSettingsStore.isEnabled(key) ? "Enabled" : "Disabled"}
          `.trim();
        }
      } catch (error) {
        console.warn("[CloudSyncCapability] Context contribution failed:", error.message);
      }
      
      return "";
    },
  };
}

// server.js requires this module and passes it straight into
// registerCapabilities(app, [...]), same as every other capability file --
// that expects the capability object itself (with a top-level `key`), not
// the factory, so it's called here rather than exported bare.
module.exports = createCloudSyncCapability();
