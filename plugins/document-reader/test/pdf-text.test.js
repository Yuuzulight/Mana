const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const { extractPdfText } = require("../pdf-text");

// chromium-mixed.pdf and image-only.pdf were printed by headless Edge
// (playwright-core page.pdf()); the rest are built here byte by byte.
const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));
const TOO_BIG = /too large or complex to read safely/;

const bin = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(x, "latin1"));
const stream = (data, dict = "") =>
  Buffer.concat([bin(`<< ${dict} /Length ${bin(data).length} >>\nstream\n`), bin(data), bin("\nendstream")]);

// Lays out numbered objects after a header; `tail(offsets, length)` adds the xref.
function build(objects, tail) {
  const parts = [bin("%PDF-1.7\n")];
  let length = parts[0].length;
  const offsets = {};
  for (const [num, body] of Object.entries(objects)) {
    offsets[num] = length;
    const b = Buffer.concat([bin(`${num} 0 obj\n`), bin(body), bin("\nendobj\n")]);
    parts.push(b);
    length += b.length;
  }
  return Buffer.concat([...parts, bin(tail(offsets, length))]);
}

const classicXref = (extra = "") => (offsets, length) => {
  const size = Math.max(...Object.keys(offsets).map(Number)) + 1;
  let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) {
    x += offsets[i] === undefined ? "0000000000 65535 f \n" : `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  return `${x}trailer\n<< /Size ${size} /Root 1 0 R ${extra} >>\nstartxref\n${length}\n%%EOF\n`;
};

// One page whose resources live on the Pages node (so they're inherited),
// with a standard-14 font as /F1 unless overridden.
const onePage = (content, overrides = {}, extra = "") =>
  build(
    {
      1: "<< /Type /Catalog /Pages 2 0 R >>",
      2: "<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>",
      3: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
      4: stream(content),
      5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      ...overrides,
    },
    classicXref(extra),
  );

test("Chromium PDF: headings, lists, table, accents, CJK and emoji come out in reading order", () => {
  const { text, pages } = extractPdfText(fixture("chromium-mixed.pdf"));
  assert.equal(pages.length, 1);
  assert.equal(
    text,
    [
      "Mana Reading Test",
      "The quick brown fox jumps over the lazy dog.",
      "Shopping list",
      "Green tea",
      "Rice crackers",
      "Café au lait",
      "Schedule",
      "Day Task",
      "Monday Stream",
      "Tuesday Rest",
      "Accents: naïve façade, Straße, Ærø, ñandú",
      "日本語のテキスト 中文测试",
      "Emoji: 🌸",
    ].join("\n"),
  );
});

test("an image-only PDF is refused as having no text", () => {
  assert.throws(() => extractPdfText(fixture("image-only.pdf")), /no extractable text .*scanned/);
});

test("classic xref: WinAnsi/MacRoman/Standard + /Differences, TJ gaps, line breaks, a Form XObject, an inline image", () => {
  const content = [
    "BT /F1 12 Tf 14 TL 72 700 Td",
    String.raw`(Caf\200 cr\350me) Tj`,
    "T* [(Hello) -300 (World)] TJ",
    "T* [(Ke) 20 (rning)] TJ",
    String.raw`(\201 \202nd \203) '`,
    "ET /X1 Do",
    String.raw`BT /F2 12 Tf 72 580 Td (\216t\216) Tj /F3 12 Tf 0 -14 Td (\341 it\047s) Tj ET`,
    "q BI /W 4 /H 1 /CS /G /BPC 8 ID (Oops) Tj\nEI Q",
  ].join("\n");
  const pdf = onePage(content, {
    2:
      "<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources " +
      "<< /Font << /F1 5 0 R /F2 7 0 R /F3 8 0 R >> /XObject << /X1 6 0 R >> >> >>",
    5:
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding " +
      "/BaseEncoding /WinAnsiEncoding /Differences [128 /eacute /uni263A /f_i /u1F600] >> >>",
    6: stream("BT /F1 12 Tf 72 600 Td (From a form) Tj ET", "/Type /XObject /Subtype /Form /BBox [0 0 600 800]"),
    7: "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /MacRomanEncoding >>",
    8: "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>",
  });
  assert.equal(extractPdfText(pdf).text, "Café crème\nHello World\nKerning\n☺ find 😀\nFrom a form\nété\nÆ it’s");
});

