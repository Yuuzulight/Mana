const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { execFileSync, spawn } = require("node:child_process");
const { runAnalysisSandbox, runProcess, HELPER_PATH, RUNTIME_DIR } = require("../tools/analysis-sandbox");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

test("analysis invokes only the native helper and validates results", async () => {
  const result = await runAnalysisSandbox({ code: "print(2+2)", files: [] }, {
    platform: "win32",
    runProcess: async (command, args, options) => {
      assert.equal(command, HELPER_PATH);
      if (args[0] === "--cleanup") return { code: 0 };
      assert.equal(args[0], RUNTIME_DIR);
      assert.equal(args[2], "60000");
      assert.equal(JSON.parse(options.input).code, "print(2+2)");
      return { code: 0, output: JSON.stringify({ logs: "4", charts: [{ data: PNG }] }), errors: "" };
    },
  });
  assert.equal(result.logs, "4");
  assert.equal(result.charts[0].dataUrl, `data:image/png;base64,${PNG}`);
});

test("analysis fails closed for absent helpers, malformed output and invalid input", async () => {
  await assert.rejects(runAnalysisSandbox({ code: "pass" }, { platform: "linux" }), /Windows AppContainer/);
  await assert.rejects(runAnalysisSandbox({ code: "x".repeat(40001) }, { platform: "win32" }), /code must contain/);
  await assert.rejects(runAnalysisSandbox({ code: "pass", files: [{ data: "x".repeat(9 * 1024 * 1024) }] }, { platform: "win32" }), /input limit/);
  await assert.rejects(runAnalysisSandbox({ code: "pass" }, { platform: "win32", runProcess: async () => ({ code: 1, errors: "AppContainer launch failed" }) }), /launch failed/);
  const result = await runAnalysisSandbox({ code: "pass" }, {
    platform: "win32", runProcess: async () => ({ code: 0, errors: "", output: JSON.stringify({ logs: "x", charts: [{ data: "<script>" }, { data: Buffer.from("not png").toString("base64") }] }) }),
  });
  assert.deepEqual(result.charts, []);
  const oversized = Buffer.from(PNG, "base64");
  oversized.writeUInt32BE(100000, 16);
  const bounded = await runAnalysisSandbox({ code: "pass" }, {
    platform: "win32", runProcess: async (command, args) => args[0] === "--cleanup" ? { code: 0 } : { code: 0, errors: "", output: JSON.stringify({ logs: "", charts: [{ data: oversized.toString("base64") }] }) },
  });
  assert.deepEqual(bounded.charts, []);
});

function fakeProcess() {
  const child = new EventEmitter();
  child.pid = 1;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = 0;
  child.kill = () => { child.killed++; queueMicrotask(() => child.emit("close", null)); return true; };
  return child;
}

test("helper transport bounds output and waits for termination on timeout", async () => {
  const child = fakeProcess();
  const pending = runProcess("helper", [], { spawnImpl: () => child });
  child.stdout.write("x".repeat(1500001));
  await assert.rejects(pending, /output limit/);
  assert.equal(child.killed, 1);
  const timed = fakeProcess();
  await assert.rejects(runProcess("helper", [], { timeoutMs: 5, spawnImpl: () => timed }), /timed out/);
  assert.equal(timed.killed, 1);
});

test("analysis runs one script at a time and continues after a failed run", async () => {
  let active = 0, peak = 0;
  const options = { platform: "win32", runProcess: async (command, args) => {
    if (args[0] === "--cleanup") return { code: 0 };
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { code: 0, errors: "", output: JSON.stringify({ logs: "done", charts: [] }) };
  } };
  await Promise.all([runAnalysisSandbox({ code: "pass" }, options), runAnalysisSandbox({ code: "pass" }, options)]);
  assert.equal(peak, 1);
  await assert.rejects(runAnalysisSandbox({ code: "" }, options));
  assert.equal((await runAnalysisSandbox({ code: "pass" }, options)).logs, "done");
});

