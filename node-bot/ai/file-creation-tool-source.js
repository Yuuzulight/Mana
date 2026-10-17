const fs = require('node:fs');
const path = require('node:path');
const { runAnalysisSandbox, isAnalysisAvailable } = require('../tools/analysis-sandbox');
const { wrapUntrusted } = require('./untrusted-content');

const TOOL_NAME = 'files__create';
const FORMATS = ['docx', 'xlsx', 'pptx', 'pdf', 'csv'];
const MAX_TEXT = 120000;
const MAX_ROWS = 500;

const SCHEMA = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Create a local Word document, Excel workbook, PowerPoint deck, PDF, or CSV file from structured content. The file is returned in the chat for Save as...; generation is offline and runs in Mana\'s native sandbox. Use formulas as strings beginning with = in spreadsheet cells.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: FORMATS, description: 'The file format to create.' },
        name: { type: 'string', description: 'Output filename, including its extension.' },
        title: { type: 'string', description: 'Document, workbook, or deck title.' },
        sections: { type: 'array', maxItems: 40, items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } }, required: ['body'] } },
        tables: { type: 'array', maxItems: 20, items: { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' }, maxItems: 32 }, rows: { type: 'array', maxItems: MAX_ROWS, items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] }, maxItems: 32 } } }, required: ['columns', 'rows'] } },
        slides: { type: 'array', maxItems: 40, items: { type: 'object', properties: { title: { type: 'string' }, bullets: { type: 'array', maxItems: 20, items: { type: 'string' } }, body: { type: 'string' } } } },
      },
      required: ['format', 'name'],
    },
  },
};

function asText(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function validateSpec(args) {
  if (!args || !FORMATS.includes(args.format)) throw new Error(`format must be one of ${FORMATS.join(', ')}`);
  if (typeof args.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}\.(docx|xlsx|pptx|pdf|csv)$/i.test(args.name)) {
    throw new Error('name must be a safe filename with the selected document extension');
  }
  if (args.name.toLowerCase().split('.').pop() !== args.format) throw new Error('filename extension must match format');
  const sections = Array.isArray(args.sections) ? args.sections : [];
  const tables = Array.isArray(args.tables) ? args.tables : [];
  const slides = Array.isArray(args.slides) ? args.slides : [];
  if (sections.length > 40 || tables.length > 20 || slides.length > 40) throw new Error('document content exceeds the bounded limits');
  const rows = tables.reduce((n, table) => n + (Array.isArray(table?.rows) ? table.rows.length : 0), 0);
  if (rows > MAX_ROWS) throw new Error(`tables may contain at most ${MAX_ROWS} rows in total`);
  const value = { title: asText(args.title, 500), sections: sections.map(section => ({ heading: asText(section?.heading, 500), body: asText(section?.body) })), tables: tables.map(table => ({ columns: (Array.isArray(table?.columns) ? table.columns : []).slice(0, 32).map(value => asText(value, 500)), rows: (Array.isArray(table?.rows) ? table.rows : []).slice(0, MAX_ROWS).map(row => (Array.isArray(row) ? row : []).slice(0, 32).map(cell => typeof cell === 'string' ? cell.slice(0, 2000) : cell)) })), slides: slides.map(slide => ({ title: asText(slide?.title, 500), body: asText(slide?.body, 4000), bullets: (Array.isArray(slide?.bullets) ? slide.bullets : []).slice(0, 20).map(value => asText(value, 1000)) })) };
  if (JSON.stringify(value).length > MAX_TEXT) throw new Error(`document content must be at most ${MAX_TEXT} characters`);
  return value;
}

