/**

 * High-speed linguistic intent classifier tailored for a local 8B model architecture.

 * Maps inputs directly to native system prompt keys with diagnostic telemetry reasons.

 * @param {string} userInput

 * @returns {{ mode: 'casual' | 'everyday' | 'coding', reason: string }}

 */
function classifyIntent(userInput) {
  if (!userInput || typeof userInput !== "string") {
    return { mode: "casual", reason: "empty_or_invalid_input" };
  }
  const textLower = userInput.toLowerCase().trim();

  // 1. Developer / Coding Mode
  const devKeywords = [
    "code",
    "function",
    "bug",
    "fix",
    "script",
    "program",
    "index",
    "repo",
    "compile",
    "json",
    "test",
    "regex",
    "endpoint",
    "git",
    "refactor",
    "traceback",
  ];
  // Immediate catch for path routing structures (Windows/Linux)
  const pathRegex =
    /([a-zA-Z]:\\|\\\\|\/src\/|\/tools\/|\.js|\.py|\.bat|\.json)/;

  // Check path patterns first
  const pathMatch = textLower.match(pathRegex);
  if (pathMatch) {
    return { mode: "coding", reason: `matched_path_pattern (${pathMatch[0]})` };
  }
  // Check keyword patterns
  const matchedDev = devKeywords.find((keyword) => textLower.includes(keyword));
  if (matchedDev) {
    return { mode: "coding", reason: `matched_dev_keyword (${matchedDev})` };
  }

  // 2. Everyday Assistant Mode
  const assistantKeywords = [
    "summarize",
    "recipe",
    "schedule",
    "calendar",
    "draft",
    "email",
    "list",
    "analyze",
    "document",
    "remind",
    "extract",
    "plan",
    "todo",
    "explain",
  ];
  const matchedAssist = assistantKeywords.find((keyword) =>
    textLower.includes(keyword),
  );
  if (matchedAssist) {
    return {
      mode: "everyday",
      reason: `matched_assistant_keyword (${matchedAssist})`,
    };
  }

  // 3. Default: Casual Chat Companion
  return { mode: "casual", reason: "default_fallback" };
}

module.exports = { classifyIntent };
