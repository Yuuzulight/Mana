// Resolves which Python interpreter to run a bundled service (SearXNG,
// Kokoro) with. Two possible sources, checked in order:
//  1. portable-python/<service>/ -- a self-contained embeddable Python
//     with that service's dependencies pre-installed at build time (see
//     scripts/prepare-portable-python.js). Present in installers built
//     with that step; needs nothing from the end user's machine.
//  2. <venvParentRelPath>/venv/ -- a venv built against whatever system
//     Python was found, either by hand (tools/setup-searxng.ps1,
//     tts-service/start_kokoro.ps1) or by first-run-setup.js on first
//     launch. This is what keeps working in dev (`npm start`) and in any
//     installer built without the portable-python step.
// The two have different internal layouts: a venv's Scripts/ holds both
// python.exe and pip-installed console scripts (uvicorn.exe); the
// embeddable distro's console scripts land in Scripts/ but its python.exe
// sits at the package root, one level up.
const fs = require('fs');
const path = require('path');

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}

function resolvePythonEnv(manaRoot, service, venvParentRelPath) {
  const portableDir = path.join(manaRoot, 'portable-python', service);
  const portablePython = path.join(portableDir, 'python.exe');
  if (fileExists(portablePython)) {
    return { pythonExe: portablePython, uvicornExe: path.join(portableDir, 'Scripts', 'uvicorn.exe') };
  }
  const venvScripts = path.join(manaRoot, venvParentRelPath, 'venv', 'Scripts');
  const venvPython = path.join(venvScripts, 'python.exe');
  if (fileExists(venvPython)) {
    return { pythonExe: venvPython, uvicornExe: path.join(venvScripts, 'uvicorn.exe') };
  }
  return null;
}

module.exports = { resolvePythonEnv, fileExists };
