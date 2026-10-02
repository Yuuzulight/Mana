// #1231: the bug-making half of the task generator. A small JS tokenizer
// (no parser dependency) and operators that turn a source file's tokens
// into edits, each a realistic one-spot bug: { op, start, end, text, note }
// replacing src.slice(start, end) with text. Pure; nothing here runs code.
const vm = require("node:vm");

const PUNCS = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
];
const KEYWORDS = new Set(
  ("break case catch class const continue debugger default delete do else export extends finally for function if import in " +
    "instanceof let new return super switch this throw try typeof var void while with yield await async of static get set")
    .split(" "),
);
// After one of these a `/` starts a regex, not a division.
const BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
const NUM_RE = /^(?:0[xXbBoO][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/;
const NAME_RE = /^#?[A-Za-z_$\u0080-￿][\w$\u0080-￿]*/;

// Tokens { t: name|num|str|tmpl|regex|punc, v, s, e }; comments dropped. A
// template literal is one token: nothing inside one is mutated.
function tokenize(src) {
  return lex(src, src.startsWith("#!") ? src.indexOf("\n") + 1 || src.length : 0, false).tokens;
}

function lex(src, i, inTemplate) {
  const tokens = [];
  let depth = 0;
  const valueBefore = () => {
    const p = tokens[tokens.length - 1];
    if (!p) return false;
    if (p.t === "name") return !BEFORE_REGEX.has(p.v);
    return p.t !== "punc" || p.v === ")" || p.v === "]" || p.v === "}";
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      tokens.push({ t: "str", v: src.slice(i, j + 1), s: i, e: j + 1 });
      i = j + 1;
    } else if (c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== "`") {
        if (src[j] === "\\") j += 2;
        else if (src.startsWith("${", j)) j = lex(src, j + 2, true).end + 1;
        else j += 1;
      }
      tokens.push({ t: "tmpl", v: src.slice(i, j + 1), s: i, e: j + 1 });
      i = j + 1;
    } else if (c === "/" && !valueBefore()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n" && (inClass || src[j] !== "/")) {
        if (src[j] === "\\") j += 1;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j += 1;
      }
      j += 1;
      while (j < src.length && /[a-z]/i.test(src[j])) j += 1;
      tokens.push({ t: "regex", v: src.slice(i, j), s: i, e: j });
      i = j;
    } else if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] || ""))) {
      const m = NUM_RE.exec(src.slice(i, i + 64));
      tokens.push({ t: "num", v: m[0], s: i, e: i + m[0].length });
      i += m[0].length;
    } else if (NAME_RE.test(src.slice(i, i + 2))) {
      const m = NAME_RE.exec(src.slice(i, i + 256));
      tokens.push({ t: "name", v: m[0], s: i, e: i + m[0].length });
      i += m[0].length;
    } else {
      if (c === "{") depth += 1;
      if (c === "}") {
        if (inTemplate && depth === 0) return { tokens, end: i };
        depth -= 1;
      }
      const p = PUNCS.find((x) => src.startsWith(x, i)) || c;
      tokens.push({ t: "punc", v: p, s: i, e: i + p.length });
      i += p.length;
    }
  }
  return { tokens, end: i };
}

const OPEN = { "(": ")", "[": "]", "{": "}" };
// The index of the bracket closing toks[i], or -1.
function matchClose(toks, i) {
  const open = toks[i].v;
  let depth = 0;
  for (let j = i; j < toks.length; j += 1) {
    if (toks[j].t !== "punc") continue;
    if (toks[j].v === open) depth += 1;
    else if (toks[j].v === OPEN[open] && --depth === 0) return j;
  }
  return -1;
}

// Indices of the top-level separators `sep` between toks[from] and toks[to].
function splitTop(toks, from, to, seps) {
  const at = [];
  let depth = 0;
  for (let j = from; j < to; j += 1) {
    const v = toks[j].t === "punc" ? toks[j].v : "";
    if (v in OPEN) depth += 1;
    else if (v === ")" || v === "]" || v === "}") depth -= 1;
    else if (depth === 0 && seps.includes(v)) at.push(j);
  }
  return at;
}

const isValue = (tok) => tok && (tok.t === "num" || tok.t === "str" || tok.t === "tmpl" || (tok.t === "name" && !KEYWORDS.has(tok.v)) || (tok.t === "punc" && (tok.v === ")" || tok.v === "]")));
const isInt = (tok) => tok && tok.t === "num" && /^\d+$/.test(tok.v);
const COMPARE = new Set(["<", "<=", ">", ">="]);
const FLIP = { "<": "<=", "<=": "<", ">": ">=", ">=": ">", "===": "!==", "!==": "===", "==": "!=", "!=": "==" };
const DEFAULT_BEFORE = new Set(["=", "??", "||", ":"]);

