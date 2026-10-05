// Build-time step (run before `electron-builder`, not at app runtime):
// downloads the official Windows embeddable Python distribution and
// pre-installs each bundled service's dependencies into its own copy, so
// packaged installers need no system Python at all -- see
// desktop-client/python-env.js for how the app finds these at runtime.
//
// Separate copies (not one shared env) because SearXNG's dependency
// stack (flask/lxml/babel/...) and Kokoro's (fastapi/onnxruntime/...) can
// conflict on shared transitive deps; isolating them mirrors the
// per-service venvs tools/setup-searxng.ps1 and first-run-setup.js already
// build for dev/fallback use.
//
// Usage:
//   cd desktop-client
//   node scripts/prepare-portable-python.js
//   node scripts/prepare-portable-python.js --target analysis
// Output: desktop-client/portable-python/{analysis,searxng,tts-service}/ (gitignored).
// Delete a target's folder to force a rebuild of just that one.
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs } = require('node:util');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const PY_VERSION = '3.13.1';
const EMBED_URL = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

const ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(ROOT, '..');
const OUT_ROOT = path.join(ROOT, 'portable-python');

const TARGETS = {
  analysis: {
    requirements: path.join(REPO_ROOT, 'tools', 'analysis-sandbox', 'requirements.txt'),
    validate: "import numpy, pandas, matplotlib, openpyxl; assert (numpy.__version__, pandas.__version__, matplotlib.__version__, openpyxl.__version__) == ('2.1.3', '2.2.3', '3.9.2', '3.1.5')",
  },
  searxng: {
    requirements: path.join(REPO_ROOT, 'tools', 'searxng', 'requirements.txt'),
    windowsPwdStub: true,
    // The embeddable distro's ._pth file puts sys.path in "isolated" mode:
    // it stops auto-adding the invocation cwd (what `-m searx.webapp`
    // relies on to find the searx package in the source tree) and ignores
    // PYTHONPATH entirely. Point it at the source tree directly instead --
    // resources/portable-python/searxng/ and resources/tools/searxng/ are
    // fixed siblings-of-siblings in the packaged layout (see package.json
    // extraResources), so this relative path holds regardless of install
    // location.
    extraSysPathRelative: path.join('..', '..', 'tools', 'searxng'),
  },
  'tts-service': {
    requirements: path.join(REPO_ROOT, 'tts-service', 'requirements-packaged.txt'),
  },
};

// SearXNG's valkeydb.py imports the POSIX-only `pwd` module unconditionally
// at load time, only to format a username into a log line inside a
// Valkey-connection-failure handler Mana's config never triggers. Same
// stub first-run-setup.js writes into the dev venv.
const PWD_STUB = `"""Windows stub for the POSIX-only \`\`pwd\`\` module.

SearXNG's valkeydb.py imports \`\`pwd\`\` unconditionally at module load time.
Mana's local instance never configures Valkey, so that code path never
runs, but the bare import still crashes on Windows without this stub.
"""


def getpwuid(uid):
    raise KeyError(f"no pwd module on Windows (uid={uid})")
`;

