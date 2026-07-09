const { spawnSync } = require('child_process');
const path = require('path');

function run(cmd, args, opts={}){
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) process.exit(r.status);
}

const skipHeavy = process.env.SKIP_HEAVY_MODEL_TESTS === '1' || process.env.SKIP_HEAVY_MODEL_TESTS === 'true';
if (skipHeavy){
  // Run only fast, focused tests
  const tests = [
    'node --test ' + path.join('node-bot','test','mobile-device-store.test.js'),
    'node --test ' + path.join('node-bot','test','e2e-pairing-smoke.test.js')
  ];
  for (const t of tests){
    console.log('Running fast test:', t);
    run(t.split(' ')[0], t.split(' ').slice(1));
  }
} else {
  // Run full test suite (fallback to node --test across node-bot test folder)
  run('node', ['--test', path.join('node-bot','test')]);
}
