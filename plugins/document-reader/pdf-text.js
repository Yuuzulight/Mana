// Plain-text extraction from PDFs with no dependency beyond Node's zlib
// (#1171). It reads just enough of the format to pull out text in reading
// order: the xref (table, stream or a recovery scan), object streams, the
// page tree, content streams and Form XObjects, and the font encodings and
// ToUnicode CMaps that turn glyph codes back into Unicode. Everything a
// hostile file controls is bounded by the limits below, so a crafted PDF
// fails with an error instead of hanging or exhausting memory.
const zlib = require("zlib");

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_OBJECTS = 500000;
const MAX_DECODED_BYTES = 64 * 1024 * 1024; // all decompressed streams together
const MAX_DEPTH = 32; // nesting of arrays/dicts, page tree, Form XObjects, refs
const MAX_TOKENS = 5000000; // content stream tokens + CMap/width entries (~2-3s of work)
const MAX_ARGS = 4096; // operands kept before an operator
const MAX_SAVED = 1024; // q (save graphics state) nesting

class PdfLimitError extends Error {
  constructor(what) {
    super(`PDF is too large or complex to read safely (${what})`);
  }
}

class Op {
  constructor(op) {
    this.op = op;
  }
}
class Ref {
  constructor(num) {
    this.num = num;
  }
}
class Stream {
  constructor(dict, data) {
    this.dict = dict;
    this.data = data; // still encoded
  }
}
const EOF = Symbol("EOF");

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;
const isDict = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v) && ![Op, Ref, Stream].some((t) => v instanceof t);

// Tokenizer + object parser. Names are JS strings, strings are Buffers,
// dicts are null-prototype objects, keywords/operators are Op. `content`
// turns off "n g R" lookahead and skips inline image data.
class Lexer {
  constructor(buf, pos = 0, content = false) {
    this.buf = buf;
    this.pos = pos;
    this.content = content;
  }

  skip() {
    const b = this.buf;
    while (this.pos < b.length) {
      if (WS[b[this.pos]]) this.pos++;
      else if (b[this.pos] === 0x25) while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      else break;
    }
  }

  word() {
    const b = this.buf;
    const start = this.pos;
    while (this.pos < b.length && !WS[b[this.pos]] && !DELIM[b[this.pos]]) this.pos++;
    return b.toString("latin1", start, this.pos);
  }

  read(depth = 0) {
    if (depth > MAX_DEPTH) throw new PdfLimitError("nesting too deep");
    this.skip();
    const b = this.buf;
    const c = b[this.pos];
    if (c === undefined) return EOF;
    if (c === 0x5b) {
      this.pos++;
      const arr = [];
      for (;;) {
        this.skip();
        if (b[this.pos] === 0x5d) return this.pos++, arr;
        const v = this.read(depth + 1);
        if (v === EOF) return arr;
        arr.push(v);
      }
    }
    if (c === 0x3c && b[this.pos + 1] === 0x3c) {
      this.pos += 2;
      const dict = Object.create(null);
      for (;;) {
        this.skip();
        if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) return (this.pos += 2), dict;
        const key = this.read(depth + 1);
        if (key === EOF || (key instanceof Op && key.op === ">>")) return dict;
        if (typeof key !== "string") continue;
        const v = this.read(depth + 1);
        if (v === EOF || (v instanceof Op && v.op === ">>")) return dict;
        dict[key] = v;
      }
    }
    if (c === 0x3c) {
      const end = b.indexOf(0x3e, this.pos);
      const hex = b.toString("latin1", this.pos + 1, end < 0 ? b.length : end).replace(/[^0-9a-f]/gi, "");
      this.pos = end < 0 ? b.length : end + 1;
      return Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex");
    }
    if (c === 0x28) return this.literal();
    if (c === 0x2f) {
      this.pos++;
      const name = this.word();
      return name.includes("#") ? name.replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) : name;
    }
    if (DELIM[c]) {
      // stray ) > ] { } -- ">>" is reported so a dict can close on it
      const two = c === 0x3e && b[this.pos + 1] === 0x3e;
      this.pos += two ? 2 : 1;
      return new Op(two ? ">>" : String.fromCharCode(c));
    }
    const w = this.word();
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(w)) {
      const n = Number(w);
      if (!this.content && /^\d+$/.test(w)) {
        // "num gen R" is an indirect reference
        const save = this.pos;
        this.skip();
        const gen = this.word();
        this.skip();
        if (/^\d+$/.test(gen) && this.word() === "R") return new Ref(n);
        this.pos = save;
      }
      return n;
    }
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    if (w === "ID" && this.content) this.skipInlineImage();
    return new Op(w);
  }

  literal() {
    const b = this.buf;
    // a growing Buffer rather than a JS array: a 60MB string would cost 8 bytes per byte
    let out = Buffer.alloc(64);
    let n = 0;
    const push = (c) => {
      if (n === out.length) out = Buffer.concat([out, Buffer.alloc(n)]);
      out[n++] = c;
    };
    let depth = 1;
    this.pos++;
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x5c) {
        c = b[this.pos++];
        const esc = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 }[c];
        if (esc !== undefined) push(esc);
        else if (c === 13) {
          if (b[this.pos] === 10) this.pos++; // line continuation
        } else if (c >= 0x30 && c <= 0x37) {
          let v = c - 0x30;
          for (let i = 0; i < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; i++) v = v * 8 + b[this.pos++] - 0x30;
          push(v & 0xff);
        } else if (c !== 10 && c !== undefined) push(c);
      } else if (c === 0x28) depth++, push(c);
      else if (c === 0x29) {
        if (--depth === 0) break;
        push(c);
      } else push(c);
    }
    return out.subarray(0, n);
  }

  // Inline image data (BI ... ID <binary> EI) isn't tokenizable; jump past it.
  skipInlineImage() {
    const b = this.buf;
    for (let p = this.pos + 1; ; p += 2) {
      p = b.indexOf("EI", p, "latin1");
      if (p < 0) return (this.pos = b.length);
      if (WS[b[p - 1]] && (p + 2 >= b.length || WS[b[p + 2]] || DELIM[b[p + 2]])) return (this.pos = p + 2);
    }
  }
}

