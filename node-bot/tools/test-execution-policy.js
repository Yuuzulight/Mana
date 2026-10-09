function createTestExecutionPolicy() {
  const failures = new Map();
  const key = (command, cwd, root) => JSON.stringify([command, cwd, root]);
  return {
    unrestricted(command, cwd, root, execution = 'sandbox') {
      if (!['sandbox', 'unrestricted'].includes(execution)) throw new Error('Unknown test execution mode');
      if (execution === 'unrestricted' && !failures.has(key(command, cwd, root))) {
        throw new Error('An unrestricted rerun requires a previous sandbox failure for this exact command and workspace');
      }
      return execution === 'unrestricted';
    },
    record(command, cwd, root, result) {
      const id = key(command, cwd, root);
      failures.delete(id);
      if (result.exitCode !== 0 || result.timedOut) failures.set(id, true);
      while (failures.size > 64) failures.delete(failures.keys().next().value);
    },
  };
}

module.exports = { createTestExecutionPolicy };
