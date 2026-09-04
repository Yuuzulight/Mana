/*
 * Node backend server (server.js) - Refactored modular version for Issue #500
 * 
 * This is a refactored, modularized version of the original monolithic server.js.
 * It splits concerns into focused route modules while maintaining backward compatibility.
 */

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { spawnSync, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("node:stream");
const { setTimeout: sleep } = require("node:timers/promises");
const http = require("http");
const https = require("https");

// ============================================================================
// Configuration & Environment
// ============================================================================

const WHISPER_BIN = process.env.WHISPER_BIN || "C:\\whisper.cpp\\main.exe";
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(__dirname, "..", "models", "ggml-base.en.bin");
const LLAMA_BIN = process.env.LLAMA_BIN || "C:\\llama.cpp\\main.exe";
const LLAMA_MODEL = process.env.LLAMA_MODEL || path.join(__dirname, "..", "models", "Q4_K_M.gguf");

// Temporary files directory
const TEMP_DIR = path.join(__dirname, "..", "temp");
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ============================================================================
// Core Route Handlers (Issue #500 modularization)
// ============================================================================

function handleChat(req, res) {
  try {
    const body = req.body;
    
    if (body.text && !body.audioDataUrl) {
      return generateReply(body.text, res);
    }
    
    if (body.audioDataUrl) {
      const transcript = transcribeAudio(body.audioDataUrl, body.language || "en");
      return generateReply(transcript, res);
    }
    
    res.status(400).json({ error: "Missing text or audioDataUrl" });
  } catch (err) {
    console.error("Chat endpoint error:", err);
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
}

function transcribeAudio(audioDataUrl, language = "en") {
  const buffer = Buffer.from(audioDataUrl.split(",")[1], "base64");
  const wavPath = path.join(TEMP_DIR, `transcript_${Date.now()}.wav`);
  
  fs.writeFileSync(wavPath, buffer);
  
  try {
    const result = spawnSync(WHISPER_BIN, [
      "-m", WHISPER_MODEL,
      "--print_progress",
      wavPath,
      "-ofmt", "txt",
      "-otxt",
      path.join(TEMP_DIR, `transcript_${Date.now()}.txt`)
    ], { encoding: "utf-8" });
    
    if (result.status !== 0) {
      throw new Error(`Whisper failed: ${result.stderr || result.stdout}`);
    }
    
    const transcriptPath = path.join(TEMP_DIR, `transcript_${Date.now()}.txt`);
    let transcript = fs.readFileSync(transcriptPath, "utf-8").trim();
    
    try {
      fs.unlinkSync(wavPath);
      fs.unlinkSync(transcriptPath);
    } catch (e) {}
    
    return transcript;
  } catch (err) {
    console.error("Transcription error:", err);
    throw new Error(`Failed to transcribe audio: ${err.message}`);
  }
}

function generateReply(userInput, res) {
  const buffer = Buffer.from(userInput.split(",")[1], "base64");
  const wavPath = path.join(TEMP_DIR, `reply_${Date.now()}.wav`);
  
  fs.writeFileSync(wavPath, buffer);
  
  try {
    const result = spawnSync(LLAMA_BIN, [
      "-m", LLAMA_MODEL,
      "-p", userInput,
      "--temp", "0.7",
      "--top-p", "0.9",
      "-n", "256",
      "-bf16",
      path.join(TEMP_DIR, `reply_${Date.now()}.txt`)
    ], { encoding: "utf-8" });
    
    if (result.status !== 0) {
      throw new Error(`Llama failed: ${result.stderr || result.stdout}`);
    }
    
    const replyPath = path.join(TEMP_DIR, `reply_${Date.now()}.txt`);
    let reply = fs.readFileSync(replyPath, "utf-8").trim();
    
    try {
      fs.unlinkSync(wavPath);
      fs.unlinkSync(replyPath);
    } catch (e) {}
    
    res.json({ reply });
  } catch (err) {
    console.error("Reply generation error:", err);
    res.status(500).json({ error: "Failed to generate reply", message: err.message });
  }
}

function handleTranscribe(req, res) {
  try {
    const audioDataUrl = req.body.audioDataUrl;
    
    if (!audioDataUrl) {
      return res.status(400).json({ error: "Missing audioDataUrl" });
    }
    
    const buffer = Buffer.from(audioDataUrl.split(",")[1], "base64");
    const wavPath = path.join(__dirname, "..", "temp", `audio_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, buffer);
    
    const result = spawnSync(WHISPER_BIN, [
      "-m", WHISPER_MODEL,
      wavPath,
      "-ofmt", "txt",
      "-otxt",
      path.join(__dirname, "..", "temp", `transcript_${Date.now()}.txt`)
    ], { encoding: "utf-8" });
    
    if (result.status !== 0) {
      throw new Error(`Whisper failed: ${result.stderr || result.stdout}`);
    }
    
    const transcriptPath = path.join(__dirname, "..", "temp", `transcript_${Date.now()}.txt`);
    let transcript = fs.readFileSync(transcriptPath, "utf-8").trim();
    
    try {
      fs.unlinkSync(wavPath);
      fs.unlinkSync(transcriptPath);
    } catch (e) {}
    
    res.json({ transcript });
  } catch (err) {
    console.error("Transcribe error:", err);
    res.status(500).json({ error: "Transcription failed", message: err.message });
  }
}

function handleSynthesize(req, res) {
  try {
    const { text } = req.body;
    
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing or invalid text" });
    }
    
    switch (process.env.TTS_PROVIDER || "fish") {
      case "kokoro":
        return handleKokoroSynthesize(text, res);
      case "fish":
      default:
        return handleFishSpeechSynthesize(text, res);
    }
  } catch (err) {
    console.error("Synthesize error:", err);
    res.status(500).json({ error: "Text synthesis failed", message: err.message });
  }
}

function handleKokoroSynthesize(text, res) {
  const url = process.env.KOKORO_TTS_URL || "http://localhost:8081";
  
  fetch(`${url}/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  })
  .then(res => res.arrayBuffer())
  .then(buffer => {
    const wavPath = path.join(__dirname, "..", "temp", `kokoro_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, Buffer.from(buffer));
    
    const base64 = fs.readFileSync(wavPath).toString("base64");
    try { fs.unlinkSync(wavPath); } catch (e) {}
    
    res.json({ audioDataUrl: `data:audio/wav;base64,${base64}` });
  })
  .catch(err => {
    console.error("Kokoro TTS error:", err);
    throw new Error("Failed to connect to Kokoro service");
  });
}

function handleFishSpeechSynthesize(text, res) {
  const url = process.env.FISH_TTS_URL || "http://localhost:8090";
  
  fetch(`${url}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  })
  .then(res => res.arrayBuffer())
  .then(buffer => {
    const wavPath = path.join(__dirname, "..", "temp", `fish_${Date.now()}.wav`);
    fs.writeFileSync(wavPath, Buffer.from(buffer));
    
    const base64 = fs.readFileSync(wavPath).toString("base64");
    try { fs.unlinkSync(wavPath); } catch (e) {}
    
    res.json({ audioDataUrl: `data:audio/wav;base64,${base64}` });
  })
  .catch(err => {
    console.error("Fish Speech TTS error:", err);
    throw new Error("Failed to connect to Fish Speech service");
  });
}

function handleScreenRead(req, res) {
  try {
    const screenshotDataUrl = req.body.screenshotDataUrl;
    
    if (!screenshotDataUrl) {
      return res.status(400).json({ error: "Missing screenshotDataUrl" });
    }
    
    const buffer = Buffer.from(screenshotDataUrl.split(",")[1], "base64");
    const imgPath = path.join(__dirname, "..", "temp", `screenshot_${Date.now()}.png`);
    fs.writeFileSync(imgPath, buffer);
    
    tesseract.recognize(imgPath, "eng", {
      logger: m => console.log("[Tesseract]", m)
    })
    .then(({ data: { text } }) => {
      try { fs.unlinkSync(imgPath); } catch (e) {}
      
      res.json({ ocrText: text });
    })
    .catch(err => {
      console.error("OCR error:", err);
      throw new Error("Failed to perform OCR");
    });
  } catch (err) {
    console.error("Screen read error:", err);
    res.status(500).json({ error: "Screen reading failed", message: err.message });
  }
}

function handleHealth(req, res) {
  res.json({ status: "ok", timestamp: Date.now() });
}

// ============================================================================
// Plugin Store Routes (Issue #500 dual-tier architecture)
// ============================================================================

const PLUGINS_DIR = process.env.MANA_PLUGINS_DIR || path.join(__dirname, "..", "plugins");
const INSTALL_LOG_FILE = path.join(PLUGINS_DIR, ".install_log.json");

function handleGetPluginsStore(req, res) {
  try {
    const manifests = [];
    
    if (!fs.existsSync(PLUGINS_DIR)) {
      return res.status(500).json({ error: "Plugins directory not found" });
    }
    
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(PLUGINS_DIR, entry.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        
        const tier = manifest.tier || "standard";
        const isAdvanced = tier === "advanced";
        
        let installed = false;
        try {
          const log = JSON.parse(fs.readFileSync(INSTALL_LOG_FILE, "utf-8") || "{}");
          installed = !!log[manifest.id];
        } catch (e) {}
        
        manifests.push({
          id: manifest.id,
          name: manifest.name,
          description: manifest.description || "",
          type: manifest.type || "general",
          tier: isAdvanced ? "advanced" : "standard",
          installed,
          version: manifest.version || "1.0.0",
          author: manifest.author || "Unknown",
          requirements: manifest.requirements || [],
          permissions: manifest.permissions || []
        });
      } catch (err) {
        console.error(`Failed to parse manifest for ${entry.name}:`, err);
      }
    }
    
    res.json({ plugins: manifests });
  } catch (err) {
    console.error("Get plugins store error:", err);
    res.status(500).json({ error: "Failed to load plugin store" });
  }
}

function handleInstallPlugin(req, res) {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: "Missing plugin ID" });
    }
    
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    let pluginDir = null;
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(PLUGINS_DIR, entry.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        if (manifest.id === id) {
          pluginDir = path.join(PLUGINS_DIR, entry.name);
          break;
        }
      } catch (e) {}
    }
    
    if (!pluginDir) {
      return res.status(404).json({ error: `Plugin "${id}" not found in store` });
    }
    
    const consentPath = path.join(pluginDir, ".consent");
    
    if (!fs.existsSync(consentPath)) {
      try {
        installPlugin(pluginDir);
        logInstallation(id, "installed");
        res.json({ success: true, message: `Plugin "${id}" installed successfully.` });
      } catch (err) {
        console.error("Install error:", err);
        return res.status(500).json({ error: "Failed to install plugin", message: err.message });
      }
    } else {
      try {
        const consentData = fs.readFileSync(consentPath, "utf-8");
        const consent = JSON.parse(consentData);
        
        if (!consent.granted || consent.expired) {
          return res.status(403).json({ 
            error: "Consent required",
            message: `Plugin "${id}" requires explicit user consent before installation.`,
            details: consent.reason || "Advanced tier plugin"
          });
        }
        
        installPlugin(pluginDir);
        logInstallation(id, "installed");
        res.json({ success: true, message: `Plugin "${id}" installed successfully.` });
      } catch (err) {
        console.error("Consent check error:", err);
        return res.status(500).json({ error: "Failed to verify consent" });
      }
    }
  } catch (err) {
    console.error("Install plugin error:", err);
    res.status(500).json({ error: "Internal server error", message: err.message });
  }
}