// ---- stream filters ----

function unpredict(data, parms) {
  const int = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
  // ponytail: PNG predictors only; TIFF predictor 2 shows up in images, not in text/xref streams
  if (int(parms?.Predictor, 1) < 10) return data;
  const bits = int(parms.Colors, 1) * int(parms.BitsPerComponent, 8);
  const bpp = Math.max(1, Math.ceil(bits / 8));
  const rowLen = Math.ceil((bits * int(parms.Columns, 1)) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = r ? out[dst + i - rowLen] : 0;
      const upLeft = r && i >= bpp ? out[dst + i - rowLen - bpp] : 0;
      let v = data[src + i];
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[dst + i] = v;
    }
  }
  return out;
}

function ascii85(data, room) {
  const out = Buffer.alloc(Math.min(data.length * 4, room) + 4);
  let n = 0;
  let group = [];
  const flush = (count) => {
    while (group.length < 5) group.push(84);
    const v = group.reduce((acc, d) => acc * 85 + d, 0);
    if (n + 4 > out.length) throw new PdfLimitError("decompressed data");
    out.writeUInt32BE(v >>> 0, n);
    n += count;
    group = [];
  };
  for (const c of data) {
    if (c === 0x7e) break;
    if (c === 0x7a && !group.length) group = [0, 0, 0, 0, 0];
    else if (c >= 33 && c <= 117) group.push(c - 33);
    else continue;
    if (group.length === 5) flush(4);
  }
  if (group.length > 1) flush(group.length - 1);
  return out.subarray(0, n);
}

function lzw(data, earlyChange, room) {
  const out = [];
  let total = 0, table, next, width, prev;
  const reset = () => {
    table = Array.from({ length: 256 }, (_, i) => Buffer.of(i));
    next = 258;
    width = 9;
    prev = null;
  };
  reset();
  let acc = 0, bits = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= width) {
      bits -= width;
      const code = (acc >>> bits) & ((1 << width) - 1);
      acc &= (1 << bits) - 1;
      if (code === 256) {
        reset();
        continue;
      }
      const entry = code < next ? table[code] : code === next && prev ? Buffer.concat([prev, prev.subarray(0, 1)]) : null;
      if (code === 257 || !entry) return Buffer.concat(out);
      if (prev && next < 4096) table[next++] = Buffer.concat([prev, entry.subarray(0, 1)]);
      out.push(entry);
      if ((total += entry.length) > room) throw new PdfLimitError("decompressed data");
      prev = entry;
      if (next + earlyChange >= 1 << width && width < 12) width++;
    }
  }
  return Buffer.concat(out);
}

// ---- encodings ----

