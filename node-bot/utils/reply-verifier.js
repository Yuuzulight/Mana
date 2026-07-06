const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esprima = require("esprima");
const tokenCache = require("../tools/python_token_cache");
const tokenCacheAsync = require("../tools/python_token_cache.async");

function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```(\w+)?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    blocks.push({ lang: (m[1] || "").toLowerCase(), code: m[2] });
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
  const pairs = { "{": "}", "[": "]", "(": ")" };
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
  const tmp = path.join(
    os.tmpdir(),
    `mana-verify-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
  );
  fs.writeFileSync(tmp, code, "utf8");
  return tmp;
}

function checkPythonSyntax(code) {
  try {
    const tmp = writeTemp(code, ".py");
    const res = spawnSync(
      process.env.PYTHON || "python",
      ["-m", "py_compile", tmp],
      { encoding: "utf8", timeout: 5000 },
    );
    fs.unlinkSync(tmp);
    if (res.status === 0) return { ok: true };
    return {
      ok: false,
      error: res.stderr || res.stdout || "python compile failed",
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function checkJsSyntax(code) {
  // Use esprima to parse and return AST errors quickly without spawning node
  try {
    esprima.parseScript(code, { tolerant: true, jsx: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function analyzeJsAstForRisks(code) {
  const risks = [];
  let ast;
  try {
    ast = esprima.parseScript(code, { tolerant: true });
  } catch (e) {
    return risks;
  }

  function walk(node) {
    if (!node || typeof node !== "object") return;
    // detect eval or Function constructor
    if (
      node.type === "CallExpression" &&
      node.callee &&
      node.callee.type === "Identifier" &&
      node.callee.name === "eval"
    ) {
      risks.push({ type: "eval", message: "Use of eval detected" });
    }
    if (
      (node.type === "NewExpression" || node.type === "CallExpression") &&
      node.callee &&
      node.callee.type === "Identifier" &&
      node.callee.name === "Function"
    ) {
      risks.push({
        type: "function_constructor",
        message: "Function constructor detected",
      });
    }
    // require('child_process') or child_process.exec
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments &&
      node.arguments[0] &&
      node.arguments[0].value === "child_process"
    ) {
      risks.push({
        type: "child_process_require",
        message: 'require("child_process") used',
      });
    }
    if (
      node.type === "MemberExpression" &&
      node.object &&
      node.object.type === "Identifier" &&
      node.object.name === "child_process" &&
      node.property &&
      node.property.type === "Identifier"
    ) {
      const name = node.property.name;
      if (["exec", "execSync", "spawn", "spawnSync"].includes(name)) {
        risks.push({
          type: "child_process_call",
          message: `child_process.${name} usage detected`,
        });
      }
    }
    // process.exit / process.kill
    if (
      node.type === "MemberExpression" &&
      node.object &&
      node.object.type === "Identifier" &&
      node.object.name === "process" &&
      node.property &&
      node.property.type === "Identifier"
    ) {
      if (["exit", "kill"].includes(node.property.name)) {
        risks.push({
          type: "process_exit",
          message: `process.${node.property.name} usage detected`,
        });
      }
    }
    // fs.writeFileSync / fs.writeFile / fs.appendFile etc targeting .git or tools/vector_store
    if (
      node.type === "MemberExpression" &&
      node.object &&
      node.object.type === "Identifier" &&
      node.object.name === "fs" &&
      node.property &&
      node.property.type === "Identifier"
    ) {
      const name = node.property.name;
      if (
        [
          "writeFileSync",
          "writeFile",
          "appendFile",
          "appendFileSync",
          "unlinkSync",
          "rmSync",
        ].includes(name)
      ) {
        // try to inspect argument literal path
        const parent = node.__parent; // we'll set parents during walk
        // locate CallExpression parent
        let call = parent;
        while (call && call.type !== "CallExpression") call = call.__parent;
        if (
          call &&
          call.arguments &&
          call.arguments[0] &&
          call.arguments[0].type === "Literal" &&
          typeof call.arguments[0].value === "string"
        ) {
          const p = call.arguments[0].value.toLowerCase();
          if (
            p.includes(".git") ||
            (p.includes("tools") && p.includes("vector_store"))
          ) {
            risks.push({
              type: "fs_sensitive_write",
              message: `fs.${name} targeting sensitive path: ${call.arguments[0].value}`,
            });
          } else {
            risks.push({ type: "fs_write", message: `fs.${name} used` });
          }
        } else {
          risks.push({
            type: "fs_write",
            message: `fs.${name} used with dynamic path`,
          });
        }
      }
    }

    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child && typeof child === "object") {
        if (Array.isArray(child)) {
          for (const c of child) {
            if (c && typeof c === "object") {
              c.__parent = node;
              walk(c);
            }
          }
        } else {
          child.__parent = node;
          walk(child);
        }
      }
    }
  }

  walk(ast);
  return risks;
}

function analyzePythonForRisks(code) {
  // Prefer an AST-based analyzer implemented in Python for accuracy. Fallback to regex heuristics if the analyzer is unavailable.
  const risks = [];
  try {
    const scriptPath = path.join(
      __dirname,
      "..",
      "tools",
      "python_ast_analyzer.py",
    );
    if (fs.existsSync(scriptPath)) {
      const tmp = writeTemp(code, ".py");
      const res = spawnSync(process.env.PYTHON || "python", [scriptPath, tmp], {
        encoding: "utf8",
        timeout: 5000,
      });
      try {
        fs.unlinkSync(tmp);
      } catch (e) {}
      if (res.status === 0 && res.stdout) {
        try {
          const parsed = JSON.parse(res.stdout);
          if (Array.isArray(parsed))
            return parsed.map((p) => ({
              type: p.type || "python_risk",
              message: p.message || JSON.stringify(p),
            }));
        } catch (e) {
          // fall through to heuristics below
        }
      }
    }
  } catch (e) {
    // swallow and fallback
  }

  // Fallback heuristics (less precise)
  const dangerous = [
    /\bsubprocess\b/i,
    /\bos\.system\b/i,
    /\beval\b/i,
    /\bexec\b/i,
    /\bopen\([^)]*['\"](?:(?:\\.|[^'\\])+)['\"][^)]*[,)]/i, // open('path', 'w')
    /\bos\.remove\b|\bos\.unlink\b|\bshutil\.rmtree\b/i,
  ];
  for (const r of dangerous) {
    if (r.test(code)) {
      risks.push({
        type: "python_danger",
        message: `Potentially dangerous python usage: ${r}`,
      });
    }
  }
  if (/\.git\b|tools[\\\/]vector_store|pending_writes/i.test(code)) {
    risks.push({
      type: "python_sensitive_write",
      message: "Python code references sensitive repository paths",
    });
  }
  return risks;
}

async function verifyReply(text, mode = "everyday") {
  const issues = [];

  // 1) JSON block validation
  const jsonBlocks = extractJsonBlocks(text);
  for (const jb of jsonBlocks) {
    try {
      JSON.parse(jb);
    } catch (e) {
      issues.push({
        type: "json",
        message: `Invalid JSON block: ${e.message}`,
      });
    }
  }

  // 2) Code block checks (syntax + AST-level hazards)
  const codeBlocks = extractCodeBlocks(text);
  for (const b of codeBlocks) {
    const lang = b.lang || "";
    const code = b.code || "";
    if (!simpleBracketCheck(code)) {
      issues.push({
        type: "syntax",
        message: `Unbalanced brackets in ${lang || "code"} block`,
      });
    }

    // Token-based checks: estimate tokens for the code block and flag large blocks
    try {
      const ext = lang && /py/i.test(lang) ? ".py" : ".py";
      const toks = await tokenCacheAsync.countTokensForText(code, ext, false);
      if (typeof toks === "number") {
        if (toks > 3000) {
          issues.push({
            type: "size",
            message: `Large code block (~${toks} tokens)`,
          });
        }
      }
    } catch (e) {
      // token counting failure shouldn't block verification; ignore
    }

    if (lang === "py" || lang === "python") {
      const res = checkPythonSyntax(code);
      if (!res.ok) issues.push({ type: "python_syntax", message: res.error });
      const risks = analyzePythonForRisks(code);
      for (const r of risks)
        issues.push({ type: "python_risk", message: r.message });
    } else if (lang === "js" || lang === "javascript" || lang === "ts") {
      const res = checkJsSyntax(code);
      if (!res.ok)
        issues.push({ type: "javascript_syntax", message: res.error });
      const risks = analyzeJsAstForRisks(code);
      for (const r of risks)
        issues.push({ type: "javascript_risk", message: r.message });
    } else {
      // best-effort: try JS syntax/AST for unknown code that looks like JS
      if (/\bfunction\b|=>|console\.log|var\s|let\s|const\s/.test(code)) {
        const res = checkJsSyntax(code);
        if (!res.ok)
          issues.push({ type: "javascript_syntax", message: res.error });
        const risks = analyzeJsAstForRisks(code);
        for (const r of risks)
          issues.push({ type: "javascript_risk", message: r.message });
      } else if (/\bdef\b|import\s|from\s/.test(code)) {
        const res = checkPythonSyntax(code);
        if (!res.ok) issues.push({ type: "python_syntax", message: res.error });
        const risks = analyzePythonForRisks(code);
        for (const r of risks)
          issues.push({ type: "python_risk", message: r.message });
      }
    }
  }

  // 3) deeper safety heuristics on plain text (commands, secrets, length)
  if (typeof text === "string") {
    // Token-aware reply length check (prefer accurate python token count)
    try {
      const totalTokens = await tokenCacheAsync.countTokensForText(
        String(text),
        ".py",
        false,
      );
      if (typeof totalTokens === "number" && totalTokens > 20000) {
        issues.push({
          type: "length",
          message: `Reply unusually long (~${totalTokens} tokens)`,
        });
      }
    } catch (e) {
      // fallback to character-length check if token counting fails
      if (text.length > 20000)
        issues.push({
          type: "length",
          message: "Reply unusually long (>20000 chars)",
        });
    }

    const dangerousCmds =
      /\b(rm\s+-rf|rm\s+-R|del\s+\\?\/F\\?\/Q|shutdown\b|format\b)\b/i;
    if (dangerousCmds.test(text))
      issues.push({
        type: "unsafe",
        message: "Potentially destructive shell command detected",
      });
    // possible secrets/keys (very simple heuristics)
    if (
      /[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}/.test(text) ||
      /AKIA[0-9A-Z]{16}/.test(text)
    ) {
      issues.push({
        type: "secrets",
        message: "Possible secret or API key detected in reply",
      });
    }
  }

  // 4) policy: in 'coding' mode be stricter
  if (mode === "coding") {
    // escalate dynamic code execution usage
    const execRisks = issues.filter((i) =>
      /eval|Function constructor|child_process|subprocess|os\.system|process\.exit/.test(
        i.message,
      ),
    );
    if (execRisks.length) {
      // mark as not OK but include details
      return { ok: false, issues };
    }
  }

  return { ok: issues.length === 0, issues };
}

module.exports = { verifyReply };
