const http = require('node:http');
const https = require('node:https');

const MAX_RESPONSE_BYTES = 1024 * 1024;

function completionUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Chat endpoint must be an HTTP(S) URL without embedded credentials');
  }
  let base = url.pathname;
  while (base.endsWith('/')) base = base.slice(0, -1);
  url.pathname = base + (base.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions');
  return url;
}

function requestChatCompletion(config) {
  const url = completionUrl(config.baseUrl);
  const transport = url.protocol === 'https:' ? https : http;
  const timeoutMs = Math.min(120000, Math.max(100, Number(config.timeoutMs) || 30000));
  const body = JSON.stringify({ model: config.model, messages: config.messages, max_tokens: config.maxTokens, temperature: 0.7 });
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const req = transport.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
    }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy(); finish(null); return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(); finish(null); return; }
        chunks.push(chunk);
      });
      res.on('error', () => finish(null));
      res.on('aborted', () => finish(null));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const content = parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.text;
          finish({ content: typeof content === 'string' ? content.trim() : null, usage: parsed?.usage });
        } catch { finish(null); }
      });
    });
    // This bounds the remote HTTP request, not the wait for a local reply.
    timer = setTimeout(() => { req.destroy(); finish(null); }, timeoutMs);
    req.on('error', () => finish(null));
    req.end(body);
  });
}

module.exports = { completionUrl, requestChatCompletion };
