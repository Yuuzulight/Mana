// Persistent log file for events the in-memory renderer log panel can't
// cover -- most importantly shutdown: by the time shutdown runs, the
// window showing that panel is about to be destroyed, so "keep it in the
// logs" has to mean a real file, not just an IPC message to a dying
// renderer. Also backs the existing (previously dead -- it pointed at a
// node-bot log file nothing ever wrote) "View Logs" button.
const fs = require('fs');
const path = require('path');

// ponytail: flat-file cap instead of real rotation -- truncate to the tail
// once it crosses this size, on the next process that opens it. Fine for a
// desktop app's own lifecycle log; revisit if this ever needs multi-file
// history.
const MAX_BYTES = 2 * 1024 * 1024;

function createLogFile(userDataDir) {
  const dir = path.join(userDataDir, 'logs');
  const filePath = path.join(dir, 'mana.log');

  function ensureReady() {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_BYTES) {
        const tail = fs.readFileSync(filePath, 'utf8').slice(-MAX_BYTES / 2);
        fs.writeFileSync(filePath, `[log truncated]\n${tail}`);
      }
    } catch (e) {
      // no existing file yet -- fine
    }
  }

  function append(line) {
    try {
      ensureReady();
      const stamped = `${new Date().toISOString()} ${line}`.replace(/\n+$/, '');
      fs.appendFileSync(filePath, stamped + '\n');
    } catch (e) {
      console.error('Failed to write to log file:', e);
    }
  }

  return { append, filePath };
}

module.exports = { createLogFile };
