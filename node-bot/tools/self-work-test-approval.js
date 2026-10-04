const { randomUUID } = require('node:crypto');
const { recommendTestProfile } = require('./test-resource-profile');

const registries = new WeakMap();
function registry(gate) {
  if (registries.has(gate)) return registries.get(gate);
  const requests = new Map();
  gate.registerExecutor('self-work-sandbox-tests', async ({ nonce }) => {
    const entry = requests.get(nonce);
    if (!entry || entry.cancelled()) throw new Error('This self-work test approval expired or was stopped');
    entry.started = true;
    requests.delete(nonce);
    try {
      const result = await entry.run();
      entry.resolve(result);
      return result;
    } catch (error) { entry.reject(error); throw error; }
  });
  registries.set(gate, requests);
  return requests;
}

async function approveSelfWorkTests({ gate, command, cwd, estimate, unrestricted = false, copySources, cancelled, run, onWaiting }) {
  if (!gate) throw new Error('Self-work tests require the approval gate');
  const recommendation = recommendTestProfile({ command, estimate });
  if (recommendation.exceedsAvailableProfiles) throw new Error('Estimated tests exceed both resource profiles; ask the user before proceeding');
  const requests = registry(gate);
  if (requests.size >= 16) throw new Error('Too many pending test approvals');
  const nonce = randomUUID();
  let resolve, reject;
  const completed = new Promise((yes, no) => { resolve = yes; reject = no; });
  completed.catch(() => {});
  const entry = { started: false, cancelled, resolve, reject, run: () => run(recommendation) };
  requests.set(nonce, entry);
  let poll;
  let expired;
  try {
    const decision = await gate.requestApproval('self-work-sandbox-tests', {
      forceReview: true,
      summary: `${unrestricted ? 'UNRESTRICTED self-work rerun: host files and network accessible' : 'Sandboxed self-work tests'}: ${command}; recommend ${recommendation.minutes} minutes, ${recommendation.memoryMb} MB, ${recommendation.processes} processes: ${recommendation.reason}`,
      payload: { nonce, command, cwd, recommendation, unrestricted },
      details: { command, cwd, recommendation, copySources, execution: unrestricted ? 'UNRESTRICTED: host files and network accessible; disposable workspace, fixed Job Object limits, cleanup' : 'Windows AppContainer; disposable workspace and copied dependencies' },
      scanText: command,
    });
    if (decision.status === 'approved') return decision.result;
    if (decision.status !== 'pending') throw new Error(`Self-work test execution was not approved: ${decision.reason || decision.status}`);
    onWaiting?.(recommendation);
    poll = setInterval(() => {
      if (entry.started) return;
      if (cancelled()) reject(new Error('Self-work test approval was cancelled'));
      else if (requests.has(nonce) && !gate.listPending().some(item => item.id === decision.requestId)) reject(new Error('Self-work tests were denied'));
    }, 250);
    expired = setTimeout(() => { if (!entry.started) reject(new Error('Self-work test approval expired; request a new approval')); }, 30 * 60000);
    return await completed;
  } finally {
    clearInterval(poll);
    clearTimeout(expired);
    requests.delete(nonce);
  }
}

module.exports = { approveSelfWorkTests };
