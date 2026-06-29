function createVTubeRuntime(options = {}) {
  const env = options.env || process.env;
  const vtubeStudio = options.vtubeStudio || null;
  const vtubeStudioUrl =
    options.vtubeStudioUrl || env.VTUBE_STUDIO_URL || "ws://127.0.0.1:8001";
  const reactionsJson = env.VTUBE_STUDIO_REACTIONS_JSON || "{}";

  function parseVTubeReactions() {
    try {
      const parsed = JSON.parse(reactionsJson);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (error) {
      console.warn("VTUBE_STUDIO_REACTIONS_JSON must be a JSON object");
      return {};
    }
  }

  function pickVTubeReaction(text) {
    const reactions = parseVTubeReactions();
    const lowerText = String(text || "").toLowerCase();

    for (const [phrase, hotkeyName] of Object.entries(reactions)) {
      if (phrase && phrase !== "default" && lowerText.includes(phrase.toLowerCase())) {
        return hotkeyName;
      }
    }

    return reactions.default || null;
  }

  async function triggerVTubeReactionForReply(reply) {
    if (!vtubeStudio || !reply) {
      return null;
    }

    const hotkeyName = pickVTubeReaction(reply);
    if (!hotkeyName) {
      return null;
    }

    return await vtubeStudio.triggerHotkey({ hotkeyName });
  }

  function queueVTubeReaction(reply) {
    if (!vtubeStudio) {
      return;
    }

    triggerVTubeReactionForReply(reply).catch((error) => {
      console.warn("VTube Studio reaction failed:", error.message);
    });
  }

  return {
    parseVTubeReactions,
    pickVTubeReaction,
    queueVTubeReaction,
    triggerVTubeReactionForReply,
    vtubeStudio,
    vtubeStudioUrl,
  };
}

module.exports = {
  createVTubeRuntime,
};
