// One-time setup for the optional services whose SOURCE ships in the
// installer (see extraResources in package.json) but whose Python venv
// isn't pre-built -- venvs aren't portable across machines (pyvenv.cfg
// hardcodes an absolute interpreter path), so instead of bundling a venv,
// this builds one locally on first launch, the same way
// tools/setup-searxng.ps1 and tts-service/start_kokoro.ps1 already do by
// hand. Kokoro's model files (tts-service/kokoro/*.onnx/*.bin) ARE bundled
// as-is (plain data files, fully portable), so "use the suggested/included
// voice" needs no download -- only the venv has to be built.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolvePythonEnv, fileExists } = require('./python-env');

function findPython() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
  ];
  return candidates.find(fileExists) || 'python';
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, options);
    } catch (e) {
      reject(e);
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

const PWD_STUB = `"""Windows stub for the POSIX-only \`\`pwd\`\` module.

SearXNG's valkeydb.py imports \`\`pwd\`\` unconditionally at module load time.
Mana's local instance never configures Valkey, so that code path never
runs, but the bare import still crashes on Windows without this stub.
"""


def getpwuid(uid):
    raise KeyError(f"no pwd module on Windows (uid={uid})")
`;

function createFirstRunSetup({ manaRoot, onProgress = () => {}, log = console }) {
  function emit(id, status, message) {
    onProgress({ id, status, message });
  }

  function needsSetup() {
    const searxngDir = path.join(manaRoot, 'tools', 'searxng');
    const ttsDir = path.join(manaRoot, 'tts-service');
    return {
      // A portable-python build (see scripts/prepare-portable-python.js)
      // already has a working env with nothing further to install --
      // covered installers never hit the dialog or the venv-build path
      // below at all.
      searxng:
        fileExists(path.join(searxngDir, 'requirements.txt')) &&
        !resolvePythonEnv(manaRoot, 'searxng', path.join('tools', 'searxng')),
      kokoro:
        fileExists(path.join(ttsDir, 'requirements-packaged.txt')) &&
        !resolvePythonEnv(manaRoot, 'tts-service', 'tts-service'),
    };
  }

  async function setupSearxng() {
    const dir = path.join(manaRoot, 'tools', 'searxng');
    emit('searxng', 'starting', 'Installing web search (first launch, this can take a minute)...');
    try {
      const python = findPython();
      await run(python, ['-m', 'venv', path.join(dir, 'venv')], { cwd: dir });
      const venvPython = path.join(dir, 'venv', 'Scripts', 'python.exe');
      await run(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
      await run(venvPython, ['-m', 'pip', 'install', '--quiet', '-r', path.join(dir, 'requirements.txt')]);

      const sitePackages = await new Promise((resolve, reject) => {
        const child = spawn(venvPython, ['-c', 'import site; print(site.getsitepackages()[0])']);
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('could not resolve site-packages'))));
      });
      fs.writeFileSync(path.join(sitePackages, 'pwd.py'), PWD_STUB);

      const settingsSrc = path.join(manaRoot, 'tools', 'mana-searxng-settings.yml');
      if (fileExists(settingsSrc)) fs.copyFileSync(settingsSrc, path.join(dir, 'mana-settings.yml'));

      emit('searxng', 'starting', 'Installed. Starting...');
      log.log('[first-run-setup] SearXNG installed.');
    } catch (e) {
      emit('searxng', 'failed', `Setup failed: ${e.message}`);
      log.error('[first-run-setup] SearXNG setup failed:', e);
    }
  }

  async function setupKokoro() {
    const dir = path.join(manaRoot, 'tts-service');
    emit('kokoro', 'starting', 'Installing voice (first launch, this can take a minute)...');
    try {
      const python = findPython();
      await run(python, ['-m', 'venv', path.join(dir, 'venv')], { cwd: dir });
      const venvPython = path.join(dir, 'venv', 'Scripts', 'python.exe');
      await run(venvPython, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
      await run(venvPython, ['-m', 'pip', 'install', '--quiet', '-r', path.join(dir, 'requirements-packaged.txt')]);

      emit('kokoro', 'starting', 'Installed. Starting...');
      log.log('[first-run-setup] Kokoro installed.');
    } catch (e) {
      emit('kokoro', 'failed', `Setup failed: ${e.message}`);
      log.error('[first-run-setup] Kokoro setup failed:', e);
    }
  }

  return { needsSetup, setupSearxng, setupKokoro };
}

module.exports = { createFirstRunSetup };