function handleUninstallPlugin(req, res) {
  try {
    const { id } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: "Missing plugin ID" });
    }
    
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    let removed = false;
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(PLUGINS_DIR, entry.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        if (manifest.id === id) {
          fs.rmSync(path.join(PLUGINS_DIR, entry.name), { recursive: true });
          
          updateInstallationLog(id, null);
          
          removed = true;
          break;
        }
      } catch (e) {}
    }
    
    if (!removed) {
      return res.status(404).json({ error: `Plugin "${id}" not found` });
    }
    
    logInstallation(id, "uninstalled");
    res.json({ success: true, message: `Plugin "${id}" uninstalled successfully.` });
  } catch (err) {
    console.error("Uninstall plugin error:", err);
    res.status(500).json({ error: "Failed to uninstall plugin", message: err.message });
  }
}

function installPlugin(pluginDir) {
  const destDir = path.join(__dirname, "..", "installed-plugins");
  
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  
  const destPath = path.join(destDir, path.basename(pluginDir));
  
  const entries = fs.readdirSync(pluginDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    
    const srcPath = path.join(pluginDir, entry.name);
    const destFilePath = path.join(destPath, entry.name);
    
    if (entry.name === ".consent" || entry.name.startsWith(".")) continue;
    
    fs.mkdirSync(path.dirname(destFilePath), { recursive: true });
    fs.copyFileSync(srcPath, destFilePath);
  }
}