function generatorCode(spec, format, name) {
  const encoded = JSON.stringify(spec).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const safeName = JSON.stringify(name);
  return `
import base64, csv, io, json, re, struct, zipfile
from pathlib import Path

spec = json.loads("${encoded}")
out = Path(output_dir) / ${safeName}

def esc(value):
    value = str(value if value is not None else '')
    return (value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            .replace('"', '&quot;').replace("'", '&apos;'))

def text(value):
    return str(value if value is not None else '')

def cells():
    tables = spec.get('tables', [])
    if tables:
        rows = []
        for table in tables:
            rows.append(table.get('columns', []))
            rows.extend(table.get('rows', []))
        return rows
    return [[spec.get('title', '')]] + [[s.get('heading', ''), s.get('body', '')] for s in spec.get('sections', [])]

def write_docx():
    paragraphs = []
    if spec.get('title'): paragraphs.append('<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % esc(spec['title']))
    for section in spec.get('sections', []):
        if section.get('heading'): paragraphs.append('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>%s</w:t></w:r></w:p>' % esc(section['heading']))
        for line in section.get('body', '').split('\\n'):
            paragraphs.append('<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % esc(line))
    for table in spec.get('tables', []):
        all_rows = [table.get('columns', [])] + table.get('rows', [])
        trs = []
        for row in all_rows:
            trs.append('<w:tr>%s</w:tr>' % ''.join('<w:tc><w:p><w:r><w:t>%s</w:t></w:r></w:p></w:tc>' % esc(cell) for cell in row))
        paragraphs.append('<w:tbl>%s</w:tbl>' % ''.join(trs))
    document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>%s<w:sectPr/></w:body></w:document>' % ''.join(paragraphs)
    content = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content); z.writestr('_rels/.rels', rels); z.writestr('word/document.xml', document)

def col(n):
    result = ''
    while n: n, rem = divmod(n - 1, 26); result = chr(65 + rem) + result
    return result or 'A'

def write_xlsx():
    rows = []
    for row in cells(): rows.append('<row>%s</row>' % ''.join('<c r="%s%d" t="%s"><v>%s</v></c>' % (col(i + 1), len(rows) + 1, 'str', esc(text(value))) for i, value in enumerate(row)))
    sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>%s</sheetData></worksheet>' % ''.join(rows)
    workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
    rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    wb_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', types); z.writestr('_rels/.rels', rels); z.writestr('xl/workbook.xml', workbook); z.writestr('xl/_rels/workbook.xml.rels', wb_rels); z.writestr('xl/worksheets/sheet1.xml', sheet)

def write_pptx():
    # A minimal, readable one-slide deck; additional slides are emitted as text blocks on later slides.
    slides = spec.get('slides') or [{'title': spec.get('title', 'Mana'), 'body': '\\n'.join(s.get('body', '') for s in spec.get('sections', [])), 'bullets': []}]
    slide_text = '\\n\\n'.join('\\n'.join([s.get('title', '')] + s.get('bullets', []) + ([s.get('body', '')] if s.get('body') else [])) for s in slides)
    body = esc(slide_text)
    xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld></p:presentation>' % body
    types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>'
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z: z.writestr('[Content_Types].xml', types); z.writestr('ppt/presentation.xml', xml)

def write_pdf():
    lines = [spec.get('title', 'Mana')] + [s.get('heading', '') + (': ' if s.get('heading') and s.get('body') else '') + s.get('body', '') for s in spec.get('sections', [])]
    lines = [re.sub(r'[^\\x20-\\x7e]', '?', line)[:110] for line in lines]
    stream = 'BT\\n/F1 11 Tf\\n72 760 Td\\n' + '\\n'.join('(%s) Tj 0 -16 Td' % line.replace('\\\\', '\\\\').replace('(', '\\\\(').replace(')', '\\\\)') for line in lines) + '\\nET'
    objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length %d >>\\nstream\\n%s\\nendstream' % (len(stream.encode()), stream)]
    pdf = '%PDF-1.4\\n'; offsets = []
    for i, obj in enumerate(objects, 1): offsets.append(len(pdf.encode())); pdf += '%d 0 obj\\n%s\\nendobj\\n' % (i, obj)
    start = len(pdf.encode()); pdf += 'xref\\n0 %d\\n0000000000 65535 f \\n' % (len(objects) + 1); pdf += ''.join('%010d 00000 n \\n' % offset for offset in offsets); pdf += 'trailer\\n<< /Size %d /Root 1 0 R >>\\nstartxref\\n%d\\n%%%%EOF\\n' % (len(objects) + 1, start)
    out.write_bytes(pdf.encode('latin-1', 'replace'))

def write_csv():
    with out.open('w', newline='', encoding='utf-8') as handle:
        writer = csv.writer(handle); writer.writerows(cells())

{'docx': write_docx, 'xlsx': write_xlsx, 'pptx': write_pptx, 'pdf': write_pdf, 'csv': write_csv}[${JSON.stringify(format)}]()
print('created ' + out.name)
`;
}

function persistOutput(file, outputsDir) {
  const root = path.resolve(outputsDir);
  fs.mkdirSync(root, { recursive: true });
  let candidate = path.join(root, file.name);
  const extension = path.extname(file.name);
  const stem = path.basename(file.name, extension);
  let suffix = 2;
  while (fs.existsSync(candidate)) candidate = path.join(root, `${stem} (${suffix++})${extension}`);
  const temporary = `${candidate}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, Buffer.from(file.data, 'base64'), { flag: 'wx' });
  try { fs.renameSync(temporary, candidate); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  return candidate;
}

function createFileToolSource(options = {}) {
  const env = options.env || process.env;
  const enabled = options.enabled ?? (env.MANA_ANALYSIS_ENABLED === '1' || (env.MANA_ANALYSIS_ENABLED !== '0' && isAnalysisAvailable(env)));
  const runSandbox = options.runSandbox || runAnalysisSandbox;
  return {
    listToolSchemas: () => enabled ? [SCHEMA] : [],
    isKnownToolName: name => enabled && name === TOOL_NAME,
    executeTool: async (name, args = {}) => {
      if (!enabled || name !== TOOL_NAME) throw new Error(`unknown file tool: ${name}`);
      const spec = validateSpec(args);
      const result = await runSandbox({ code: generatorCode(spec, args.format, args.name) }, { shouldStop: options.shouldStop });
      if (result.error) throw new Error(wrapUntrusted('file creation failure', result.error));
      const file = (result.files || []).find(item => item.name === args.name);
      if (!file) throw new Error('file generation completed without returning the requested file');
      const savedPath = persistOutput(file, options.outputsDir || process.env.MANA_OUTPUTS_DIR || path.join(__dirname, '..', 'data', 'outputs'));
      options.onFile?.({ ...file, savedPath });
      return wrapUntrusted('file creation', JSON.stringify({ name: file.name, bytes: Buffer.from(file.data, 'base64').length, savedPath, readyToSave: true }));
    },
  };
}

module.exports = { createFileToolSource, TOOL_NAME, validateSpec, generatorCode, SCHEMA };

