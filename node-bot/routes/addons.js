/**
 * /api/v1/addons/short-video-gen — MoneyPrinterTurbo-style pipeline orchestration
 * 
 * Dual-tier design:
 * - Plugins = minor features, auto-approved install
 * - Add-ons = full-scale features with explicit consent + OAuth gating
 */

const ShortVideoGenerator = require('../../plugins/short-video-gen');

// Initialize generator instance (singleton pattern for state tracking)
const videoGen = new ShortVideoGenerator({
  tempBase: process.env.MANA_SHORT_VIDEO_TEMP || '/tmp/.mana/video-gen'
});

/**
 * GET /api/v1/addons/short-video-gen/status/:id
 * Returns pipeline execution status and stage outputs
 */
async function handleGetAddonStatus(req, res) {
  const id = req.params.id;
  
  // TODO: Load from persistent state store (Redis/local file)
  const status = {
    id,
    name: 'Short Video Generator Add-on',
    type: 'addon',
    tier: 'advanced',
    lastRun: null,
    stages: videoGen.stageOutputs || {}
  };

  res.json(status);
}

/**
 * POST /api/v1/addons/short-video-gen/generate
 * Trigger end-to-end pipeline execution
 */
async function handleGenerateVideo(req, res) {
  const input = req.body;
  
  if (!input.topic || !input.tone) {
    return res.status(400).json({ error: 'Missing required fields: topic, tone' });
  }

  try {
    // Step 1: Generate script (LLM integration point)
    const script = await videoGen.generateScript(input.topic, input.tone || 'engaging', input.durationSeconds || 60);
    
    // Step 2: Source footage (Pexels/Pixabay/Coverr APIs or local gen)
    const footagePaths = await videoGen.sourceFootage(script, input.topic);
    
    // Step 3: Generate synchronized subtitles
    const subtitleSrt = await videoGen.generateSubtitles();
    
    // Step 4: Compose final video with ffmpeg
    const outputVideoPath = await videoGen.composeVideo(footagePaths, subtitleSrt);
    
    // Step 5: Publish (OAuth-gated per platform)
    if (input.publishTo && input.platformCredentials) {
      for (const platform of input.publishTo) {
        await videoGen.publish(platform, outputVideoPath, input.caption || '');
      }
    }

    res.json({
      success: true,
      outputs: {
        script,
        footagePaths,
        subtitles: subtitleSrt,
        finalVideo: outputVideoPath
      }
    });
  } catch (err) {
    console.error('Pipeline execution failed:', err);
    res.status(500).json({ error: 'Pipeline execution failed', message: err.message });
  }
}

/**
 * POST /api/v1/addons/short-video-gen/consent/:id
 * Explicit consent check for Add-on tier (dual-tier architecture)
 */
async function handleAddonConsent(req, res) {
  const id = req.params.id;
  
  // For Add-ons: require explicit user consent before execution
  const consentData = {
    addonId: id,
    name: 'Short Video Generator Add-on',
    permissions: [
      'read:llm-endpoints',
      'write:local-files',
      'oauth:tiktok',
      'oauth:instagram',
      'oauth:youtube'
    ],
    consentTimestamp: new Date().toISOString(),
    autoApproved: false // Add-ons never auto-approved
  };

  res.json(consentData);
}

module.exports = {
  handleGetAddonStatus,
  handleGenerateVideo,
  handleAddonConsent
};
