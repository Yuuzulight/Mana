// Build-time step (run before `electron-builder`, not at app runtime):
// downloads the official Windows embeddable Python distribution and
// pre-installs each bundled service's dependencies into its own copy, so
// packaged installers need no system Python at all -- see
// desktop-client/python-env.js for how the app finds these at runtime.
//
// Two separate copies (not one shared env) because SearXNG's dependency
// stack (flask/lxml/babel/...) and Kokoro's (fastapi/onnxruntime/...) can
// conflict on shared transitive deps; isolating them mirrors the
// per-service venvs tools/setup-searxng.ps1 and first-run-setup.js already
// build for dev/fallback use.
//
// Usage:
//   cd desktop-client
//   node scripts/prepare-portable-python.js
// Output: desktop-client/portable-python/{searxng,tts-service}/ (gitignored).
// Delete a target's folder to force a rebuild of just that one.
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PY_VERSION = '3.13.1';
const EMBED_URL = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

const ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(ROOT, '..');
const OUT_ROOT = path.join(ROOT, 'portable-python');

const TARGETS = {
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

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          file.close();
          fs.unlinkSync(dest);
          download(res.headers.location, dest, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`);
}

async function buildOne(name, cfg) {
  const dir = path.join(OUT_ROOT, name);
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

(async () => {
  for (const [name, cfg] of Object.entries(TARGETS)) {
    await buildOne(name, cfg);
  }
  console.log('Portable Python prep complete.');
})().catch((e) => {
  console.error('prepare-portable-python failed:', e);
  process.exit(1);
});