test('Stop terminates the helper and refuses queued runs before spawning', async () => {
  const child = fakeProcess();
  await assert.rejects(runProcess('helper', [], { shouldStop: () => true, spawnImpl: () => child }), /stopped by the user/);
  assert.equal(child.killed, 1);
  await assert.rejects(runAnalysisSandbox({ code: 'pass' }, { shouldStop: () => true, runProcess: () => assert.fail('must not spawn') }), /stopped by the user/);
});

const live = process.platform === "win32" && process.env.MANA_TEST_ANALYSIS_LIVE === "1";

test('live Stop waits for Python termination and scratch cleanup', { skip: !live }, async () => {
  const started = Date.now();
  await assert.rejects(runAnalysisSandbox({ code: 'while True: pass', files: [] }, { shouldStop: () => Date.now() - started > 2000 }), /stopped by the user/);
  assert.equal(sandboxProcesses(), '');
});
function sandboxProcesses() {
  const output = execFileSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*Mana.Analysis.*worker.py*' } | Select-Object -ExpandProperty ProcessId"], { encoding: "utf8", windowsHide: true });
  return output.trim();
}

test("live AppContainer denies private reads, writes, internet, loopback, child processes and host secrets", { skip: !live }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mana-private-canary-"));
  const canary = path.join(dir, "private.txt");
  fs.writeFileSync(canary, "host-only-canary");
  try {
    const code = `import os, socket, subprocess, ctypes\nfrom ctypes import wintypes\nhandle = wintypes.HANDLE()\nadvapi = ctypes.WinDLL('advapi32', use_last_error=True)\nadvapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]\nassert advapi.OpenProcessToken(wintypes.HANDLE(-1), 8, ctypes.byref(handle))\nvalue = wintypes.DWORD(); size = wintypes.DWORD()\nassert advapi.GetTokenInformation(handle, 29, ctypes.byref(value), 4, ctypes.byref(size))\nassert value.value == 1, 'not an AppContainer'\nctypes.windll.kernel32.CloseHandle(handle)\nfor label, fn in [('private-read', lambda: open(${JSON.stringify(canary)}).read()), ('private-write', lambda: open(${JSON.stringify(canary)}, 'w')), ('internet', lambda: socket.create_connection(('1.1.1.1', 80), 1)), ('loopback', lambda: socket.create_connection(('127.0.0.1', 80), 1)), ('child', lambda: subprocess.run(['C:/Windows/System32/cmd.exe', '/c', 'echo child'], check=True))]:\n try:\n  fn(); raise AssertionError(label + ' unexpectedly allowed')\n except OSError as error:\n  print(label, 'denied', error.winerror)\nassert os.getenv('MANA_ANALYSIS_CANARY_SECRET') is None\nprint('sandbox-verified')`;
    process.env.MANA_ANALYSIS_CANARY_SECRET = "host-only-value";
    const result = await runAnalysisSandbox({ code, files: [] });
    assert.equal(result.error, null, result.error);
    assert.match(result.logs, /sandbox-verified/);
    for (const label of ["private-read", "private-write", "internet", "loopback", "child"]) assert.match(result.logs, new RegExp(`${label} denied`));
    assert.equal(fs.readFileSync(canary, "utf8"), "host-only-canary");
    assert.equal(sandboxProcesses(), "");
  } finally {
    delete process.env.MANA_ANALYSIS_CANARY_SECRET;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("live AppContainer returns PNGs, cleans scratch after completion and kills timed-out scripts", { skip: !live }, async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("Mana.Analysis."));
  const result = await runAnalysisSandbox({ code: `import base64\nfrom pathlib import Path\nPath(output_dir, 'chart.png').write_bytes(base64.b64decode('${PNG}'))\nprint(4)`, files: [] });
  assert.equal(result.error, null, result.error);
  assert.equal(result.charts.length, 1);
  const failed = await runAnalysisSandbox({ code: "raise ValueError('expected script failure')", files: [] });
  assert.match(failed.error, /expected script failure/);
  await assert.rejects(runAnalysisSandbox({ code: "while True: pass", files: [] }, { timeoutMs: 200 }), /timed out/);
  assert.equal(sandboxProcesses(), "");
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("Mana.Analysis.")), before);
});

