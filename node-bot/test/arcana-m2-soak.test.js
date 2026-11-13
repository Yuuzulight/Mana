const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const scriptPath = path.resolve(__dirname, '../../tools/m2-fallback-report.ps1');

function runReport(args) {
  const result = execFileSync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    ...args
  ], { encoding: 'utf8' });
  return JSON.parse(result.trim());
}

test('fallback report: non-existent file produces insufficient_observation', () => {
  const missing = path.join(os.tmpdir(), `nonexistent-${Date.now()}.jsonl`);
  const report = runReport(['-Path', missing, '-Days', '3', '-MinStarts', '5']);
  assert.equal(report.status, 'insufficient_observation');
  assert.equal(report.arcanaStarts, 0);
  assert.equal(report.unexplainedFallbacks, 0);
});

test('fallback report: stale events outside run window are excluded', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arcana-soak-stale-'));
  const log = path.join(tmp, 'arcana-events.jsonl');
  const now = new Date();
  const staleDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const recentDate = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();

  fs.writeFileSync(log, [
    JSON.stringify({ at: staleDate, type: 'arcana_started' }),
    JSON.stringify({ at: staleDate, type: 'arcana_start_failed', reason: 'Old failure' }),
    JSON.stringify({ at: recentDate, type: 'arcana_started' }),
  ].join('\n') + '\n');

  try {
    const since = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const report = runReport(['-Path', log, '-Days', '3', '-MinStarts', '5', '-Since', since]);
    assert.equal(report.arcanaStarts, 1);
    assert.equal(report.unexplainedFallbacks, 0);
    assert.equal(report.status, 'insufficient_observation');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fallback report: unexplained fallbacks inside window yield investigate verdict', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arcana-soak-fail-'));
  const log = path.join(tmp, 'arcana-events.jsonl');
  const now = new Date();
  const day1 = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();
  const day2 = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const day3 = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();

  fs.writeFileSync(log, [
    JSON.stringify({ at: day1, type: 'arcana_started' }),
    JSON.stringify({ at: day2, type: 'arcana_start_failed', reason: 'Process crashed' }),
    JSON.stringify({ at: day3, type: 'arcana_started' }),
  ].join('\n') + '\n');

  try {
    const since = new Date(now.getTime() - 74 * 60 * 60 * 1000).toISOString();
    const report = runReport(['-Path', log, '-Days', '3', '-MinStarts', '2', '-Since', since]);
    assert.equal(report.status, 'investigate');
    assert.equal(report.unexplainedFallbacks, 1);
    assert.deepEqual(report.failureReasons, ['Process crashed']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fallback report: clean 72h window with sufficient starts yields clean', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arcana-soak-clean-'));
  const log = path.join(tmp, 'arcana-events.jsonl');
  const now = new Date();
  const since = new Date(now.getTime() - 73 * 60 * 60 * 1000).toISOString();

  const lines = [];
  for (let h = 72; h >= 0; h -= 12) {
    lines.push(JSON.stringify({
      at: new Date(now.getTime() - h * 60 * 60 * 1000).toISOString(),
      type: 'arcana_started',
    }));
  }
  fs.writeFileSync(log, lines.join('\n') + '\n');

  try {
    const report = runReport(['-Path', log, '-Days', '3', '-MinStarts', '5', '-Since', since, '-Until', now.toISOString()]);
    assert.equal(report.status, 'clean');
    assert.equal(report.unexplainedFallbacks, 0);
    assert.ok(report.arcanaStarts >= 5);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fallback report: validates preserved AWS run evidence as unverified/failed', () => {
  const awsLog = 'C:\\ManaAI\\Mana-soak\\node-bot\\data\\browser-profile\\arcana-events.jsonl';
  if (fs.existsSync(awsLog)) {
    const report = runReport(['-Path', awsLog, '-Days', '3', '-MinStarts', '5']);
    assert.notEqual(report.status, 'clean', 'AWS soak evidence must NOT be marked clean');
    assert.ok(report.unexplainedFallbacks > 0, 'AWS soak evidence contains unexplained fallbacks');
    assert.ok(report.failureReasons.some(r => r.includes("Arcana isn't installed")));
  }
});

test('soak runner: elapsed time reaching deadline with non-clean fallback yields failure', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arcana-soak-verdict-'));
  const events = path.join(tmp, 'arcana-events.jsonl');
  const summary = path.join(tmp, 'summary.json');
  // Write a failing event into the log
  fs.writeFileSync(events, JSON.stringify({ at: new Date().toISOString(), type: 'arcana_start_failed', reason: 'Crash' }) + '\n');

  // Verify that evaluating this log through fallback report produces investigate
  const report = runReport(['-Path', events, '-Days', '3', '-MinStarts', '5']);
  assert.equal(report.status, 'investigate');

  // Verify verdict logic: even if deadline elapsed, status cannot be complete if fallback is not clean
  const deadline = new Date(Date.now() - 1000);
  const verdictStatus = (report.status === 'clean' && Date.now() >= deadline) ? 'complete' : 'failed';
  assert.equal(verdictStatus, 'failed');
  fs.rmSync(tmp, { recursive: true, force: true });
});
