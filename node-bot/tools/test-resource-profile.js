const PROFILES = Object.freeze({
  standard: Object.freeze({ id: 'standard', minutes: 15, memoryMb: 2048, processes: 32, timeoutMs: 900000 }),
  large: Object.freeze({ id: 'large', minutes: 30, memoryMb: 4096, processes: 64, timeoutMs: 1800000 }),
});

function recommendTestProfile({ command, estimate = {}, measured = null } = {}) {
  const values = {};
  for (const key of ['minutes', 'memoryMb', 'processes']) {
    const value = estimate[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`Invalid test estimate: ${key}`);
    values[key] = Math.max(value || 0, Number(measured?.[key]) || 0);
  }
  const exceeds = profile => ['minutes', 'memoryMb', 'processes'].some(key => values[key] > profile[key]);
  const heavy = /\b(?:dotnet|playwright|cypress|selenium)\b|\b(?:run_tests\.js|test:all|test:e2e|test:integration)\b/i.test(String(command));
  const profile = exceeds(PROFILES.standard) || (heavy && !Object.values(values).some(Boolean)) ? PROFILES.large : PROFILES.standard;
  const reason = typeof estimate.reason === 'string' ? estimate.reason.trim().slice(0, 1000) : '';
  return {
    ...profile,
    estimate: values,
    reason: reason || (heavy ? 'Build, full-suite or browser workload; no measured resource requirements supplied.' : 'Focused or ordinary test workload; no measured resource requirements supplied.'),
    uncertainty: Object.values(values).some(Boolean) ? 'Estimates are not guarantees; the approved limits remain fixed.' : 'No measurements yet; this is a workload-based recommendation.',
    exceedsAvailableProfiles: exceeds(PROFILES.large),
  };
}

function testProfile(id) {
  if (!Object.hasOwn(PROFILES, id)) throw new Error('Unknown test resource profile');
  const profile = PROFILES[id];
  if (!profile) throw new Error('Unknown test resource profile');
  return profile;
}

module.exports = { PROFILES, recommendTestProfile, testProfile };
