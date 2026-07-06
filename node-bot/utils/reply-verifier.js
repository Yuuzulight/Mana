const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```(\w+)?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    blocks.push({ lang: (m[1] || '').toLowerCase(), code: m[2] });
  }
  return blocks;
}

function extractJsonBlocks(text) {
  const re = /```json\n([\s\S]*?)```/g;
  let m;
  const list = [];
  while ((m = re.exec(text))) {
    list.push(m[1]);
  }
  return list;
}

function simpleBracketCheck(s) {
  const stack = [];
  const pairs = { '{': '}', '[': ']', '(': ')' };
  for (let ch of s) {
    if (pairs[ch]) stack.push(ch);
    else if (Object.values(pairs).includes(ch)) {
      const open = stack.pop();
      if (!open || pairs[open] !== ch) return false;
    }
  }
  return stack.length === 0;
}

function writeTemp(code, ext) {
  const tmp = path.join(os.tmpdir(), `mana-verify-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tmp, code, 'utf8');
  return tmp;
}

function checkPythonSyntax(code) {
  try {
    const tmp = writeTemp(code, '.py');
    const res = spawnSync(process.env.PYTHON || 'python', ['-m', 'py_compile', tmp], { encoding: 'utf8', timeout: 5000 });
    fs.unlinkSync(tmp);
    if (res.status === 0) return { ok: true };
    return { ok: false, error: res.stderr || res.stdout || 'python compile failed' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function checkJsSyntax(code) {
  try {
    const tmp = writeTemp(code, '.js');
    // Use node to attempt function compile; new Function on file content
    const wrapper = `const fs=require('fs');new Function(fs.readFileSync(process.argv[1], 'utf8'))`;
    const res = spawnSync(process.env.NODE || 'node', ['-e', wrapper, tmp], { encoding: 'utf8', timeout: 5000 });
    fs.unlinkSync(tmp);
    if (res.status === 0) return { ok: true };
    return { ok: false, error: res.stderr || res.stdout || 'node syntax check failed' };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function verifyReply(text, mode = 'everyday') {
  const issues = [];

  // 1) JSON block validation
  const jsonBlocks = extractJsonBlocks(text);
  for (const jb of jsonBlocks) {
    try {
      JSON.parse(jb);
    } catch (e) {
      issues.push({ type: 'json', message: `Invalid JSON block: ${e.message}` });
    }
  }

  // 2) Code block checks (only basic syntax checks)
  const codeBlocks = extractCodeBlocks(text);
  for (const b of codeBlocks) {
    const lang = b.lang || '';
    const code = b.code || '';
    if (!simpleBracketCheck(code)) {
      issues.push({ type: 'syntax', message: `Unbalanced brackets in ${lang || 'code'} block` });
    }
    if (lang === 'py' || lang === 'python') {
      const res = checkPythonSyntax(code);
      if (!res.ok) issues.push({ type: 'python', message: res.error });
    } else if (lang === 'js' || lang === 'javascript' || lang === 'ts') {
      const res = checkJsSyntax(code);
      if (!res.ok) issues.push({ type: 'javascript', message: res.error });
    } else {
      // best-effort: try JS syntax for unknown code that looks like JS
      if (/\bfunction\b|=>|console\.log|var\s|let\s|const\s/.test(code)) {
        const res = checkJsSyntax(code);
        if (!res.ok) issues.push({ type: 'javascript', message: res.error });
      }
    }
  }

  // 3) basic safety checks (length, forbidden tokens)
  if (typeof text === 'string') {
    if (text.length > 10000) issues.push({ type: 'length', message: 'Reply unusually long (>10000 chars)' });
    if (/\b(delete|rm -rf|shutdown|format)\b/i.test(text)) issues.push({ type: 'unsafe', message: 'Potentially unsafe command detected' });
  }

  return { ok: issues.length === 0, issues };
}

module.exports = { verifyReply };
