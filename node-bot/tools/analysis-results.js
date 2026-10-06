const MAX_FILE_BYTES = 256000;
const MAX_RESULT_BYTES = 1024000;

function normalizeAnalysisOutputs(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  let used = 0;
  const decode = (data) => {
    if (typeof data !== 'string' || data.length > 342000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data || bytes.length > MAX_FILE_BYTES || used + bytes.length > MAX_RESULT_BYTES) return null;
    return bytes;
  };
  const charts = (Array.isArray(value.charts) ? value.charts : []).slice(0, 4).flatMap(chart => {
    const data = chart?.data ?? (typeof chart?.dataUrl === 'string' && chart.dataUrl.startsWith('data:image/png;base64,')
      ? chart.dataUrl.slice('data:image/png;base64,'.length) : null);
    const bytes = decode(data);
    if (!bytes || bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') return [];
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 4096 || height > 4096 || width * height > 4000000) return [];
    used += bytes.length;
    return [{ name: 'Analysis chart', dataUrl: `data:image/png;base64,${data}` }];
  });
  const names = new Set();
  const files = (Array.isArray(value.files) ? value.files : []).slice(0, 8).flatMap(file => {
    if (typeof file?.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$/.test(file.name) || file.name.endsWith('.') || file.name.endsWith(' ') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.name)) return [];
    const key = file.name.toLowerCase();
    if (names.has(key)) return [];
    const bytes = decode(file.data);
    if (!bytes) return [];
    names.add(key);
    used += bytes.length;
    return [{ name: file.name, data: file.data }];
  });
  let tableChars = 0;
  const tables = (Array.isArray(value.tables) ? value.tables : []).slice(0, 4).flatMap(table => {
    if (!Array.isArray(table?.columns) || !table.columns.length || table.columns.length > 8 || !Array.isArray(table.rows)) return [];
    const cell = text => typeof text === 'string' ? text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256) : '';
    const columns = table.columns.map(cell);
    const rows = table.rows.slice(0, 20).filter(row => Array.isArray(row) && row.length === columns.length).map(row => row.map(cell));
    const chars = [...columns, ...rows.flat()].reduce((sum, text) => sum + text.length, 0);
    if (tableChars + chars > 10000) return [];
    tableChars += chars;
    return [{ columns, rows }];
  });
  return { charts, files, tables };
}

module.exports = { normalizeAnalysisOutputs, MAX_FILE_BYTES, MAX_RESULT_BYTES };
