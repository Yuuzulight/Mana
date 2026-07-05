/**
 * Scans a string for the first valid nested JSON object or array block.
 * Handles escaped characters and quoted braces securely.
 * @param {string} rawText
 * @returns {Object|Array|null} Parsed JSON or null if none found.
 */
function extractJsonFromText(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const trimmed = rawText.trim();

  // Fast-path: check if the entire string is already valid JSON
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Fall through to manual block extraction
  }

  let firstChar = -1;
  let stack = [];
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{' || char === '[') {
        if (stack.length === 0) {
          firstChar = i;
        }
        stack.push(char === '{' ? '}' : ']');
      } else if (char === '}' || char === ']') {
        if (stack.length > 0 && char === stack[stack.length - 1]) {
          stack.pop();
          if (stack.length === 0 && firstChar !== -1) {
            const potentialJson = trimmed.substring(firstChar, i + 1);
            try {
              return JSON.parse(potentialJson);
            } catch (e) {
              // Reset state and continue scanning if this specific segment block failed
              firstChar = -1;
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Shared wrapper for handling assistant responses that might contain JSON arrays or objects.
 */
function safeJsonParse(text) {
  return extractJsonFromText(text);
}

module.exports = { extractJsonFromText, safeJsonParse };
