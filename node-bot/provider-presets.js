// #1426: the API providers Settings knows by name. Each is added once (its
// key, and its address for the local ones), and Mana's uses -- the main
// model, the cloud fallback, self-work escalation -- pick one. Every one
// speaks OpenAI's API; Anthropic and Gemini through their compatible layers.
const PROVIDER_PRESETS = {
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", needsKey: true },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", needsKey: true },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true },
  xai: { label: "xAI", baseUrl: "https://api.x.ai/v1", needsKey: true },
  mistral: { label: "Mistral", baseUrl: "https://api.mistral.ai/v1", needsKey: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", needsKey: true },
  ollama: { label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false, local: true },
  lmstudio: { label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false, local: true },
  llamacpp: { label: "llama.cpp server", baseUrl: "http://127.0.0.1:8080/v1", needsKey: false, local: true },
  custom: { label: "Custom", baseUrl: "", needsKey: false },
};

const trimSlashes = (url) => {
  let s = String(url || "").trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
};

// The preset an address belongs to, or "custom".
function presetForBaseUrl(baseUrl) {
  const url = trimSlashes(baseUrl).toLowerCase();
  const match = Object.entries(PROVIDER_PRESETS).find(([, p]) => p.baseUrl && trimSlashes(p.baseUrl).toLowerCase() === url);
  return match ? match[0] : "custom";
}

module.exports = { PROVIDER_PRESETS, presetForBaseUrl, trimSlashes };