// combining marks, so eacute = e + U+0301 normalized
const ACCENTS = {
  acute: 0x301, grave: 0x300, circumflex: 0x302, tilde: 0x303, dieresis: 0x308, ring: 0x30a, cedilla: 0x327,
  caron: 0x30c, macron: 0x304, breve: 0x306, ogonek: 0x328, dotaccent: 0x307, hungarumlaut: 0x30b,
};
const ACCENTED = new RegExp(`^([A-Za-z])(${Object.keys(ACCENTS).join("|")})$`);
// Glyph names for everything that isn't a single letter, an accented
// letter (eacute = e + combining acute), or uniXXXX/uXXXX.
const GLYPHS = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'",
  parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[",
  backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", braceleft: "{", bar: "|", braceright: "}",
  asciitilde: "~", quoteleft: "‘", quoteright: "’", quotedblleft: "“", quotedblright: "”",
  quotesinglbase: "‚", quotedblbase: "„", guillemotleft: "«", guillemotright: "»",
  guilsinglleft: "‹", guilsinglright: "›", bullet: "•", periodcentered: "·", endash: "–",
  emdash: "—", ellipsis: "…", minus: "−", dagger: "†", daggerdbl: "‡", perthousand: "‰",
  exclamdown: "¡", questiondown: "¿", cent: "¢", sterling: "£", yen: "¥", Euro: "€",
  florin: "ƒ", currency: "¤", section: "§", paragraph: "¶", copyright: "©",
  registered: "®", trademark: "™", degree: "°", plusminus: "±", multiply: "×",
  divide: "÷", fraction: "⁄", onehalf: "½", onequarter: "¼", threequarters: "¾",
  mu: "µ", ordfeminine: "ª", ordmasculine: "º", brokenbar: "¦", logicalnot: "¬",
  nbspace: "\u00a0", fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", germandbls: "ß", ae: "æ",
  AE: "Æ", oe: "œ", OE: "Œ", oslash: "ø", Oslash: "Ø", lslash: "ł", Lslash: "Ł",
  dotlessi: "ı", eth: "ð", Eth: "Ð", thorn: "þ", Thorn: "Þ", grave: "`", acute: "´",
  circumflex: "ˆ", tilde: "˜", macron: "¯", breve: "˘", dotaccent: "˙", dieresis: "¨",
  ring: "˚", cedilla: "¸", hungarumlaut: "˝", ogonek: "˛", caron: "ˇ",
};

function glyphToUnicode(name) {
  // AGL rules: drop ".suffix", split ligatures on "_"
  return name.split(".")[0].split("_").map((part) => {
    if (Object.hasOwn(GLYPHS, part)) return GLYPHS[part];
    if (/^[A-Za-z]$/.test(part)) return part;
    let m = /^uni((?:[0-9A-F]{4})+)$/.exec(part);
    if (m) return m[1].match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join("");
    m = /^u([0-9A-F]{4,6})$/.exec(part);
    if (m && parseInt(m[1], 16) <= 0x10ffff) return String.fromCodePoint(parseInt(m[1], 16));
    m = ACCENTED.exec(part);
    return m ? (m[1] + String.fromCharCode(ACCENTS[m[2]])).normalize("NFC") : "";
  }).join("");
}

const printable = (s) => Array.from(s, (ch) => (/[\x00-\x1f\x7f-\x9f]/.test(ch) ? "" : ch));
const all256 = Uint8Array.from({ length: 256 }, (_, i) => i);
// Standard encoding above 0x7f, by glyph name from 0xa1 ("." = unused).
const STANDARD_HIGH = (
  "exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft guillemotleft " +
  "guilsinglleft guilsinglright fi fl . endash dagger daggerdbl periodcentered . paragraph bullet quotesinglbase " +
  "quotedblbase quotedblright guillemotright ellipsis perthousand . questiondown . grave acute circumflex tilde " +
  "macron breve dotaccent dieresis . ring cedilla . hungarumlaut ogonek caron emdash . . . . . . . . . . . . . . . . " +
  "AE . ordfeminine . . . . Lslash Oslash OE ordmasculine . . . . . ae . . . dotlessi . . lslash oslash oe germandbls"
).split(" ");
const ENCODINGS = {
  WinAnsiEncoding: printable(new TextDecoder("windows-1252").decode(all256)),
  MacRomanEncoding: printable(new TextDecoder("macintosh").decode(all256)),
  StandardEncoding: Array.from(all256, (i) =>
    i === 0x27 ? "’" : i === 0x60 ? "‘" : i >= 32 && i < 127 ? String.fromCharCode(i) : i >= 0xa1 ? glyphToUnicode(STANDARD_HIGH[i - 0xa1] ?? "") : "",
  ),
};

