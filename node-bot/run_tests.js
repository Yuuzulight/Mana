const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Make sure every test child process knows it runs in a test environment,
// so server.js never boots background jobs or spawns real model processes.
process.env.NODE_ENV = 'test';

// Tests never touch the real memory in node-bot/data/acp-memory: server.js
// builds its store (and the graph/search databases) at require time, so a
// test that doesn't pick its own dir would otherwise write fixture sessions
// into the user's real memory. Every child process inherits this.
const testMemoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mana-test-acp-memory-'));
process.env.MANA_ACP_MEMORY_DIR = testMemoryDir;
process.on('exit', () => {
  try {
    fs.rmSync(testMemoryDir, { recursive: true, force: true });
  } catch (e) {}
});

// Run below-normal priority so tests do not starve whatever else the user is
// doing. On Windows, child processes inherit the below-normal priority class.
try {
  os.setPriority(0, 10);
} catch (e) {}

const testDir = path.join(process.cwd(), 'test');

function run(cmd, args, opts={}){
  // shell:false: `node` is invoked directly with no shell features needed,
  // and shell:true's Windows argument quoting corrupts any path containing
  // a space (e.g. mangles "C:\GitHub Projects\..." into "C:\GitHub, Projects\...").
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  if (r.status !== 0) process.exit(r.status);
}

// Issue #361: the reduced run is opt-in via this env var and nothing else.
//
// It used to also trigger on GITHUB_EVENT_NAME === 'pull_request' (and a
// refs/pull/ GITHUB_REF), which made it involuntary: every pull request
// silently ran two files out of ~94 regardless of what the workflow asked
// for. No workflow sets it any more: every pull request runs the whole
// suite (fast-node-tests.yml), and so does a main push (heavy-ci.yml).
//
// Measured before this change: a labelled PR's "Heavy Node tests" finished
// in 13s (the two-file path) while the same job on a main push took 44s.
// Two regressions reached main that way, each caught the moment the full
// suite was allowed to run.
const skipHeavy =
  process.env.SKIP_HEAVY_MODEL_TESTS === '1' ||
  process.env.SKIP_HEAVY_MODEL_TESTS === 'true';
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
