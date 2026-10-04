const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

// Publishing and process launch share a short filesystem gate. The publisher
// holds it while waiting for active helpers, so new scripts queue rather than
// loading a partially replaced runtime.
function spawnNativeHelper(executable, args, options) {
  if (process.platform !== 'win32') return spawn(executable, args, options);
  const gate = path.join(path.dirname(path.dirname(executable)), 'helper-launch.lock');
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined });
  let actual;
  let recovery;
  let timer;
  let closed = false;
  let cancelled = false;
  const close = (code, signal) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    child.stdin.destroy(); child.stdout.end(); child.stderr.end();
    child.emit('close', code, signal);
  };
  child.kill = () => {
    if (actual) return actual.kill();
    recovery?.kill();
    cancelled = true;
    clearTimeout(timer);
    queueMicrotask(() => close(null, 'SIGTERM'));
    return true;
  };
  const start = () => {
    if (closed || cancelled) return;
    let acquired = false;
    try {
      try { fs.mkdirSync(gate); acquired = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const ownerText = fs.readFileSync(path.join(gate, 'owner'), 'utf8').trim();
          if (!ownerText) { timer = setTimeout(start, 100); return; }
          const owner = Number(ownerText);
          if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('Invalid helper launch gate');
          try { process.kill(owner, 0); }
          catch (dead) {
            if (dead.code !== 'ESRCH') throw dead;
            // Recovery is serialized with publishers; readers never delete
            // a stale gate that another reader might already have replaced.
            recovery = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(path.dirname(gate), 'publish-helper.ps1'), '-RecoverGateOnly'], { windowsHide: true, stdio: 'ignore' });
            recovery.on('error', error => { child.emit('error', error); close(1); });
            recovery.on('close', code => {
              recovery = undefined;
              if (closed || cancelled) return;
              if (code !== 0) { child.emit('error', new Error('Native helper launch gate recovery failed')); close(1); }
              else start();
            });
            return;
          }
        } catch (read) { if (read.code !== 'ENOENT') throw read; }
        timer = setTimeout(start, 100);
        return;
      }
      fs.writeFileSync(path.join(gate, 'owner'), String(process.pid));
      actual = spawn(executable, args, options);
      child.pid = actual.pid;
      child.stdin.pipe(actual.stdin);
      actual.stdout.pipe(child.stdout); actual.stderr.pipe(child.stderr);
      actual.stdin.on('error', error => child.emit('error', error));
      actual.on('error', error => child.emit('error', error));
      actual.on('close', close);
    } catch (error) {
      child.emit('error', error);
      close(1);
    } finally {
      if (acquired) {
        fs.rmSync(path.join(gate, 'owner'), { force: true });
        fs.rmdirSync(gate);
      }
    }
  };
  setImmediate(start);
  return child;
}

module.exports = { spawnNativeHelper };