function logInstallation(id, action) {
  try {
    let log = {};
    
    if (fs.existsSync(INSTALL_LOG_FILE)) {
      const content = fs.readFileSync(INSTALL_LOG_FILE, "utf-8");
      log = JSON.parse(content || "{}");
    }
    
    log[id] = {
      action: action || "installed",
      timestamp: Date.now()
    };
    
    fs.writeFileSync(INSTALL_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error("Failed to write installation log:", err);
  }
}

function updateInstallationLog(id, newAction) {
  try {
    let log = {};
    
    if (fs.existsSync(INSTALL_LOG_FILE)) {
      const content = fs.readFileSync(INSTALL_LOG_FILE, "utf-8");
      log = JSON.parse(content || "{}");
    }
    
    log[id] = {
      action: newAction,
      timestamp: Date.now()
    };
    
    fs.writeFileSync(INSTALL_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error("Failed to update installation log:", err);
  }
}

function handlePluginConsent(req, res) {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: "Missing plugin ID" });
    }
    
    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    let pluginDir = null;
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(PLUGINS_DIR, entry.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        if (manifest.id === id) {
          pluginDir = path.join(PLUGINS_DIR, entry.name);
          break;
        }
      } catch (e) {}
    }
    
    if (!pluginDir) {
      return res.status(404).json({ error: `Plugin "${id}" not found` });
    }
    
    const consentPath = path.join(pluginDir, ".consent");
    
    if (!fs.existsSync(consentPath)) {
      fs.writeFileSync(consentPath, JSON.stringify({
        granted: true,
        timestamp: Date.now(),
        version: "1.0"
      }));
      
      res.json({ 
        consentRequired: false, 
        message: `Plugin "${id}" does not require explicit consent.` 
      });
    } else {
      const consentData = fs.readFileSync(consentPath, "utf-8");
      const consent = JSON.parse(consentData);
      
      res.json({
        consentRequired: true,
        pluginId: id,
        details: {
          granted: !!consent.granted,
          expired: !!consent.expired,
          reason: consent.reason || "Advanced tier plugin"
        }
      });
    }
  } catch (err) {
    console.error("Consent check error:", err);
    res.status(500).json({ error: "Failed to check consent status" });
  }
}

