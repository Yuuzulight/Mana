// Issue #267: one generic composer instead of hand-rolling a
// buildToolPolicyWithX per tool source (mcp-client-registry.js's
// buildToolPolicyWithMcp, and ai/memory-tool-source.js's/
// ai/session-search-tool-source.js's/ai/skill-tool-source.js's/
// plugins/browser-automation/browser-automation-tool-source.js's own
// buildToolPolicyWithX, all four structurally identical apart from name).
//
// A "tool source" is anything shaped:
//   { listToolSchemas(): Array | Promise<Array>,
//     isKnownToolName(name): boolean,
//     executeTool(name, args): Promise<string> }
// -- exactly what every existing tool-source module already returns from
// its create*ToolSource() factory, plus isKnownToolName as an alias for
// whichever prefix-check function that module already exported separately
// (isMemoryToolName, isSkillToolName, isSessionSearchToolName,
// isBrowserAutomationToolName, isMcpToolName). Those individual exports and
// their own buildToolPolicyWithX functions are left in place, unchanged --
// this doesn't force every existing test file to be rewritten, it just
// gives server.js's actual composition chain (the thing the issue is
// about) one call instead of five hand-rolled ones, and gives the next
// tool source somewhere to plug in without writing a sixth.
async function buildToolPolicy(basePolicy, toolSources) {
  const sources = toolSources || [];
  let tools = [...basePolicy.tools];
  for (const source of sources) {
    tools = tools.concat(await source.listToolSchemas());
  }
  return {
    tools,
    isKnownTool: (name) =>
      basePolicy.isKnownTool(name) || sources.some((source) => source.isKnownToolName(name)),
    executeTool: async (name, args) => {
      const source = sources.find((source) => source.isKnownToolName(name));
      if (source) return source.executeTool(name, args);
      return basePolicy.executeTool(name, args);
    },
  };
}

module.exports = { buildToolPolicy };
