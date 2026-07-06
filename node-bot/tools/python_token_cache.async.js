const { spawn } = require('child_process');
const path = require('path');

const PY_SCRIPT = path.join(__dirname, 'python_token_cache.py');
const PY_BIN = process.env.PYTHON || 'python';

function runPython(args, options = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY_BIN, args, { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    if (p.stdout) p.stdout.on('data', (c) => (stdout += c.toString()));
    if (p.stderr) p.stderr.on('data', (c) => (stderr += c.toString()));
    p.on('error', (err) => reject(err));
    p.on('close', (code) => {
      if (code !== 0) {
        // still may have useful stdout
        if (stdout) return resolve({ code, stdout, stderr });
        return reject(new Error(`python exit ${code}: ${stderr}`));
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function countTokensForPath(filePath, rebuild = false) {
  const args = [PY_SCRIPT, '--path', filePath, '--json'];
  if (rebuild) args.push('--rebuild');
  const res = await runPython(args);
  try {
    const parsed = JSON.parse(res.stdout || res.stderr || '{}');
    const key = require('path').resolve(filePath);
    if (parsed && parsed[key] && typeof parsed[key].tokens === 'number') return parsed[key].tokens;
    if (parsed && typeof parsed.tokens === 'number') return parsed.tokens;
  } catch (e) {}
  // fallback: try to extract integer
  const m = (res.stdout || res.stderr || '').match(/"tokens"\s*:\s*(\d+)/);
  if (m) return Number(m[1]);
  throw new Error('unable to parse token count from python output');
}

async function countTokensForText(text, ext = '.py', rebuild = false) {
  // write to a temp file and call countTokensForPath
  const os = require('os');
  const fs = require('fs');
  const tmp = path.join(os.tmpdir(), `mana-token-async-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    return await countTokensForPath(tmp, rebuild);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

module.exports = { countTokensForPath, countTokensForText };
