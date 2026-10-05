function createResourceToolSource(coordinator) {
  const name = 'resources__status';
  return {
    listToolSchemas: () => coordinator ? [{ type: 'function', function: { name,
      description: 'Read actual resource reservations, queued workloads and reasons, model residency, estimated versus observed RAM/VRAM use, and CPU alternatives awaiting human approval. Never claim unused memory is free before owned processes exit.',
      parameters: { type: 'object', properties: {} } } }] : [],
    isKnownToolName: candidate => !!coordinator && candidate === name,
    executeTool: async candidate => {
      if (!coordinator || candidate !== name) throw new Error('Unknown resource tool');
      return JSON.stringify(coordinator.status());
    },
  };
}
module.exports = { createResourceToolSource };
