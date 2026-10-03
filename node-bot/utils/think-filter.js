// Issue #331: the blocking reply path strips <think>...</think> after the
// whole reply exists. Streaming cannot do that -- by the time the closing
// tag arrives, the reasoning inside would already have been cut into
// sentences and spoken aloud.
//
// So the filter has to run on the stream itself, holding back anything that
// might turn out to be inside a think block. A small state machine rather
// than a regex, because a regex needs the complete text and that is exactly
// what streaming does not have.
const OPEN = "<think>";
const CLOSE = "</think>";

// The longest prefix of `tag` that `text` ends with -- how much to hold
// back in case the rest of a tag arrives in the next delta. Without this a
// tag split across deltas ("<thi" + "nk>") would never match and the
// reasoning would leak straight through.
function trailingPartial(text, tag) {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (text.slice(-len) === tag.slice(0, len)) return len;
  }
  return 0;
}

function createThinkFilter({ onThought } = {}) {
  let buffer = "";
  let inside = false;
  let thoughtBuffer = "";

  return {
    // Returns only text that is definitely outside a think block. Anything
    // that could still be part of a tag is held for the next delta.
    push(delta) {
      buffer += String(delta ?? "");
      let out = "";

      for (;;) {
        if (inside) {
          const end = buffer.indexOf(CLOSE);
          if (end === -1) {
            // Hold only a possible partial closing tag; the rest is
            // reasoning tokens to capture.
            const keep = trailingPartial(buffer, CLOSE);
            const chunk = keep ? buffer.slice(0, buffer.length - keep) : buffer;
            if (chunk) {
              thoughtBuffer += chunk;
              onThought?.(chunk);
            }
            buffer = keep ? buffer.slice(-keep) : "";
            break;
          }
          const chunk = buffer.slice(0, end);
          if (chunk) {
            thoughtBuffer += chunk;
            onThought?.(chunk);
          }
          buffer = buffer.slice(end + CLOSE.length);
          inside = false;
          continue;
        }

        const start = buffer.indexOf(OPEN);
        if (start === -1) {
          const keep = trailingPartial(buffer, OPEN);
          out += keep ? buffer.slice(0, buffer.length - keep) : buffer;
          buffer = keep ? buffer.slice(-keep) : "";
          break;
        }
        out += buffer.slice(0, start);
        buffer = buffer.slice(start + OPEN.length);
        inside = true;
      }

      return out;
    },
    // End of stream: release anything held back that turned out not to be a
    // tag. Text still inside an unclosed think block is captured as thought
    // (for display) but dropped from spoken output.
    flush() {
      if (inside) {
        if (buffer) {
          thoughtBuffer += buffer;
          onThought?.(buffer);
        }
        buffer = "";
        inside = false;
        return "";
      }
      const rest = buffer;
      buffer = "";
      return rest;
    },
    getThought() {
      return thoughtBuffer;
    },
  };
}

module.exports = { createThinkFilter };