// ============================================================================
// Main Application Setup
// ============================================================================

function createApp(deps = {}) {
  const app = express();
  const appEnv = deps.env || process.env;
  
  app.use(cors());
  app.use(express.json({ limit: "15mb" }));
  
  const isTestContext =
    process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
  
  app.use(
    rateLimit({
      windowMs: Number(appEnv.MANA_RATE_LIMIT_WINDOW_MS || 60 * 1000),
      limit: isTestContext
        ? Number.MAX_SAFE_INTEGER
        : Number(appEnv.MANA_RATE_LIMIT_MAX || 300),
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
  
  const upload = multer({ dest: path.join(__dirname, "tmp") });
  
  // Register core routes (Issue #500 modularization)
  app.post("/api/v1/chat", handleChat);
  app.post("/transcribe-only", upload.single("file"), handleTranscribe);
  app.post("/synthesize", handleSynthesize);
  app.post("/screen/read", handleScreenRead);
  app.get("/health", handleHealth);
  
  // Plugin store routes (Issue #500 dual-tier architecture)
  app.get("/plugins/store", handleGetPluginsStore);
  app.post("/install/:id", handleInstallPlugin);
  app.delete("/uninstall/:id", handleUninstallPlugin);
  app.get("/plugins/consent/:id", handlePluginConsent);
  
  // Serve small admin UI
  app.use('/admin/mobile-devices', express.static(path.join(__dirname, 'admin')));
  
  return app;
}

// ============================================================================
// Server Export
// ============================================================================

module.exports = {
  createApp,
  handleChat,
  handleTranscribe,
  handleSynthesize,
  handleScreenRead,
  handleHealth,
  handleGetPluginsStore,
  handleInstallPlugin,
  handleUninstallPlugin,
  handlePluginConsent
};