// Each operator: (toks, src) => edits.
const OPERATORS = {
  // `<` <-> `<=`, `>` <-> `>=`.
  comparison(toks) {
    return toks
      .filter((k) => k.t === "punc" && COMPARE.has(k.v))
      .map((k) => ({ start: k.s, end: k.e, text: FLIP[k.v], note: `${k.v} -> ${FLIP[k.v]}` }));
  },

  // `i < 3` -> `i < 4`; `n - 1` -> `n`.
  "off-by-one"(toks) {
    const out = [];
    toks.forEach((k, i) => {
      const prev = toks[i - 1];
      if (isInt(k) && prev?.t === "punc" && COMPARE.has(prev.v)) {
        out.push({ start: k.s, end: k.e, text: String(Number(k.v) + 1), note: `${k.v} -> ${Number(k.v) + 1}` });
      }
      const next = toks[i + 1];
      if (k.t === "punc" && (k.v === "+" || k.v === "-") && isValue(prev) && next?.v === "1" && !["*", "/", "%", "**"].includes(toks[i + 2]?.v)) {
        out.push({ start: prev.e, end: next.e, text: "", note: `dropped ${k.v} 1` });
      }
    });
    return out;
  },

  // `if (x)` -> `if (!(x))`; `===` <-> `!==`; `!x` -> `x`.
  "negate-condition"(toks, src) {
    const out = [];
    toks.forEach((k, i) => {
      if (k.t === "name" && k.v === "if" && toks[i + 1]?.v === "(") {
        const close = matchClose(toks, i + 1);
        if (close > i + 2) {
          const inner = src.slice(toks[i + 2].s, toks[close - 1].e);
          out.push({ start: toks[i + 2].s, end: toks[close - 1].e, text: `!(${inner})`, note: "negated an if" });
        }
      } else if (k.t === "punc" && /^[!=]==?$/.test(k.v) && FLIP[k.v]) {
        out.push({ start: k.s, end: k.e, text: FLIP[k.v], note: `${k.v} -> ${FLIP[k.v]}` });
      } else if (k.t === "punc" && k.v === "!" && !isValue(toks[i - 1]) && toks[i - 1]?.v !== "!" && toks[i + 1]?.v !== "!" && (toks[i + 1]?.t === "name" || toks[i + 1]?.v === "(")) {
        out.push({ start: k.s, end: k.e, text: "", note: "dropped a !" });
      }
    });
    return out;
  },

  // `if (a && b)` -> `if (a)`.
  "drop-condition"(toks, src) {
    const out = [];
    toks.forEach((k, i) => {
      if (k.t !== "name" || k.v !== "if" || toks[i + 1]?.v !== "(") return;
      const close = matchClose(toks, i + 1);
      const seps = close < 0 ? [] : splitTop(toks, i + 2, close, ["&&", "||"]);
      if (!seps.length) return;
      const last = seps[seps.length - 1];
      out.push({ start: toks[last - 1].e, end: toks[close - 1].e, text: "", note: `dropped "${src.slice(toks[last].s, toks[close - 1].e)}"` });
    });
    return out;
  },

  // A default or constant: `timeout = 5000` -> 500, `?? 3` -> 4, `true` <-> `false`.
  "wrong-default"(toks) {
    const out = [];
    toks.forEach((k, i) => {
      const prev = toks[i - 1];
      if (!prev || !(DEFAULT_BEFORE.has(prev.v) || (k.t === "name" && ["return", "(", ","].includes(prev.v)))) return;
      if (isInt(k)) {
        const n = Number(k.v);
        const to = n >= 10 && n % 10 === 0 ? n / 10 : n + 1;
        out.push({ start: k.s, end: k.e, text: String(to), note: `${n} -> ${to}` });
      } else if (k.t === "name" && (k.v === "true" || k.v === "false") && toks[i + 1]?.v !== ":") {
        const to = k.v === "true" ? "false" : "true";
        out.push({ start: k.s, end: k.e, text: to, note: `${k.v} -> ${to}` });
      }
    });
    return out;
  },

  // `f(a, b)` -> `f(b, a)`, for two plain arguments (no callbacks).
  "swap-args"(toks, src) {
    const out = [];
    toks.forEach((k, i) => {
      if (k.t !== "name" || KEYWORDS.has(k.v) || k.v === "require" || toks[i + 1]?.v !== "(" || toks[i - 1]?.v === "function") return;
      const close = matchClose(toks, i + 1);
      if (close < 0 || toks[close + 1]?.v === "{") return;
      const seps = splitTop(toks, i + 2, close, [","]);
      if (seps.length !== 1 || seps[0] === i + 2 || seps[0] === close - 1) return;
      const a = src.slice(toks[i + 2].s, toks[seps[0] - 1].e);
      const b = src.slice(toks[seps[0] + 1].s, toks[close - 1].e);
      if (a === b || /=>|\bfunction\b|^\.\.\./.test(a + "\n" + b) || b.startsWith("...")) return;
      out.push({ start: toks[i + 2].s, end: toks[close - 1].e, text: b + src.slice(toks[seps[0] - 1].e, toks[seps[0] + 1].s) + a, note: `swapped ${k.v}'s arguments` });
    });
    return out;
  },

  // `await x` -> `x`.
  "remove-await"(toks) {
    const out = [];
    toks.forEach((k, i) => {
      if (k.t === "name" && k.v === "await" && toks[i - 1]?.v !== "." && toks[i - 1]?.v !== "for" && toks[i + 1]) {
        out.push({ start: k.s, end: toks[i + 1].s, text: "", note: "dropped an await" });
      }
    });
    return out;
  },

  // `opts.timeout` -> `opts.retries`: another property the file reads off
  // the same name (the nearest one), never a method call.
  "wrong-key"(toks) {
    const byObj = new Map();
    toks.forEach((k, i) => {
      const dot = toks[i - 1];
      const obj = toks[i - 2];
      if (k.t === "name" && !k.v.startsWith("#") && (dot?.v === "." || dot?.v === "?.") && obj?.t === "name" && toks[i + 1]?.v !== "(" && toks[i - 3]?.v !== ".") {
        if (!byObj.has(obj.v)) byObj.set(obj.v, []);
        byObj.get(obj.v).push(k);
      }
    });
    const out = [];
    for (const [obj, keys] of byObj) {
      for (const k of keys) {
        let other = null;
        for (const o of keys) if (o.v !== k.v && (!other || Math.abs(o.s - k.s) < Math.abs(other.s - k.s))) other = o;
        if (other) out.push({ start: k.s, end: k.e, text: other.v, note: `${obj}.${k.v} -> ${obj}.${other.v}` });
      }
    }
    return out;
  },

  // `if (!x) return null;` (or `{ return ...; }`) removed.
  "drop-early-return"(toks, src) {
    const out = [];
    toks.forEach((k, i) => {
      if (k.t !== "name" || k.v !== "if" || toks[i + 1]?.v !== "(" || toks[i - 1]?.v === "else") return;
      const close = matchClose(toks, i + 1);
      if (close < 0) return;
      const braced = toks[close + 1]?.v === "{";
      const ret = close + (braced ? 2 : 1);
      if (toks[ret]?.v !== "return") return;
      // The return's own `;`, before its block ends.
      let semi = ret;
      for (let depth = 0; semi < toks.length; semi += 1) {
        const v = toks[semi].t === "punc" ? toks[semi].v : "";
        if (v in OPEN) depth += 1;
        else if ((v === ")" || v === "]" || v === "}") && --depth < 0) return;
        else if (depth === 0 && v === ";") break;
      }
      if (toks[semi]?.v !== ";") return;
      const last = braced ? semi + 1 : semi;
      if (braced && toks[last]?.v !== "}") return;
      if (toks[last + 1]?.v === "else") return;
      // The whole line(s), when the statement has them to itself.
      let start = k.s;
      let end = toks[last].e;
      const lineStart = src.lastIndexOf("\n", start - 1) + 1;
      const nl = src.indexOf("\n", end);
      const lineEnd = nl < 0 ? src.length : nl + 1;
      if (!src.slice(lineStart, start).trim() && !src.slice(end, lineEnd).trim()) [start, end] = [lineStart, lineEnd];
      out.push({ start, end, text: "", note: "dropped an early return" });
    });
    return out;
  },

  // `throw new RangeError(...)` -> `Error`, `Error` -> `TypeError`; or the
  // message of another throw in the same file (a copy-paste slip).
  "wrong-error"(toks) {
    const throws = [];
    toks.forEach((k, i) => {
      if (k.v === "throw" && toks[i + 1]?.v === "new" && /^(?:[A-Z]\w*)?Error$/.test(toks[i + 2]?.v || "") && toks[i + 3]?.v === "(") {
        throws.push({ type: toks[i + 2], msg: toks[i + 4]?.t === "str" && toks[i + 5]?.v === ")" ? toks[i + 4] : null });
      }
    });
    const out = [];
    for (const t of throws) {
      const to = t.type.v === "Error" ? "TypeError" : "Error";
      out.push({ start: t.type.s, end: t.type.e, text: to, note: `${t.type.v} -> ${to}` });
      const other = t.msg && throws.find((o) => o.msg && o.msg.v.slice(1, -1) !== t.msg.v.slice(1, -1));
      if (other) out.push({ start: t.msg.s, end: t.msg.e, text: other.msg.v, note: "another throw's message" });
    }
    return out;
  },
};

function applyEdit(src, edit) {
  return src.slice(0, edit.start) + edit.text + src.slice(edit.end);
}

// A CommonJS module that compiles (nothing is run).
function compiles(src) {
  try {
    vm.compileFunction(src.replace(/^#!.*/, ""), ["exports", "require", "module", "__filename", "__dirname"]);
    return true;
  } catch {
    return false;
  }
}

// Every operator's edits on src, each with its op, in file order per op.
// Cheap: whether one compiles is checked when it's tried (mutant()).
function edits(src, ops = Object.keys(OPERATORS)) {
  const toks = tokenize(src);
  return ops.flatMap((op) => OPERATORS[op](toks, src).map((e) => ({ op, ...e })));
}

// The edited source, or null when it doesn't change it or doesn't compile.
function mutant(src, edit) {
  const out = applyEdit(src, edit);
  return out !== src && compiles(out) ? out : null;
}

module.exports = { tokenize, OPERATORS, edits, mutant };
