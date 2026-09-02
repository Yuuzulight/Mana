// Structured Connectors Capability (#494) — wires structured-connectors-plugin into Mana's capability system
const fs = require("node:fs");
const path = require("node:path");

/**
 * Default data directory for plugin settings. Can be overridden via env var.
 */
const DEFAULT_DATA_DIR = "tools/data";

function createStructuredConnectorsCapability(options = {}) {
  const key = options.key || "@mana/structured-connectors";
  const name = options.name || "Structured Connectors";
  const description = options.description || "Pre-built scrapers for Reddit, YouTube, Amazon, and generic web content";
  
  // Data directory for this capability's settings (same pattern as plugin-settings-store.js)
  const dataDir = options.dataDir || process.env.MANA_CONNECTORS_DATA_DIR || path.join(DEFAULT_DATA_DIR, key);

  return {
    key,
    name,
    description,
    category: "Data Sources", // Groups it in GET /plugins under this label
    defaultEnabled: true, // Enable by default (user can toggle off)
    
    /**
     * Registers API routes for structured data extraction.
     */
    registerRoutes(app, context) {
      const pluginSettingsStore = context.pluginSettingsStore;
      
      if (!pluginSettingsStore) return;

      app.get("/connectors/status", async (req, res) => {
        try {
          // Load the structured-connectors-plugin module dynamically
          let StructuredConnectorsPlugin;
          try {
            StructuredConnectorsPlugin = require("./../plugins/structured-connectors-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Structured connectors plugin not found" });
          }

          const connectors = StructuredConnectorsPlugin.connectorsPlugin;
          
          if (!connectors) {
            return res.status(500).json({ error: "Structured connectors instance not initialized" });
          }

          const status = await connectors.getStatus();
          res.json(status);
        } catch (error) {
          console.error("[StructuredConnectorsCapability] Status check failed:", error.message);
          res.status(500).json({ error: `Failed to get status: ${error.message}` });
        }
      });

      app.post("/connectors/scrape", async (req, res) => {
        try {
          const { sourceType, url, options = {} } = req.body;
          
          if (!sourceType || !url) {
            return res.status(400).json({ error: "Source type and URL are required" });
          }

          let StructuredConnectorsPlugin;
          try {
            StructuredConnectorsPlugin = require("./../plugins/structured-connectors-plugin/src/index.js");
          } catch (e) {
            return res.status(500).json({ error: "Structured connectors plugin not found" });
          }

          const connectors = StructuredConnectorsPlugin.connectorsPlugin;
          
          if (!connectors) {
            return res.status(500).json({ error: "Structured connectors instance not initialized" });
          }

          try {
            const result = await connectors.scrape(sourceType, url, options);
            // Strip sensitive metadata for JSON response
            delete result.resolved;
            res.json(result);
          } catch (error) {
            console.error("[StructuredConnectorsCapability] Scrape failed:", error.message);
            res.status(400).json({ error: `Scrape failed: ${error.message}` });
          }
        } catch (error) {
          console.error("[StructuredConnectorsCapability] Scrape endpoint error:", error.message);
          res.status(500).json({ error: `Server error: ${error.message}` });
        }
      });

      // Optional: contribute context when user mentions specific data sources in chat
      this.contributePromptContext = async (text, context) => {
        if (!pluginSettingsStore.isEnabled(key)) return "";
        
        try {
          const connectors = StructuredConnectorsPlugin.connectorsPlugin;
          
          // Simple heuristic: if text contains source-specific keywords, suggest using structured connectors
          if (/reddit|youtube|amazon|product/i.test(text)) {
            return `
# Data Source Context

Mana can extract structured data from specific platforms for research and analysis. To enable this feature, go to Settings > Plugins and toggle on "Structured Connectors". Once enabled:

- Reddit threads parsed into discussion summaries
- YouTube video metadata extracted for content analysis
- Amazon product pages scraped for price/review tracking

Current status: ${pluginSettingsStore.isEnabled(key) ? "Enabled" : "Disabled"}
            `.trim();
          }
        } catch (error) {
          console.warn("[StructuredConnectorsCapability] Context contribution failed:", error.message);
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
          message: `Structured connectors is disabled. Enable it in Settings > Plugins to access platform-specific data extraction.`,
        };
      }

      try {
        let StructuredConnectorsPlugin;
        try {
          StructuredConnectorsPlugin = require("./../plugins/structured-connectors-plugin/src/index.js");
        } catch (e) {
          return {
            status: "error",
            configured: true,
            message: `Structured connectors plugin module not found at expected path.`,
          };
        }

        const connectors = StructuredConnectorsPlugin.connectorsPlugin;
        
        if (!connectors) {
          return {
            status: "error",
            configured: true,
            message: "Structured connectors instance not initialized.",
          };
        }

        try {
          const status = connectors.getStatus();
          
          // Count how many sources are available
          let availableSources = 0;
          for (const [name, info] of Object.entries(status)) {
            if (info.available) availableSources++;
          }

          return {
            status: "healthy",
            configured: true,
            availableSources: availableSources,
            totalSources: Object.keys(status).length,
            message: `Structured connectors is ready. ${availableSources} data source(s) available for extraction.`,
          };
        } catch (error) {
          return {
            status: "degraded",
            configured: true,
            message: `Structured connectors detected but unable to verify connection: ${error.message}`,
          };
        }
      } catch (error) {
        console.error("[StructuredConnectorsCapability] Health check failed:", error.message);
        return {
          status: "error",
          configured: true,
          message: `Failed to initialize structured connectors health check: ${error.message}`,
        };
      }
    },

    /**
     * Optional: contribute context when user mentions specific data sources in chat.
     */
    contributePromptContext(text, context) {
      if (!pluginSettingsStore.isEnabled(key)) return "";
      
      try {
        const connectors = StructuredConnectorsPlugin.connectorsPlugin;
        
        // Simple heuristic: if text contains source-specific keywords, suggest using structured connectors
        if (/reddit|youtube|amazon|product/i.test(text)) {
          return `
# Data Source Context

Mana can extract structured data from specific platforms for research and analysis. To enable this feature, go to Settings > Plugins and toggle on "Structured Connectors". Once enabled:

- Reddit threads parsed into discussion summaries
- YouTube video metadata extracted for content analysis
- Amazon product pages scraped for price/review tracking

Current status: ${pluginSettingsStore.isEnabled(key) ? "Enabled" : "Disabled"}
          `.trim();
        }
      } catch (error) {
        console.warn("[StructuredConnectorsCapability] Context contribution failed:", error.message);
      }
      
      return "";
    },
  };
}

// server.js requires this module and passes it straight into
// registerCapabilities(app, [...]), same as every other capability file --
// that expects the capability object itself (with a top-level `key`), not
// the factory, so it's called here rather than exported bare.
module.exports = createStructuredConnectorsCapability();
