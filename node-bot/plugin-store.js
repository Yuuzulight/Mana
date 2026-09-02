// Plugin Store for Mana — fetch from GitHub or local files, install into tools/plugins/
const fs = require("node:fs");
const path = require("node:path");
const https = require("https");

/**
 * Default plugins directory. Can be overridden via MANA_PLUGINS_DIR env var.
 */
const DEFAULT_PLUGINS_DIR = "tools/plugins";

// CodeQL review: every path built by combining a base directory with an
// externally-influenced name (a GitHub manifest's own `name` field, a
// caller-supplied plugin name for get()/uninstall(), a filename scraped
// from HTML) must stay contained within that base directory -- same
// containment check snapshot-store.js's snapshotPath() already uses for
// the identical class of risk. Without it, e.g. a manifest.json with
// `"name": "../../../../important-file"`, or a direct call to
// uninstall("../../../important-file"), could read or delete files
// entirely outside pluginsDir.
function resolveContainedPath(baseDir, relativePath) {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, String(relativePath ?? ""));
  const relative = path.relative(resolvedBase, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to use a path outside ${resolvedBase}: ${relativePath}`);
  }
  return resolved;
}

// CodeQL review (SSRF): the previous checks were plain string-prefix tests
// (url.startsWith("https://github.com/")), which a URL like
// "https://raw.githubusercontent.com@evil.com/..." or
// "https://github.com.evil.com/..." satisfies while actually resolving to
// an attacker-controlled host. Real URL parsing + an exact hostname
// allowlist closes that -- applied at every https.get() call site, not
// just the initial installFromGitHub() input, since downloadAllFiles()
// builds further URLs from scraped HTML content that could point
// somewhere else entirely if the scrape is manipulated.
const ALLOWED_GITHUB_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "api.github.com"]);

function assertAllowedGithubUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (e) {
    throw new Error(`invalid URL: ${urlString}`);
  }
  if (parsed.protocol !== "https:" || !ALLOWED_GITHUB_HOSTS.has(parsed.hostname)) {
    throw new Error(`URL host is not an allowed GitHub host: ${parsed.hostname}`);
  }
  return parsed;
}

class PluginStore {
  constructor(options = {}) {
    this.pluginsDir = options.pluginsDir || process.env.MANA_PLUGINS_DIR || DEFAULT_PLUGINS_DIR;

    // Issue found in review: this used to eagerly mkdirSync(pluginsDir) here,
    // meaning every process that merely requires this module (every test
    // file that requires server.js, since server.js requires this at
    // module scope) creates a real directory on disk as a side effect of
    // importing it -- confirmed by checking node-bot/tools/plugins/
    // existing after a plain `require`. list()/get()/uninstall() already
    // handle a missing pluginsDir gracefully (existsSync checks), and
    // installFromGitHub/installFromDirectory's own mkdirSync(installPath,
    // {recursive:true}) already creates pluginsDir as a parent directory
    // when actually installing something -- installFromZip creates it
    // explicitly itself. No install path needs it pre-created here.

    // Cache for installed plugins (avoids re-scanning on every load)
    this.cache = new Map();
  }

  /**
   * Installs a plugin from a GitHub URL.
   * 
   * @param {string} url - Full GitHub raw URL or repository path
   * @returns {Promise<Object>} Installation result with metadata
   */
  async installFromGitHub(url) {
    if (!url || typeof url !== "string") {
      throw new TypeError("Invalid GitHub URL");
    }

    // Normalize URL to use raw.githubusercontent.com for direct file access.
    // Real URL parsing (assertAllowedGithubUrl), not a string-prefix check --
    // see that function's own comment for why the prefix check it replaces
    // was bypassable.
    let normalizedUrl = url;
    const parsedInput = assertAllowedGithubUrl(url);

    if (parsedInput.hostname === "github.com") {
      // Extract repo path: https://github.com/Yuuzulight/plugin-name -> Yuuzulight/plugin-name
      const match = normalizedUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
      if (!match) throw new Error("Invalid GitHub URL format");

      const owner = match[1];
      const repo = match[2];

      // Use raw.githubusercontent.com for direct file access
      normalizedUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main`;
    } else if (parsedInput.hostname !== "raw.githubusercontent.com") {
      throw new Error("GitHub URL must be a full repository path or use raw.githubusercontent.com");
    }

    try {
      // Fetch manifest.json from the root of the repo
      const manifest = await this.fetchManifest(normalizedUrl);

      if (!manifest || !manifest.name) {
        throw new Error("Invalid plugin: missing 'name' in manifest.json");
      }

      // Create local installation directory
      const installPath = resolveContainedPath(this.pluginsDir, manifest.name.replace(/\//g, "-"));
      
      if (fs.existsSync(installPath)) {
        // Ask user to confirm overwrite
        return {
          success: false,
          error: `Plugin "${manifest.name}" already installed at ${installPath}. Use --force or uninstall first.`,
          manifest: null,
        };
      }

      fs.mkdirSync(installPath, { recursive: true });

      // Download all files from the repo root
      await this.cloneRepository(normalizedUrl, installPath);

      return {
        success: true,
        name: manifest.name,
        version: manifest.version || "0.0.1",
        description: manifest.description || "",
        author: manifest.author || "Unknown",
        installedAt: Date.now(),
        path: installPath,
        url: normalizedUrl,
      };
    } catch (error) {
      // CodeQL review: a user-controlled string as console.error's first
      // argument, with a second argument alongside it, lets Node's
      // printf-style substitution treat any %s/%d/etc the attacker put in
      // `url` as a real format specifier -- merged into one string (no
      // further arguments left to substitute) closes that off. Same fix
      // applied to every other console.error/warn call in this file that
      // had the same shape.
      console.error(`[PluginStore] Failed to install from GitHub (${url}): ${error.message}`);
      return {
        success: false,
        error: `Installation failed: ${error.message}`,
        manifest: null,
      };
    }
  }

  /**
   * Installs a plugin from a local file path or zip archive.
   * 
   * @param {string} filePath - Path to manifest.json, zip file, or directory
   * @returns {Promise<Object>} Installation result with metadata
   */
  async installFromLocal(filePath) {
    if (!filePath || typeof filePath !== "string") {
      throw new TypeError("Invalid local file path");
    }

    const resolvedPath = path.resolve(filePath);

    // Check if it's a zip archive
    if (resolvedPath.endsWith(".zip")) {
      return await this.installFromZip(resolvedPath);
    }

    // Check if it's a directory containing manifest.json
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      const manifestPath = path.join(resolvedPath, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        return await this.installFromDirectory(resolvedPath);
      }
    }

    // Assume it's a manifest.json file directly
    if (resolvedPath.endsWith("manifest.json")) {
      const dir = path.dirname(resolvedPath);
      return await this.installFromDirectory(dir);
    }

    throw new Error(`Invalid local plugin source: ${filePath}`);
  }

  /**
   * Fetches manifest.json from a GitHub repository URL.
   */
  async fetchManifest(baseUrl) {
    const url = `${baseUrl}/manifest.json`;
    // .href (the validated URL object's own serialization), not the
    // original `url` string, is what actually reaches https.get() -- so
    // the sink's argument provably derives from a passed validation,
    // rather than merely having a validation call sit next to it.
    const safeUrl = assertAllowedGithubUrl(url).href;

    return new Promise((resolve, reject) => {
      https.get(safeUrl, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Failed to fetch manifest: HTTP ${res.statusCode}`));
          return;
        }

        let data = "";
        
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            
            if (!parsed || typeof parsed !== "object") {
              reject(new Error("Invalid manifest: not a valid JSON object"));
              return;
            }

            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse manifest.json: ${e.message}`));
          }
        });
      }).on("error", reject);
    });
  }

  /**
   * Clones a GitHub repository into the local installation directory.
   */
  async cloneRepository(url, destDir) {
    const { execFile } = require("child_process");
    const runGit = (args) =>
      new Promise((resolve, reject) => {
        // execFile with an argv array (shell: false, the default) -- url is
        // untrusted input (a repo URL supplied to installFromGitHub), and
        // the previous exec()-based version string-interpolated it into a
        // shell command line, letting shell metacharacters in a crafted URL
        // run as a second command (flagged by CodeQL as a critical
        // "uncontrolled command line" finding).
        execFile("git", args, { cwd: destDir, windowsHide: true }, (error, stdout, stderr) => {
          if (error) {
            error.stderr = stderr;
            reject(error);
            return;
          }
          resolve(stdout);
        });
      });

    try {
      await runGit(["init"]);
      await runGit(["remote", "add", "origin", url]);
      await runGit(["fetch", "--depth=1", "origin", "main"]);
    } catch (error) {
      // Fallback to manual file download if git fails
      console.warn(`[PluginStore] Git clone failed: ${error.stderr || error.message}. Falling back to file download.`);
      await this.downloadAllFiles(url, destDir);
    }
  }

  /**
   * Downloads all files from a GitHub repository URL.
   */
  async downloadAllFiles(baseUrl, destDir) {
    // This is a simplified fallback — in production, use proper Git LFS or API pagination
    console.warn(`[PluginStore] Using fallback file download for ${baseUrl}`);

    const url = `${baseUrl}/`;
    const safeUrl = assertAllowedGithubUrl(url).href;

    return new Promise((resolve, reject) => {
      https.get(safeUrl, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Failed to list repository: HTTP ${res.statusCode}`));
          return;
        }

        let html = "";
        
        res.on("data", chunk => html += chunk);
        res.on("end", () => {
          // Extract file links from HTML (simplified parser)
          const linkRegex = /href="([^"]+)"[^>]*>([^<]+)<\//g;
          let match;
          
          while ((match = linkRegex.exec(html)) !== null) {
            const href = decodeURIComponent(match[1]);
            if (href.startsWith("blob/") && !href.endsWith(".git")) {
              // Extract file path from blob URL
              const filePath = href.replace(/^blob\/([^/]+)\//, "$1");
              
              // Download individual file
              this.downloadFile(`${baseUrl}/${filePath}`, destDir).catch(err => {
                console.warn(`[PluginStore] Failed to download ${filePath}: ${err.message}`);
              });
            }
          }

          resolve();
        });
      }).on("error", reject);
    });
  }

  /**
   * Downloads a single file from GitHub.
   */
  async downloadFile(url, destDir) {
    const safeUrl = assertAllowedGithubUrl(url).href;

    return new Promise((resolve, reject) => {
      https.get(safeUrl, (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Failed to download file: HTTP ${res.statusCode}`));
          return;
        }

        // CodeQL review: the path portion of `url` came from HTML this
        // module itself scraped (downloadAllFiles' href extraction) -- a
        // crafted "../../../../somewhere-important" path segment there
        // must not be able to write outside destDir.
        const destPath = resolveContainedPath(
          destDir,
          url.replace(/^https:\/\/[^/]+\/([^?#]+)/, "$1"),
        );

        fs.mkdirSync(path.dirname(destPath), { recursive: true });

        const writer = fs.createWriteStream(destPath);
        
        res.pipe(writer).on("finish", resolve).on("error", reject);
      }).on("error", reject);
    });
  }

  /**
   * Installs a plugin from a zip archive.
   */
  async installFromZip(zipPath) {
    // Issue found in review: the previous version required("unzipper"), a
    // package that's neither declared in package.json nor installed, and
    // whose actual API (Open.file(...).extract(...)) doesn't even match
    // what this code called (Unzipper.OpenZip(...)) -- guaranteed to throw
    // regardless. No zip-handling dependency exists anywhere else in this
    // codebase either, so this uses PowerShell's built-in Expand-Archive
    // (same spawnSync("powershell", [...]) pattern server.js's own
    // gaming-process-snapshot code already uses) instead of adding one.
    // Paths are passed as PowerShell parameters, not interpolated into the
    // -Command script text, matching cloneRepository's execFile fix above.
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    const { execFile } = require("child_process");

    return new Promise((resolve, reject) => {
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          // Values travel via the environment, not command-line parameter
          // binding -- `-Command <script> -Name value` does NOT bind
          // trailing args to a param() block the way `-File script.ps1
          // -Name value` does (verified directly: it threw "argument is
          // null or empty"). Env vars sidestep that entirely, with the
          // same no-string-interpolation safety property.
          "Expand-Archive -LiteralPath $env:MANA_PLUGIN_ZIP_PATH -DestinationPath $env:MANA_PLUGIN_DEST_DIR -Force",
        ],
        {
          windowsHide: true,
          env: {
            ...process.env,
            MANA_PLUGIN_ZIP_PATH: zipPath,
            MANA_PLUGIN_DEST_DIR: this.pluginsDir,
          },
        },
        (error) => {
          if (error) {
            reject(new Error(`Failed to extract zip archive: ${error.message}`));
            return;
          }

          // Find the installed plugin directory (should have manifest.json).
          // Entries here come straight from readdirSync -- real filesystem
          // entry names, not attacker-suppliable strings -- but routed
          // through the same resolveContainedPath as every other lookup
          // for consistency and to satisfy CodeQL's (here conservative)
          // taint tracking.
          const plugins = fs.readdirSync(this.pluginsDir);

          let foundPlugin;
          for (const name of plugins) {
            const pluginDir = resolveContainedPath(this.pluginsDir, name);
            const manifestPath = path.join(pluginDir, "manifest.json");
            if (!fs.existsSync(manifestPath)) continue;

            try {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

              foundPlugin = {
                success: true,
                name: manifest.name || name,
                version: manifest.version || "0.0.1",
                description: manifest.description || "",
                author: manifest.author || "Unknown",
                installedAt: Date.now(),
                path: pluginDir,
                url: `zip:${zipPath}`,
              };
              
              break;
            } catch (e) {
              // Skip invalid manifests
            }
          }

          if (!foundPlugin) {
            reject(new Error("No valid plugin found in zip archive"));
          } else {
            resolve(foundPlugin);
          }
        },
      );
    });
  }

  /**
   * Installs a plugin from an existing directory containing manifest.json.
   */
  async installFromDirectory(dirPath) {
    const manifestPath = path.join(dirPath, "manifest.json");
    
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No manifest.json found in ${dirPath}`);
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      
      // Validate required fields
      if (!manifest.name) {
        throw new Error("Invalid plugin: missing 'name' in manifest.json");
      }

      // Create installation directory (copy files to avoid conflicts)
      const installPath = resolveContainedPath(this.pluginsDir, manifest.name.replace(/\//g, "-"));
      
      fs.mkdirSync(installPath, { recursive: true });

      // Copy all files from source directory
      this.copyDirectory(dirPath, installPath);

      return {
        success: true,
        name: manifest.name,
        version: manifest.version || "0.0.1",
        description: manifest.description || "",
        author: manifest.author || "Unknown",
        installedAt: Date.now(),
        path: installPath,
        url: `file:${dirPath}`,
      };
    } catch (error) {
      console.error(`[PluginStore] Failed to install from directory (${dirPath}): ${error.message}`);
      return {
        success: false,
        error: `Installation failed: ${error.message}`,
        manifest: null,
      };
    }
  }

  /**
   * Copies a directory recursively.
   */
  copyDirectory(srcDir, destDir) {
    if (!fs.existsSync(srcDir)) return;

    const items = fs.readdirSync(srcDir);

    for (const item of items) {
      const srcPath = path.join(srcDir, item);
      // item is a real filesystem entry name from readdirSync, not
      // attacker-suppliable, but contained for consistency with every
      // other lookup in this file (see resolveContainedPath's own comment).
      const destPath = resolveContainedPath(destDir, item);

      if (fs.statSync(srcPath).isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        this.copyDirectory(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Lists all installed plugins.
   */
  list() {
    const plugins = [];
    
    if (!fs.existsSync(this.pluginsDir)) return plugins;

    for (const name of fs.readdirSync(this.pluginsDir)) {
      const pluginDir = resolveContainedPath(this.pluginsDir, name);
      const manifestPath = path.join(pluginDir, "manifest.json");

      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

        plugins.push({
          name: manifest.name || name,
          version: manifest.version || "0.0.1",
          description: manifest.description || "",
          author: manifest.author || "Unknown",
          installedAt: Date.now(),
          path: pluginDir,
        });
      } catch (e) {
        // Skip invalid manifests
      }
    }

    return plugins;
  }

  /**
   * Uninstalls a plugin by name.
   */
  uninstall(name) {
    // The most consequential of the path-containment fixes in this file:
    // this is a destructive, recursive delete, and `name` is a direct,
    // unvalidated caller-supplied string (reachable via the plugin-store
    // API) -- without containment, uninstall("../../../something-real")
    // would rm -rf something entirely outside pluginsDir.
    let installPath;
    try {
      installPath = resolveContainedPath(this.pluginsDir, name);
    } catch (e) {
      return false;
    }

    if (!fs.existsSync(installPath)) {
      return false; // Not found
    }

    try {
      fs.rmSync(installPath, { recursive: true, force: true });
      this.cache.delete(name);
      return true;
    } catch (e) {
      console.error(`[PluginStore] Failed to uninstall ${name}: ${e.message}`);
      return false;
    }
  }

  /**
   * Gets a plugin's manifest by name.
   */
  get(name) {
    if (this.cache.has(name)) {
      return this.cache.get(name);
    }

    let installPath;
    try {
      installPath = resolveContainedPath(this.pluginsDir, name);
    } catch (e) {
      return null;
    }

    if (!fs.existsSync(installPath)) {
      return null;
    }

    try {
      const manifestPath = path.join(installPath, "manifest.json");
      
      if (!fs.existsSync(manifestPath)) {
        return null;
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      
      // Cache the result
      this.cache.set(name, {
        name: manifest.name || name,
        version: manifest.version || "0.0.1",
        description: manifest.description || "",
        author: manifest.author || "Unknown",
        installedAt: Date.now(),
        path: installPath,
      });

      return this.cache.get(name);
    } catch (e) {
      console.error(`[PluginStore] Failed to load manifest for ${name}: ${e.message}`);
      return null;
    }
  }

  /**
   * Searches plugins by name or description.
   */
  search(query) {
    if (!query || typeof query !== "string") return [];

    const normalizedQuery = query.toLowerCase();
    
    return this.list().filter((plugin) =>
      plugin.name.toLowerCase().includes(normalizedQuery) ||
      (plugin.description && plugin.description.toLowerCase().includes(normalizedQuery))
    );
  }
}

// Singleton instance for Mana integration
const pluginStore = new PluginStore();

module.exports = {
  PluginStore,
  pluginStore, // Singleton instance for Mana integration
};
