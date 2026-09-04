// Scheduled Export Capability (#495) — wires scheduled-export-plugin into Mana's capability system
const fs = require("node:fs");
const path = require("node:path");

/**
 * Default data directory for plugin settings. Can be overridden via env var.
 */
const DEFAULT_DATA_DIR = "tools/data";

function createScheduledExportCapability(options = {}) {
  const key = options.key || "@mana/scheduled-export";
  const name = options.name || "Scheduled Export";
  const description = options.description || "Automated write-back to Notion, Linear, and Jira";
  
  // Data directory for this capability's settings (same pattern as plugin-settings-store.js)
  const dataDir = options.dataDir || process.env.MANA_SCHEDULED_EXPORT_DATA_DIR || path.join(DEFAULT_DATA_DIR, key);

  return {
    key,
    name,
    description,
    category: "Automation", // Groups it in GET /plugins under this label
    defaultEnabled: false, // Disabled by default (user opt-in)
    
    /**
     * Registers API routes for scheduled export operations.
     */
    registerRoutes(app, context) {
      const pluginSettingsStore = context.pluginSettingsStore;
      
      if (!pluginSettingsStore) return;

      app.get("/scheduled-export/status", async (req, res) => {
        try {
          // Load the scheduled-export-plugin module dynamically
          let ScheduledExportPlugin;
          try {
            ScheduledExportPlugin = require("./../plugins/scheduled-export-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Scheduled export plugin not found" });
          }

          const scheduledExport = ScheduledExportPlugin.scheduledExportPlugin;
          
          if (!scheduledExport) {
            return res.status(500).json({ error: "Scheduled export instance not initialized" });
          }

          const status = await scheduledExport.getStatus();
          res.json(status);
        } catch (error) {
          console.error("[ScheduledExportCapability] Status check failed:", error.message);
          res.status(500).json({ error: `Failed to get status: ${error.message}` });
        }
      });

      app.post("/scheduled-export/authenticate", async (req, res) => {
        try {
          const { providerName, options = {} } = req.body;
          
          if (!providerName || typeof providerName !== "string") {
            return res.status(400).json({ error: "Provider name is required" });
          }

          let ScheduledExportPlugin;
          try {
            ScheduledExportPlugin = require("./../plugins/scheduled-export-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Scheduled export plugin not found" });
          }

          const scheduledExport = ScheduledExportPlugin.scheduledExportPlugin;
          
          if (!scheduledExport) {
            return res.status(500).json({ error: "Scheduled export instance not initialized" });
          }

          try {
            const result = await scheduledExport.authenticate(providerName, options);
            res.json(result);
          } catch (error) {
            console.error("[ScheduledExportCapability] Authentication failed:", error.message);
            res.status(400).json({ error: `Authentication failed: ${error.message}` });
          }
        } catch (error) {
          console.error("[ScheduledExportCapability] Auth endpoint error:", error.message);
          res.status(500).json({ error: `Server error: ${error.message}` });
        }
      });

      app.post("/scheduled-export/export", async (req, res) => {
        try {
          const { providerName, data, options = {} } = req.body;
          
          if (!providerName || !data) {
            return res.status(400).json({ error: "Provider name and export data are required" });
          }

          let ScheduledExportPlugin;
          try {
            ScheduledExportPlugin = require("./../plugins/scheduled-export-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Scheduled export plugin not found" });
          }

          const scheduledExport = ScheduledExportPlugin.scheduledExportPlugin;
          
          if (!scheduledExport) {
            return res.status(500).json({ error: "Scheduled export instance not initialized" });
          }

          try {
            const result = await scheduledExport.runExport(providerName, data, options);
            res.json(result);
          } catch (error) {
            console.error("[ScheduledExportCapability] Export failed:", error.message);
            res.status(400).json({ error: `Export failed: ${error.message}` });
          }
        } catch (error) {
          console.error("[ScheduledExportCapability] Export endpoint error:", error.message);
          res.status(500).json({ error: `Server error: ${error.message}` });
        }
      });

      // Optional: contribute context when user mentions project management tools in chat
      this.contributePromptContext = async (text, context) => {
        if (!pluginSettingsStore.isEnabled(key)) return "";
        
        try {
          const scheduledExport = ScheduledExportPlugin.scheduledExportPlugin;
          
          // Simple heuristic: if text contains PM tool names, suggest using scheduled export
          if (/notion|linear|jira|trello|asana/i.test(text)) {
            return `
# Project Management Context

Mana can automatically sync your work summaries and decisions to project management tools. To enable this feature, go to Settings > Plugins and toggle on "Scheduled Export". Once enabled:

- Weekly digests sent to Notion pages
- Task updates pushed to Linear/Jira issues
- Decision logs archived for future reference

Current status: ${pluginSettingsStore.isEnabled(key) ? "Enabled" : "Disabled"}
            `.trim();
          }
        } catch (error) {
          console.warn("[ScheduledExportCapability] Context contribution failed:", error.message);
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
          message: `Scheduled export is disabled. Enable it in Settings > Plugins to automate project management syncs.`,
        };
      }

      try {
        let ScheduledExportPlugin;
        try {
          ScheduledExportPlugin = require("./../plugins/scheduled-export-plugin/src/index.js");
        } catch (e) {
          return {
            status: "error",
            configured: true,
            message: `Scheduled export plugin module not found at expected path.`,
          };
        }

        const scheduledExport = ScheduledExportPlugin.scheduledExportPlugin;
        
        if (!scheduledExport) {
          return {
            status: "error",
            configured: true,
            message: "Scheduled export instance not initialized.",
          };
        }

        try {
          const status = scheduledExport.getStatus();
          
          // Count how many providers are authenticated
          let authenticatedCount = 0;
          for (const [name, info] of Object.entries(status)) {
            if (info.authenticated) authenticatedCount++;
          }

          return {
            status: "healthy",
            configured: true,
            authenticatedProviders: authenticatedCount,
            totalProviders: Object.keys(status).length,
            message: `Scheduled export is ready. ${authenticatedCount} provider(s) authenticated and active.`,
          };
        } catch (error) {
          return {
            status: "degraded",
            configured: true,
            message: `Scheduled export detected but unable to verify connection: ${error.message}`,
          };
        }
      } catch (error) {
        console.error("[ScheduledExportCapability] Health check failed:", error.message);
        return {
          status: "error",
          configured: true,
          message: `Failed to initialize scheduled export health check: ${error.message}`,
        };
      }
    },

    /**
     * Optional: contribute context when user mentions project management tools in chat.
     */
    contributePromptContext(text, context) {
      if (!pluginSettingsStore.isEnabled(key)) return "";
      
      try {
        const scheduledExport = ScheduledExportPlugin.scheduledExportPlugin;
        
        // Simple heuristic: if text contains PM tool names, suggest using scheduled export
        if (/notion|linear|jira|trello|asana/i.test(text)) {
          return `
# Project Management Context

Mana can automatically sync your work summaries and decisions to project management tools. To enable this feature, go to Settings > Plugins and toggle on "Scheduled Export". Once enabled:

- Weekly digests sent to Notion pages
- Task updates pushed to Linear/Jira issues
- Decision logs archived for future reference

Current status: ${pluginSettingsStore.isEnabled(key) ? "Enabled" : "Disabled"}
          `.trim();
        }
      } catch (error) {
        console.warn("[ScheduledExportCapability] Context contribution failed:", error.message);
      }
      
      return "";
    },
  };
}

// server.js requires this module and passes it straight into
// registerCapabilities(app, [...]), same as every other capability file --
// that expects the capability object itself (with a top-level `key`), not
// the factory, so it's called here rather than exported bare.
module.exports = createScheduledExportCapability();