function utf16(buf) {
  if (!Buffer.isBuffer(buf)) return "";
  return buf.length % 2 ? buf.toString("latin1") : Buffer.from(buf).swap16().toString("utf16le");
}
const codeOf = (buf) => (Buffer.isBuffer(buf) && buf.length >= 1 && buf.length <= 4 ? buf.readUIntBE(0, buf.length) : NaN);

// ---- matrices: [a b c d e f] ----

const ID = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const nums = (args, n) => (args.length >= n && args.slice(-n).every(Number.isFinite) ? args.slice(-n) : null);

// ---- document ----

class PdfDoc {
  constructor(buf) {
    this.buf = buf;
    this.xref = new Map(); // num -> { offset } | { stm, idx } | null (free)
    this.cache = new Map();
    this.loading = new Set();
    this.objStms = new Map();
    this.fonts = new Map();
    this.decoded = 0;
    this.tokens = 0;
    try {
      this.trailer = this.readXref();
    } catch (e) {
      if (e instanceof PdfLimitError) throw e;
    }
    if (this.trailer?.Encrypt) return; // extractPdfText refuses these
    if (!this.resolve(this.trailer?.Root)) {
      this.trailer = undefined;
      this.recover();
    }
  }

  tick(n = 1) {
    if ((this.tokens += n) > MAX_TOKENS) throw new PdfLimitError("too many operators");
  }

  setEntry(num, entry, override = false) {
    if (!override && this.xref.has(num)) return;
    this.xref.set(num, entry);
    if (this.xref.size > MAX_OBJECTS) throw new PdfLimitError("too many objects");
  }

  // Follows startxref and the /Prev chain; newer sections win.
  readXref() {
    const at = this.buf.lastIndexOf("startxref");
    if (at < 0) throw new Error("no startxref");
    let offset = new Lexer(this.buf, at + 9).read();
    const trailer = Object.create(null);
    const seen = new Set();
    while (Number.isInteger(offset) && !seen.has(offset)) {
      seen.add(offset);
      const section = this.readXrefSection(offset);
      if (Number.isInteger(section.XRefStm)) this.readXrefSection(section.XRefStm);
      for (const k in section) if (!(k in trailer)) trailer[k] = section[k];
      offset = section.Prev;
    }
    return trailer;
  }

  readXrefSection(offset) {
    const lx = new Lexer(this.buf, offset);
    const first = lx.read();
    if (first instanceof Op && first.op === "xref") {
      for (;;) {
        const start = lx.read();
        if (start instanceof Op && start.op === "trailer") {
          const trailer = lx.read();
          if (!isDict(trailer)) throw new Error("bad trailer");
          return trailer;
        }
        const count = lx.read();
        if (!Number.isInteger(start) || !Number.isInteger(count)) throw new Error("bad xref table");
        for (let i = 0; i < count; i++) {
          const off = lx.read();
          lx.read();
          const kind = lx.read();
          if (!(kind instanceof Op)) throw new Error("bad xref entry");
          this.setEntry(start + i, kind.op === "n" ? { offset: off } : null);
        }
      }
    }
    const stream = this.parseAt(offset);
    if (!(stream instanceof Stream) || stream.dict.Type !== "XRef") throw new Error("bad xref stream");
    const d = stream.dict;
    const w = Array.isArray(d.W) ? d.W : [];
    if (w.length !== 3 || !w.every((x) => Number.isInteger(x) && x >= 0 && x <= 8)) throw new Error("bad /W");
    const data = this.decode(stream);
    const field = (p, n, dflt) => {
      if (!n) return dflt;
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + data[p + i];
      return v;
    };
    const index = Array.isArray(d.Index) ? d.Index : [0, d.Size];
    const row = w[0] + w[1] + w[2];
    let p = 0;
    for (let i = 0; i + 1 < index.length; i += 2) {
      for (let k = 0; k < index[i + 1] && p + row <= data.length; k++, p += row) {
        const type = field(p, w[0], 1);
        const a = field(p + w[0], w[1], 0);
        const b = field(p + w[0] + w[1], w[2], 0);
        this.setEntry(index[i] + k, type === 1 ? { offset: a } : type === 2 ? { stm: a, idx: b } : null);
      }
    }
    return d;
  }