// PNG-predicted rows (1 byte per pixel), cycling through all five filter types
function pngPredict(rows) {
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let prev = rows[0].map(() => 0);
  return Buffer.concat(
    rows.map((row, r) => {
      const type = r % 5;
      const encoded = row.map((x, i) => {
        const [left, up, upLeft] = [i ? row[i - 1] : 0, prev[i], i ? prev[i - 1] : 0];
        return (x - [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][type]) & 0xff;
      });
      prev = row;
      return Buffer.from([type, ...encoded]);
    }),
  );
}

test("xref stream + object stream + Identity-H font through a ToUnicode CMap", () => {
  const inObjStm = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    4: "<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [8 0 R] /ToUnicode 6 0 R >>",
    8: "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /DW 1000 /W [1 [500 500] 10 20 600] >>",
  };
  let header = "";
  let body = "";
  for (const [num, obj] of Object.entries(inObjStm)) {
    header += `${num} ${body.length} `;
    body += `${obj}\n`;
  }
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    "2 beginbfchar <0001> <0048> <0002> <0069> endbfchar",
    "2 beginbfrange <0003> <0004> <0061> <000A> <000C> [<D83CDF38> <65E5> <0041>] endbfrange",
    "endcmap end end",
  ].join("\n");
  const objects = {
    5: stream(zlib.deflateSync("BT /F1 10 Tf 50 700 Td <0001000200030004> Tj 0 -12 Td <000A000B000C> Tj ET"), "/Filter /FlateDecode"),
    6: stream(cmap),
    7: stream(zlib.deflateSync(header + body), `/Type /ObjStm /N 5 /First ${header.length} /Filter /FlateDecode`),
  };
  const pdf = build(objects, (offsets, length) => {
    const row = (type, a, b) => [type, a >> 8, a & 0xff, b];
    const rows = [
      row(0, 0, 0),
      row(2, 7, 0), row(2, 7, 1), row(2, 7, 2), row(2, 7, 3),
      row(1, offsets[5], 0), row(1, offsets[6], 0), row(1, offsets[7], 0),
      row(2, 7, 4),
      row(1, length, 0),
    ];
    const xref = stream(
      zlib.deflateSync(pngPredict(rows)),
      "/Type /XRef /Size 10 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>",
    );
    return Buffer.concat([bin("9 0 obj\n"), xref, bin(`\nendobj\nstartxref\n${length}\n%%EOF\n`)]);
  });
  assert.equal(extractPdfText(pdf).text, "Hiab\n🌸日A");
});

// Test-side encoders for the ASCII85 and LZW (EarlyChange 1) filters
function ascii85(buf) {
  let s = "";
  for (let i = 0; i < buf.length; i += 4) {
    const n = Math.min(4, buf.length - i);
    const chunk = Buffer.alloc(4);
    buf.copy(chunk, 0, i, i + n);
    let v = chunk.readUInt32BE(0);
    if (v === 0 && n === 4) {
      s += "z";
      continue;
    }
    let group = "";
    for (let k = 0; k < 5; k++, v = Math.floor(v / 85)) group = String.fromCharCode(33 + (v % 85)) + group;
    s += group.slice(0, n + 1);
  }
  return `${s}~>`;
}

function lzwEncode(buf) {
  const out = [];
  let acc = 0, bits = 0, width = 9, next = 258;
  const write = (code) => {
    acc = (acc << width) | code;
    bits += width;
    while (bits >= 8) out.push((acc >>> (bits -= 8)) & 0xff);
    acc &= (1 << bits) - 1;
  };
  const dict = new Map(Array.from({ length: 256 }, (_, i) => [String.fromCharCode(i), i]));
  write(256);
  let w = "";
  for (const ch of buf.toString("latin1")) {
    if (dict.has(w + ch)) {
      w += ch;
      continue;
    }
    write(dict.get(w));
    dict.set(w + ch, next++);
    if (next >= 1 << width) width++;
    w = ch;
  }
  write(dict.get(w));
  if (++next >= 1 << width) width++; // the decoder adds one more entry before EOD
  write(257);
  if (bits) out.push((acc << (8 - bits)) & 0xff);
  return Buffer.from(out);
}

