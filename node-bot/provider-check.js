// #1441: "Save and test" runs the three things her tool loop needs from a
// provider -- a chat reply, a tool call and a streamed reply -- so a provider
// that answers but can't call tools or stream shows that before she uses it.
// A few hundred tokens per check.

// Model ids in a /models list that aren't chat models.
// ponytail: a name heuristic, backed by trying up to three of what's left
// (pickModels); odd naming can still miss, and the check says what it tried.
const NOT_CHAT = /embed|whisper|tts|transcri|dall-e|image|imagen|moderation|audio|realtime|rerank|veo|aqa|guard|sora|codex|search|computer-use|^babbage|^davinci|turbo-instruct/i;

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "The current weather in a city.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

function headersFor({ apiKey, preset }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  // Anthropic's model list is its own API, which wants these instead.
  if (apiKey && preset === "anthropic") Object.assign(headers, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" });
  return headers;
}

async function pickModels(conn, fetchImpl, signal) {
  const resp = await fetchImpl(`${conn.baseUrl}/models`, { headers: headersFor(conn), signal });
  if (!resp.ok) throw new Error(`its model list answered ${resp.status}`);
  const data = await resp.json().catch(() => null);
  const ids = (Array.isArray(data?.data) ? data.data : []).map((m) => String(m?.id || "").replace(/^models\//, "")).filter(Boolean);
  const models = ids.filter((id) => !NOT_CHAT.test(id)).slice(0, 3);
  if (!models.length) throw new Error("its model list has no chat model");
  return models;
}

async function complete(conn, model, body, fetchImpl, signal) {
  const resp = await fetchImpl(`${conn.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headersFor(conn),
    body: JSON.stringify({ model, ...body }),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`answered ${resp.status}${text ? `: ${text.slice(0, 120)}` : ""}`);
  }
  return resp;
}

async function chatStep(conn, model, fetchImpl, signal) {
  const data = await (await complete(conn, model, { messages: [{ role: "user", content: "Reply with just the word: ready" }] }, fetchImpl, signal)).json();
  if (!String(data?.choices?.[0]?.message?.content || "").trim()) throw new Error("the reply was empty");
}

async function toolStep(conn, model, fetchImpl, signal) {
  const data = await (
    await complete(conn, model, { messages: [{ role: "user", content: "What's the weather in Paris? Use the get_weather tool." }], tools: [WEATHER_TOOL] }, fetchImpl, signal)
  ).json();
  const call = data?.choices?.[0]?.message?.tool_calls?.[0]?.function;
  if (call?.name !== "get_weather") throw new Error("it didn't call the tool");
  JSON.parse(call.arguments || "{}");
}

async function streamStep(conn, model, fetchImpl, signal) {
  const resp = await complete(conn, model, { messages: [{ role: "user", content: "Count from 1 to 5." }], stream: true }, fetchImpl, signal);
  const text = await resp.text();
  const deltas = text
    .split("\n")
    .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5)).choices?.[0]?.delta || {};
      } catch {
        return {};
      }
    })
    .filter((d) => d.content || d.reasoning_content || d.reasoning);
  if (deltas.length < 2) throw new Error("no streamed reply");
}

// conn: { baseUrl, apiKey, preset, model? }. Returns the check to remember:
// ok only when all three pass, each step's result, and the first error.
// One deadline for the whole check, inside the launcher's 100 s request limit.
async function checkToolLoop(conn, { fetchImpl = fetch, timeoutMs = 90000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const result = { ok: false, model: conn.model || null, chat: false, tools: false, stream: false };
  let candidates;
  try {
    candidates = conn.model ? [conn.model] : await pickModels(conn, fetchImpl, signal);
  } catch (error) {
    return { ...result, error: error.message };
  }
  // The model a use picked, or the first listed one that chats.
  for (const model of candidates) {
    result.model = model;
    try {
      await chatStep(conn, model, fetchImpl, signal);
      result.chat = true;
      delete result.error;
      break;
    } catch (error) {
      result.error = `Chat: ${error.message}`;
    }
  }
  if (!result.chat) return result;
  for (const [step, run] of [["tools", toolStep], ["stream", streamStep]]) {
    try {
      await run(conn, result.model, fetchImpl, signal);
      result[step] = true;
    } catch (error) {
      result.error ||= `${step === "tools" ? "Tool call" : "Streaming"}: ${error.message}`;
    }
  }
  result.ok = result.chat && result.tools && result.stream;
  return result;
}

module.exports = { checkToolLoop, NOT_CHAT };
