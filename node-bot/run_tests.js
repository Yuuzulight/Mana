const { spawnSync } = require('child_process');
const path = require('path');

function run(cmd, args, opts={}){
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) process.exit(r.status);
}

const skipHeavy = process.env.SKIP_HEAVY_MODEL_TESTS === '1' || process.env.SKIP_HEAVY_MODEL_TESTS === 'true' || process.env.GITHUB_EVENT_NAME === 'pull_request' || (process.env.GITHUB_REF && process.env.GITHUB_REF.startsWith('refs/pull/'));
if (skipHeavy){
  // Run only fast, focused tests (paths resolved from current working directory)
  const tests = [
    ['node', ['--test', path.join(process.cwd(), 'test', 'mobile-device-store.test.js')]],
    ['node', ['--test', path.join(process.cwd(), 'test', 'e2e-pairing-smoke.test.js')]],
  ];
  for (const [cmd, args] of tests){
    console.log('Running fast test:', cmd, args.join(' '));
    run(cmd, args);
  }
} else {
  // Run full test suite (fallback to node --test across node-bot test folder)
  run('node', ['--test', path.join(process.cwd(), 'test')]);
}
