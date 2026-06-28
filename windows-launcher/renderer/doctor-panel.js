function normalizeDoctorStatus(status) {
  return ["pass", "warn", "fail"].includes(status) ? status : "warn";
}

function statusClassForDoctorCheck(check = {}) {
  const status = normalizeDoctorStatus(check.status);
  return `doctor-check doctor-check-${status}`;
}

function formatDoctorPanel(result = {}) {
  const summary = result.summary || {};
  const pass = Number(summary.pass || 0);
  const warn = Number(summary.warn || 0);
  const fail = Number(summary.fail || 0);
  const checks = Array.isArray(result.checks) ? result.checks : [];

  return {
    heading: result.ok ? "Doctor: ready" : "Doctor: attention needed",
    summary: `${pass} pass, ${warn} warn, ${fail} fail`,
    rows: checks.map((check) => ({
      id: check.id || "",
      label: check.label || check.id || "Check",
      status: normalizeDoctorStatus(check.status),
      message: check.message || "",
      className: statusClassForDoctorCheck(check),
    })),
  };
}

module.exports = {
  formatDoctorPanel,
  statusClassForDoctorCheck,
};
