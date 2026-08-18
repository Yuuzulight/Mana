const { createSentenceChunker } = require("./sentence-chunker");
const { createThinkFilter } = require("./think-filter");

// Issue #331: llama-server speaks OpenAI-shaped SSE -- "data: {json}" lines
// separated by blank lines, terminated by "data: [DONE]". Lines can be split
// across network chunks, so partial lines are held rather than parsed.
const NEWLINE = String.fromCharCode(10);

async function* readSseDeltas(resp) {
  const body = resp.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";

  // A web ReadableStream in some runtimes, a plain async iterable in others
  // (and in tests). Both are handled so the caller never has to care.
  const iterable =
    typeof body[Symbol.asyncIterator] === "function"
      ? body
      : (async function* () {
          const reader = body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        })();

  for await (const chunk of iterable) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf(NEWLINE)) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch (e) {
        // A malformed frame costs one delta, not the stream. llama-server
        // has no reason to emit one, but a truncated line at a network
        // boundary should not abort a reply that is otherwise fine.
      }
    }
  }
}


// Issue #331: the composition of reader, think filter and chunker, kept out
// of the runtime so it can be tested without a live llama-server. The
// runtime's job is ensuring a server exists and making the request; turning
// a response into spoken-ready sentences is logic, and logic that decides
// what gets said aloud deserves direct tests.
//
// Order matters: think-block suppression runs BEFORE sentence cutting, so
// reasoning never reaches TTS. The other way round would speak the model's
// deliberation before its closing tag arrived.
async function streamSentences(resp, { onSentence = null, maxSentenceChars } = {}) {
  const thinkFilter = createThinkFilter();
  const chunker = createSentenceChunker({ maxChars: maxSentenceChars });
  const emit = typeof onSentence === "function" ? onSentence : () => {};
  let full = "";

  const deliver = async (sentences) => {
    for (const sentence of sentences) {
      full += (full ? " " : "") + sentence;
      await emit(sentence);
    }
  };

  for await (const delta of readSseDeltas(resp)) {
    const visible = thinkFilter.push(delta);
    if (visible) await deliver(chunker.push(visible));
  }
  // Both filters may be holding text back: the think filter on something
  // that turned out not to be a tag, the chunker on a final sentence with
  // no terminator. Released in that order.
  const tail = thinkFilter.flush();
  if (tail) await deliver(chunker.push(tail));
  await deliver(chunker.flush());

  return full;
}

module.exports = { readSseDeltas, streamSentences };
