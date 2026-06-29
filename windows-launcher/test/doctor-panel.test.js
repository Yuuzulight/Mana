const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatDoctorPanel,
  statusClassForDoctorCheck,
} = require("../renderer/doctor-panel");

test("formatDoctorPanel summarizes doctor checks for the launcher", () => {
  const panel = formatDoctorPanel({
    ok: false,
    generatedAt: "2026-06-28T00:00:00.000Z",
    summary: { pass: 2, warn: 1, fail: 1 },
    checks: [
      {
        id: "node-runtime",
        label: "Node runtime",
        status: "pass",
        message: "Node is available.",
      },
      {
        id: "ports",
        label: "Ports",
        status: "warn",
        message: "1 configured port is unavailable.",
      },
      {
        id: "llama-model",
        label: "Llama model",
        status: "fail",
        message: "Llama model not found.",
      },
    ],
  });

  assert.equal(panel.heading, "Doctor: attention needed");
  assert.equal(panel.summary, "2 pass, 1 warn, 1 fail");
  assert.deepEqual(panel.rows, [
    {
      id: "node-runtime",
      label: "Node runtime",
      status: "pass",
      message: "Node is available.",
      className: "doctor-check doctor-check-pass",
    },
    {
      id: "ports",
      label: "Ports",
      status: "warn",
      message: "1 configured port is unavailable.",
      className: "doctor-check doctor-check-warn",
    },
    {
      id: "llama-model",
      label: "Llama model",
      status: "fail",
      message: "Llama model not found.",
      className: "doctor-check doctor-check-fail",
    },
  ]);
});

test("statusClassForDoctorCheck falls back to warn for unknown status", () => {
  assert.equal(
    statusClassForDoctorCheck({ status: "unexpected" }),
    "doctor-check doctor-check-warn",
  );
});