  // Damaged xref: find every "n g obj" in the file and rebuild from those.
  recover() {
    this.cache.clear();
    this.recovered = true;
    const text = this.buf.toString("latin1");
    // (?<!\d) keeps a long digit run from being retried at every position (quadratic backtracking)
    for (const m of text.matchAll(/(?<!\d)(\d+)\s+\d+\s+obj\b/g)) this.setEntry(Number(m[1]), { offset: m.index }, true);
    const trailer = Object.create(null);
    for (let i = text.indexOf("trailer"); i >= 0; i = text.indexOf("trailer", i + 7)) {
      const t = new Lexer(this.buf, i + 7).read();
      if (isDict(t)) Object.assign(trailer, t);
    }
    for (const [num, entry] of [...this.xref]) {
      if (!entry || entry.stm !== undefined) continue;
      const v = this.getObj(num);
      const d = v instanceof Stream ? v.dict : v;
      if (!isDict(d)) continue;
      try {
        if (d.Type === "ObjStm") this.objStm(num).offsets.forEach(([n], idx) => this.setEntry(n, { stm: num, idx }));
      } catch (e) {
        if (e instanceof PdfLimitError) throw e;
      }
      if (d.Type === "XRef") for (const k of ["Root", "Encrypt"]) if (d[k]) trailer[k] = d[k];
      if (d.Type === "Catalog" && !trailer.Root) trailer.Root = new Ref(num);
    }
    if (!this.trailer?.Root) this.trailer = trailer;
    if (!this.trailer.Root && !this.trailer.Encrypt) throw new Error("Not a readable PDF (no document catalog found)");
  }

  parseAt(offset, num) {
    const lx = new Lexer(this.buf, offset);
    const n = lx.read();
    lx.read();
    const kw = lx.read();
    if (!Number.isInteger(n) || (num !== undefined && n !== num) || !(kw instanceof Op && kw.op === "obj")) {
      throw new Error(`no object at offset ${offset}`);
    }
    const value = lx.read();
    const next = lx.read();
    if (!isDict(value) || !(next instanceof Op && next.op === "stream")) return value;
    let start = lx.pos;
    if (this.buf[start] === 13) start++;
    if (this.buf[start] === 10) start++;
    const len = this.resolve(value.Length);
    let end = Number.isInteger(len) && len >= 0 ? start + len : -1;
    if (end < 0 || !/^\s*endstream/.test(this.buf.toString("latin1", end, end + 20))) {
      // wrong /Length: trust the endstream keyword instead
      end = this.buf.indexOf("endstream", start, "latin1");
      if (end < 0) end = this.buf.length;
      if (this.buf[end - 1] === 10) end--;
      if (this.buf[end - 1] === 13) end--;
    }
    return new Stream(value, this.buf.subarray(start, end));
  }

  getObj(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const entry = this.xref.get(num);
    if (!entry || this.loading.has(num) || this.loading.size > MAX_DEPTH) return null;
    this.loading.add(num);
    let value = null;
    try {
      value = entry.stm !== undefined ? this.fromObjStm(entry.stm, entry.idx, num) : this.parseAt(entry.offset, num);
    } catch (e) {
      if (e instanceof PdfLimitError) throw e;
      if (!this.recovered) {
        this.loading.delete(num);
        this.recover();
        return this.getObj(num);
      }
    } finally {
      this.loading.delete(num);
    }
    if (value === EOF) value = null;
    this.cache.set(num, value);
    return value;
  }

  objStm(num) {
    if (!this.objStms.has(num)) {
      const stream = this.getObj(num);
      if (!(stream instanceof Stream)) throw new Error("bad object stream");
      const data = this.decode(stream);
      const lx = new Lexer(data);
      const offsets = [];
      for (let i = 0, count = this.resolve(stream.dict.N); i < count; i++) {
        const n = lx.read(), off = lx.read();
        if (!Number.isInteger(n) || !Number.isInteger(off)) break;
        offsets.push([n, off]);
      }
      this.objStms.set(num, { data, first: this.resolve(stream.dict.First), offsets });
    }
    return this.objStms.get(num);
  }

  fromObjStm(stm, idx, num) {
    const s = this.objStm(stm);
    const found = s.offsets[idx]?.[0] === num ? s.offsets[idx] : s.offsets.find(([n]) => n === num);
    return found ? new Lexer(s.data, s.first + found[1]).read() : null;
  }

  resolve(v) {
    for (let i = 0; v instanceof Ref; i++) v = i > MAX_DEPTH ? null : this.getObj(v.num);
    return v;
  }