test("ASCII85 over LZW (codes growing past 9 and 10 bits) and ASCIIHex content, on two pages", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `0 -14 Td (Line ${i} of the LZW test, word${i * 7}) Tj`);
  const content = bin(`BT /F1 12 Tf 72 800 Td\n${lines.join("\n")}\nET`);
  const pdf = onePage("", {
    2: "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>",
    4: stream(ascii85(lzwEncode(content)), "/Filter [/ASCII85Decode /LZWDecode]"),
    6: "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>",
    7: stream(`${Buffer.from("BT /F1 12 Tf 72 700 Td (Hex encoded) Tj ET").toString("hex")}>`, "/Filter /ASCIIHexDecode"),
  });
  const { pages } = extractPdfText(pdf);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].split("\n"), lines.map((_, i) => `Line ${i} of the LZW test, word${i * 7}`));
  assert.equal(pages[1], "Hex encoded");
});

test("an encrypted PDF is refused", () => {
  const pdf = onePage("BT /F1 12 Tf (secret) Tj ET", {}, "/Encrypt << /Filter /Standard /V 1 /R 2 >>");
  assert.throws(() => extractPdfText(pdf), /encrypted/);
});

test("a broken or missing xref is rebuilt by scanning for objects", () => {
  const pdf = onePage("BT /F1 12 Tf 72 700 Td (Recovered text) Tj ET");
  const shifted = Buffer.concat([pdf.subarray(0, 9), bin("% every offset is now wrong\n"), pdf.subarray(9)]);
  assert.equal(extractPdfText(shifted).text, "Recovered text");
  const truncated = pdf.subarray(0, pdf.lastIndexOf("xref"));
  assert.equal(extractPdfText(truncated).text, "Recovered text");
});

test("hostile: Form XObject loops and a circular page tree terminate", () => {
  const pdf = onePage("/X1 Do", {
    2: "<< /Type /Pages /Kids [3 0 R 2 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> /XObject << /X1 6 0 R /X2 7 0 R >> >> >>",
    6: stream("/X1 Do BT /F1 12 Tf (Loop) Tj ET /X2 Do", "/Subtype /Form"),
    7: stream("/X1 Do", "/Subtype /Form"),
  });
  assert.deepEqual(extractPdfText(pdf).pages, ["Loop"]);
});

test("hostile: Form XObject fan-out hits the operator limit", () => {
  const forms = {};
  let names = "";
  for (let i = 0; i < 6; i++) {
    forms[6 + i] = stream(i < 5 ? `/F${i + 1} Do `.repeat(50) : "BT /F1 12 Tf (leaf) Tj ET", "/Subtype /Form");
    names += `/F${i} ${6 + i} 0 R `;
  }
  const pdf = onePage("/F0 Do", {
    ...forms,
    2: `<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> /XObject << ${names}>> >> >>`,
  });
  assert.throws(() => extractPdfText(pdf), TOO_BIG);
});

test("hostile: a Flate bomb hits the decompressed-bytes limit", async () => {
  // 100MB of zeros, deflated in chunks so the test never holds it in memory
  const deflate = zlib.createDeflate({ level: 9 });
  const chunks = [];
  deflate.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => deflate.on("end", resolve));
  const zeros = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 100; i++) deflate.write(zeros);
  deflate.end();
  await done;
  const pdf = onePage("", { 4: stream(Buffer.concat(chunks), "/Filter /FlateDecode") });
  assert.throws(() => extractPdfText(pdf), TOO_BIG);
});

test("hostile: deep nesting and a huge object count are refused", () => {
  assert.throws(() => extractPdfText(onePage("[".repeat(100000))), TOO_BIG);

  const xref = stream(zlib.deflateSync(Buffer.alloc(600000)), "/Type /XRef /Size 600000 /W [1 0 0] /Root 1 0 R /Filter /FlateDecode");
  const pdf = Buffer.concat([bin("%PDF-1.7\n1 0 obj\n"), xref, bin("\nendobj\nstartxref\n9\n%%EOF\n")]);
  assert.throws(() => extractPdfText(pdf), TOO_BIG);
});

test("hostile: long digit runs don't trigger quadratic regex backtracking", () => {
  const digits = "1".repeat(2000000);
  // the recovery scan over a file with no objects at all
  assert.throws(() => extractPdfText(bin(`%PDF-1.7\n${digits}x`)), /Not a readable PDF/);
  // a number-like word in a content stream
  assert.throws(() => extractPdfText(onePage(`${digits}x Tj`)), /no extractable text/);
});