test("live helper termination kills its Python process through the job", { skip: !live }, async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("Mana.Analysis."));
  let sawPython = false;
  await assert.rejects(runAnalysisSandbox({ code: "from pathlib import Path\nPath('started').write_text('ready')\nwhile True: pass", files: [] }, {
    runProcess: (command, args, options) => runProcess(command, args, { ...options, spawnImpl: (...spawnArgs) => {
      const child = spawn(...spawnArgs);
      if (args[0] !== "--cleanup") {
        const deadline = Date.now() + 15000;
        const timer = setInterval(() => {
          sawPython = fs.existsSync(path.join(args[1], 'started'));
          if (sawPython || Date.now() >= deadline) { clearInterval(timer); child.kill(); }
        }, 100);
        child.once('close', () => clearInterval(timer));
      }
      return child;
    } }),
  }), /sandbox failed/);
  assert.ok(sawPython, "Python must have started before termination");
  assert.equal(sandboxProcesses(), "");
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("Mana.Analysis.")), before);
});

test("live analysis calculates from CSV and renders a chart with the CPU-only backend", { skip: !live }, async () => {
  const code = "import pandas as pd\nimport matplotlib\nimport matplotlib.pyplot as plt\nfrom pathlib import Path\nx = pd.read_csv('data.csv')\nassert x.value.mean() == 2\nassert matplotlib.get_backend().lower() == 'agg'\nx.plot()\nplt.savefig(Path(output_dir) / 'chart.png')\ndisplay(x)\nx.to_csv(Path(output_dir) / 'results.csv', index=False)\nprint('mean=2; cpu-only chart')";
  const result = await runAnalysisSandbox({ code, files: [{ name: "data.csv", data: Buffer.from("value\n1\n2\n3\n").toString("base64") }] });
  assert.equal(result.error, null, result.error);
  assert.match(result.logs, /cpu-only chart/);
  assert.equal(result.charts.length, 1);
  assert.deepEqual(result.tables, [{ columns: ['value'], rows: [['1'], ['2'], ['3']] }]);
  assert.equal(Buffer.from(result.files.find(file => file.name === 'results.csv').data, 'base64').toString().replaceAll('\r', ''), 'value\n1\n2\n3\n');
  assert.equal(sandboxProcesses(), "");
});

test("live Python helper cleans up after backend termination", { skip: !live, timeout: 30000 }, async t => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-python-owner-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const controller = spawn(process.execPath, ['-e', `
    const sandbox = require(${JSON.stringify(require.resolve('../tools/analysis-sandbox'))});
    sandbox.runAnalysisSandbox({ code: 'while True: pass', files: [] }, {
      runProcess: (command, args, options) => {
        if (args[0] !== '--cleanup') console.log('work:' + args[1]);
        return sandbox.runProcess(command, args, options);
      },
    }).catch(error => console.error(error.message));
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => controller.kill());
  let output = '';
  controller.stdout.on('data', data => { output += data; });
  controller.stderr.on('data', data => { output += data; });
  let work;
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    work = /work:([^\r\n]+)/.exec(output)?.[1];
    if (work && sandboxProcesses()) break;
  }
  assert.ok(work, output);
  assert.notEqual(sandboxProcesses(), '', 'Python must start before its backend is killed');
  controller.kill();
  for (let i = 0; i < 100 && fs.existsSync(work); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(work), false, output);
  assert.equal(sandboxProcesses(), '');
});

test('live scratch monitoring tolerates files and directories removed during execution', { skip: !live }, async () => {
  const result = await runAnalysisSandbox({ code: "import tempfile, time\nfrom pathlib import Path\nend = time.monotonic() + 2\nwhile time.monotonic() < end:\n with tempfile.TemporaryDirectory(dir='.') as folder:\n  Path(folder, 'data').write_bytes(b'x' * 4096)\nprint('temporary files cleaned')", files: [] });
  assert.equal(result.error, null, result.error);
  assert.match(result.logs, /temporary files cleaned/);
  assert.equal(sandboxProcesses(), '');
});