  decode(stream) {
    let data = stream.data;
    const filters = [].concat(this.resolve(stream.dict.Filter) ?? []);
    const parms = [].concat(this.resolve(stream.dict.DecodeParms) ?? []);
    filters.forEach((f, i) => {
      const name = this.resolve(f);
      const p = this.resolve(parms[i]);
      const room = MAX_DECODED_BYTES - this.decoded;
      if (name === "FlateDecode") {
        try {
          data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: Math.max(1, room) });
        } catch (e) {
          if (e.code === "ERR_BUFFER_TOO_LARGE") throw new PdfLimitError("decompressed data");
          data = Buffer.alloc(0); // corrupt stream: skip it, keep the rest of the document
        }
        data = unpredict(data, p);
      } else if (name === "LZWDecode") data = unpredict(lzw(data, p?.EarlyChange ?? 1, room), p);
      else if (name === "ASCII85Decode") data = ascii85(data, room);
      else if (name === "ASCIIHexDecode") data = new Lexer(Buffer.concat([Buffer.from("<"), data])).read(); // reuse the <hex> string reader
      else throw new Error(`Unsupported PDF stream filter: ${name}`);
      if ((this.decoded += data.length) > MAX_DECODED_BYTES) throw new PdfLimitError("decompressed data");
    });
    return data;
  }

  pages() {
    const out = [];
    const seen = new Set();
    const walk = (ref, resources, depth) => {
      if (ref instanceof Ref) {
        if (seen.has(ref.num)) return;
        seen.add(ref.num);
      }
      const node = this.resolve(ref);
      if (!isDict(node) || depth > MAX_DEPTH) return;
      resources = node.Resources ?? resources;
      const kids = this.resolve(node.Kids);
      if (Array.isArray(kids)) for (const kid of kids) walk(kid, resources, depth + 1);
      else out.push({ page: node, resources });
    };
    walk(this.resolve(this.trailer.Root)?.Pages, undefined, 0);
    return out;
  }

  // ---- fonts ----

  font(ref) {
    const d = this.resolve(ref);
    if (!isDict(d)) return null;
    if (!this.fonts.has(d)) this.fonts.set(d, this.loadFont(d));
    return this.fonts.get(d);
  }

  loadFont(d) {
    const type0 = d.Subtype === "Type0";
    const toUnicode = this.cmap(this.resolve(d.ToUnicode));
    const widths = new Map();
    let missing, unicode;
    if (type0) {
      // ponytail: every Type0 font is read as 2-byte codes (Identity-H/V); other CJK CMaps rely on ToUnicode
      const desc = this.resolve([].concat(this.resolve(d.DescendantFonts))[0]) ?? {};
      missing = this.resolve(desc.DW) ?? 1000;
      const w = [].concat(this.resolve(desc.W) ?? []);
      for (let i = 0; i < w.length; ) {
        const c = this.resolve(w[i]);
        const next = this.resolve(w[i + 1]);
        if (!Number.isInteger(c)) break; // malformed /W
        if (Array.isArray(next)) {
          this.tick(next.length);
          next.forEach((x, j) => widths.set(c + j, this.resolve(x)));
          i += 2;
        } else {
          const last = Number.isInteger(next) ? Math.min(next, c + 0xffff) : c - 1;
          if (last >= c) this.tick(last - c + 1);
          for (let k = c; k <= last; k++) widths.set(k, this.resolve(w[i + 2]));
          i += 3;
        }
      }
      unicode = (code) => toUnicode.get(code) ?? "";
    } else {
      const list = this.resolve(d.Widths);
      const first = this.resolve(d.FirstChar);
      if (Array.isArray(list) && Number.isInteger(first)) list.forEach((x, i) => widths.set(first + i, this.resolve(x)));
      // ponytail: standard-14 fonts may omit /Widths; 500 is a rough average, not their real metrics
      missing = this.resolve(this.resolve(d.FontDescriptor)?.MissingWidth) ?? (Array.isArray(list) ? 0 : 500);
      const enc = this.resolve(d.Encoding);
      const baseName = isDict(enc) ? enc.BaseEncoding : enc;
      const base = ENCODINGS[Object.hasOwn(ENCODINGS, baseName) ? baseName : d.Subtype === "TrueType" ? "WinAnsiEncoding" : "StandardEncoding"];
      const diffs = new Map();
      let code = 0;
      const differences = isDict(enc) ? this.resolve(enc.Differences) : null;
      for (const x of Array.isArray(differences) ? differences : []) {
        if (typeof x === "number") code = x;
        else if (typeof x === "string") diffs.set(code++, glyphToUnicode(x));
      }
      unicode = (c) => toUnicode.get(c) ?? diffs.get(c) ?? base[c];
    }
    // Type3 glyph widths are in glyph space, scaled by /FontMatrix
    const fontMatrix = this.resolve(d.FontMatrix);
    const scale = d.Subtype === "Type3" && Number.isFinite(fontMatrix?.[0]) ? fontMatrix[0] : 0.001;
    return {
      bytes: type0 ? 2 : 1,
      unicode,
      width: (code) => {
        const w = widths.get(code) ?? missing;
        return (Number.isFinite(w) ? w : 0) * scale;
      },
    };
  }

  // ToUnicode CMap: bfchar pairs and bfrange triples (dst string or array).
  cmap(stream) {
    const map = new Map();
    if (!(stream instanceof Stream)) return map;
    const lx = new Lexer(this.decode(stream), 0, true);
    const args = [];
    for (let t = lx.read(); t !== EOF; t = lx.read()) {
      this.tick();
      if (!(t instanceof Op)) {
        if (args.length < MAX_ARGS) args.push(t);
        continue;
      }
      if (t.op === "endbfchar") for (let i = 0; i + 1 < args.length; i += 2) map.set(codeOf(args[i]), utf16(args[i + 1]));
      if (t.op === "endbfrange") {
        for (let i = 0; i + 2 < args.length; i += 3) {
          const lo = codeOf(args[i]);
          const hi = Math.min(codeOf(args[i + 1]), lo + 0xffff);
          const dst = args[i + 2];
          if (hi >= lo) this.tick(hi - lo + 1);
          for (let c = lo; c <= hi; c++) {
            if (Array.isArray(dst)) map.set(c, utf16(dst[c - lo]));
            else if (Buffer.isBuffer(dst) && dst.length) {
              // the range increments the destination's last code unit
              const b = Buffer.from(dst);
              if (b.length >= 2) b.writeUInt16BE((b.readUInt16BE(b.length - 2) + c - lo) & 0xffff, b.length - 2);
              else b[0] += c - lo;
              map.set(c, utf16(b));
            }
          }
        }
      }
      args.length = 0;
    }
    return map;
  }

  // ---- content streams ----

  pageText({ page, resources }) {
    const contents = this.resolve(page.Contents);
    const parts = [];
    for (const s of [].concat(contents ?? [])) {
      const stream = this.resolve(s);
      if (stream instanceof Stream) parts.push(this.decode(stream), Buffer.from("\n"));
    }
    const st = {
      out: [],
      last: null, // device-space point where the previous text ended
      g: { ctm: ID, font: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 },
      saved: [],
      tm: ID,
      tlm: ID,
    };
    this.run(Buffer.concat(parts), resources, st, 0, new Set());
    return st.out
      .join("")
      .replace(/[\x00-\x08\x0b-\x1f]/g, "")
      // CJK fonts often map glyphs to Kangxi radicals (U+2F47 for 日), Latin ones to ligatures (U+FB01)
      .replace(/[\u2e80-\u2fdf\ufb00-\ufb06]/g, (c) => c.normalize("NFKC"))
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .trim();
  }

  run(data, resources, st, depth, active) {
    const res = this.resolve(resources) ?? {};
    const lx = new Lexer(data, 0, true);
    const args = [];
    for (let t = lx.read(); t !== EOF; t = lx.read()) {
      this.tick();
      if (!(t instanceof Op)) {
        if (args.length < MAX_ARGS) args.push(t);
        continue;
      }
      this.op(t.op, args, res, st, depth, active);
      args.length = 0;
    }
  }

  op(op, a, res, st, depth, active) {
    const g = st.g;
    const move = (x, y) => (st.tm = st.tlm = mul([1, 0, 0, 1, x, y], st.tlm));
    switch (op) {
      case "q":
        if (st.saved.length >= MAX_SAVED) break;
        st.saved.push(g);
        st.g = { ...g };
        break;
      case "Q":
        st.g = st.saved.pop() ?? g;
        break;
      case "cm":
        if (nums(a, 6)) g.ctm = mul(nums(a, 6), g.ctm);
        break;
      case "BT":
        st.tm = st.tlm = ID;
        break;
      case "Tf":
        g.font = typeof a[0] === "string" ? this.font(this.resolve(res.Font)?.[a[0]]) : null;
        g.fs = Number.isFinite(a[1]) ? a[1] : 0;
        break;
      case "Tc":
      case "Tw":
      case "TL":
      case "Ts":
        if (Number.isFinite(a[0])) g[{ Tc: "tc", Tw: "tw", TL: "tl", Ts: "rise" }[op]] = a[0];
        break;
      case "Tz":
        if (Number.isFinite(a[0])) g.th = a[0] / 100;
        break;
      case "Td":
      case "TD":
        if (!nums(a, 2)) break;
        if (op === "TD") g.tl = -a[1];
        move(a[0], a[1]);
        break;
      case "Tm":
        if (nums(a, 6)) st.tm = st.tlm = nums(a, 6);
        break;
      case "T*":
        move(0, -g.tl);
        break;
      case "Tj":
        this.show(a[0], st);
        break;
      case "'":
        move(0, -g.tl);
        this.show(a[0], st);
        break;
      case '"':
        if (Number.isFinite(a[0]) && Number.isFinite(a[1])) [g.tw, g.tc] = a;
        move(0, -g.tl);
        this.show(a[2], st);
        break;
      case "TJ":
        for (const x of Array.isArray(a[0]) ? a[0] : []) {
          if (Number.isFinite(x)) st.tm = mul([1, 0, 0, 1, (-x / 1000) * g.fs * g.th, 0], st.tm);
          else this.show(x, st);
        }
        break;
      case "Do": {
        const xo = typeof a[0] === "string" ? this.resolve(this.resolve(res.XObject)?.[a[0]]) : null;
        if (!(xo instanceof Stream) || xo.dict.Subtype !== "Form" || active.has(xo) || depth >= MAX_DEPTH) break;
        const saved = st.g;
        const savedDepth = st.saved.length;
        const matrix = this.resolve(xo.dict.Matrix);
        st.g = { ...g, ctm: Array.isArray(matrix) && nums(matrix, 6) ? mul(matrix, g.ctm) : g.ctm };
        active.add(xo);
        this.run(this.decode(xo), xo.dict.Resources ?? res, st, depth + 1, active);
        active.delete(xo);
        st.g = saved;
        st.saved.length = savedDepth;
        break;
      }
    }
  }

  // Appends one shown string, first adding a space or line break when its
  // start is away from where the previous string ended.
  show(bytes, st) {
    const g = st.g;
    if (!g.font || !Buffer.isBuffer(bytes)) return;
    const m = mul(st.tm, g.ctm);
    const x = m[2] * g.rise + m[4];
    const y = m[3] * g.rise + m[5];
    const size = Math.abs(g.fs) * Math.hypot(m[2], m[3]);
    if (st.last && size > 0) {
      const len = Math.hypot(m[0], m[1]) || 1;
      const dx = x - st.last[0];
      const dy = y - st.last[1];
      const along = (dx * m[0] + dy * m[1]) / len;
      const across = (dy * m[0] - dx * m[1]) / len;
      if (Math.abs(across) > size * 0.5) st.out.push("\n");
      else if (along > size * 0.15 || along < -size) st.out.push(" ");
    }
    const f = g.font;
    let text = "";
    let width = 0;
    for (let i = 0; i + f.bytes <= bytes.length; i += f.bytes) {
      const code = f.bytes === 2 ? bytes.readUInt16BE(i) : bytes[i];
      text += f.unicode(code) ?? "";
      width += (f.width(code) * g.fs + g.tc + (f.bytes === 1 && code === 32 ? g.tw : 0)) * g.th;
    }
    st.out.push(text);
    st.tm = mul([1, 0, 0, 1, width, 0], st.tm);
    const e = mul(st.tm, g.ctm);
    st.last = [e[2] * g.rise + e[4], e[3] * g.rise + e[5]];
  }
}

// Returns { text, pages } where pages holds each page's text in order.
function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("extractPdfText expects a Buffer");
  if (buffer.length > MAX_INPUT_BYTES) throw new PdfLimitError(`over ${MAX_INPUT_BYTES / 1024 / 1024}MB`);
  const doc = new PdfDoc(buffer);
  if (doc.trailer.Encrypt) throw new Error("This PDF is encrypted; encrypted PDFs aren't supported");
  const pages = doc.pages().map((p) => doc.pageText(p));
  if (!pages.some(Boolean)) {
    throw new Error("This PDF has no extractable text (it may be a scanned image; OCR isn't supported)");
  }
  return { text: pages.join("\n\n"), pages };
}

module.exports = { extractPdfText };