async function download(url, dest, redirectsLeft = 5) {
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, resolve);
    request.setTimeout(60000, () => request.destroy(new Error('Portable Python download timed out')));
    request.on('error', reject);
  });
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirectsLeft > 0) {
    response.destroy();
    return download(new URL(response.headers.location, url), dest, redirectsLeft - 1);
  }
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error(`GET ${url} -> HTTP ${response.statusCode}`);
  }
  // pipeline waits for stream closure on failure before staging can be removed.
  await pipeline(response, fs.createWriteStream(dest));
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`);
}

async function buildOne(name, cfg) {
  const dir = path.join(OUT_ROOT, name);
  if (cfg.validate) {
    const python = path.join(dir, 'python.exe');
    if (fs.existsSync(python) && spawnSync(python, ['-I', '-c', cfg.validate], { windowsHide: true, stdio: 'ignore' }).status === 0) {
      console.log(`[${name}] verified dependencies, skipping`);
      return;
    }
    const stage = path.join(OUT_ROOT, `${name}.staging.${randomUUID()}`);
    const previous = path.join(OUT_ROOT, `${name}.previous.${randomUUID()}`);
    let backedUp = false;
    try {
      await buildAt(name, cfg, stage);
      run(path.join(stage, 'python.exe'), ['-I', '-c', cfg.validate]);
      if (fs.existsSync(dir)) {
        if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Refusing to replace a linked analysis bundle');
        fs.renameSync(dir, previous);
        backedUp = true;
      }
      try { fs.renameSync(stage, dir); }
      catch (error) {
        if (backedUp) fs.renameSync(previous, dir);
        backedUp = false;
        throw error;
      }
      if (backedUp) fs.rmSync(previous, { recursive: true });
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
    return;
  }
  await buildAt(name, cfg, dir);
}

async function buildAt(name, cfg, dir) {
  if (fs.existsSync(path.join(dir, 'python.exe'))) {
    console.log(`[${name}] already built, skipping (delete ${dir} to rebuild)`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });

  console.log(`[${name}] downloading embeddable Python ${PY_VERSION}...`);
  const zipPath = path.join(dir, '_embed.zip');
  await download(EMBED_URL, zipPath);
  run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${dir}' -Force`]);
  fs.unlinkSync(zipPath);

  // The embeddable distro ships with `import site` commented out in its
  // ._pth file, which (a) keeps it from seeing a site-packages dir at all
  // and (b) blocks pip from working. Also spell out Lib/site-packages
  // explicitly rather than relying on site.py to infer it.
  const pthFile = fs.readdirSync(dir).find((f) => f.endsWith('._pth'));
  const pthPath = path.join(dir, pthFile);
  let pth = fs.readFileSync(pthPath, 'utf8').replace('#import site', 'import site');
  if (!pth.includes('Lib\\site-packages')) pth += '\nLib\\site-packages\n';
  if (cfg.extraSysPathRelative) pth += `\n${cfg.extraSysPathRelative}\n`;
  fs.writeFileSync(pthPath, pth);

  console.log(`[${name}] bootstrapping pip...`);
  const getPipPath = path.join(dir, 'get-pip.py');
  await download(GET_PIP_URL, getPipPath);
  run(path.join(dir, 'python.exe'), [getPipPath, '--quiet', '--no-warn-script-location']);
  fs.unlinkSync(getPipPath);

  console.log(`[${name}] installing dependencies (this can take a few minutes)...`);
  run(path.join(dir, 'python.exe'), ['-m', 'pip', 'install', '--quiet', '-r', cfg.requirements]);

  if (cfg.windowsPwdStub) {
    const sitePackages = path.join(dir, 'Lib', 'site-packages');
    fs.writeFileSync(path.join(sitePackages, 'pwd.py'), PWD_STUB);
  }

  console.log(`[${name}] done -> ${dir}`);
}

async function main() {
  const { values } = parseArgs({ options: { target: { type: 'string', multiple: true } } });
  const targets = values.target || Object.keys(TARGETS);
  for (const name of targets) if (!Object.hasOwn(TARGETS, name)) throw new Error(`Unknown portable Python target: ${name}`);
  const helper = path.join(REPO_ROOT, 'tools', 'analysis-sandbox', 'Mana.AnalysisSandbox.csproj');
  if (process.platform === 'win32') run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO_ROOT, 'tools', 'analysis-sandbox', 'publish-helper.ps1')]);
  else run('dotnet', ['publish', helper, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', path.join(REPO_ROOT, 'tools', 'analysis-sandbox', 'bundle')]);
  for (const name of targets) {
    await buildOne(name, TARGETS[name]);
  }
  console.log('Portable Python prep complete.');
}

if (require.main === module) main().catch((e) => {
  console.error('prepare-portable-python failed:', e);
  process.exit(1);
});

module.exports = { download };
