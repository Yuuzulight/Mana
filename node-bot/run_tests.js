const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Make sure every test child process knows it runs in a test environment,
// so server.js never boots background jobs or spawns real model processes.
process.env.NODE_ENV = 'test';

// Run below-normal priority so tests do not starve whatever else the user is
// doing. On Windows, child processes inherit the below-normal priority class.
try {
  os.setPriority(0, 10);
} catch (e) {}

const testDir = path.join(process.cwd(), 'test');

function run(cmd, args, opts={}){
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) process.exit(r.status);
}

const skipHeavy = process.env.SKIP_HEAVY_MODEL_TESTS === '1' || process.env.SKIP_HEAVY_MODEL_TESTS === 'true' || process.env.GITHUB_EVENT_NAME === 'pull_request' || (process.env.GITHUB_REF && process.env.GITHUB_REF.startsWith('refs/pull/'));
if (skipHeavy){
  // Run only fast, focused tests (paths resolved from current working directory)
  const tests = [
    ['node', ['--test', path.join(testDir, 'mobile-device-store.test.js')]],
    ['node', ['--test', path.join(testDir, 'e2e-pairing-smoke.test.js')]],
  ];
  for (const [cmd, args] of tests){
    console.log('Running fast test:', cmd, args.join(' '));
    run(cmd, args);
  }
} else {
  // Run test files one at a time instead of one-per-CPU-core. Peak RAM stays
  // at a single node process and the machine stays responsive; total wall
  // time is longer, but the suite is meant to run in the background.
  const files = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
  console.log(`Running ${files.length} test files sequentially`);
  const startedAt = Date.now();
  for (const f of files) {
    const fileStartedAt = Date.now();
    run('node', ['--test', path.join(testDir, f)]);
    console.log(`--- ${f} finished in ${Date.now() - fileStartedAt}ms`);
  }
  console.log(`All test files passed in ${Date.now() - startedAt}ms`);
}
