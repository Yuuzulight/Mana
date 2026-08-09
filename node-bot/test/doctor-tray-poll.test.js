const assert = require("node:assert/strict");
const test = require("node:test");

const {
  computeDoctorTrayTransitions,
  createDoctorTrayPoller,
} = require("../doctor-tray-poll");

test("computeDoctorTrayTransitions: a fresh pass check produces no notification", () => {
  const { notifications, nextStatusById } = computeDoctorTrayTransitions(
    new Map(),
    [{ id: "a", status: "pass", label: "A", message: "ok" }],
  );
  assert.deepEqual(notifications, []);
  assert.equal(nextStatusById.get("a"), "pass");
});

test("computeDoctorTrayTransitions: pass -> warn produces a notification", () => {
  const previous = new Map([["a", "pass"]]);
  const check = { id: "a", status: "warn", label: "A", message: "uh oh" };
  const { notifications } = computeDoctorTrayTransitions(previous, [check]);
  assert.deepEqual(notifications, [check]);
});

test("computeDoctorTrayTransitions: a still-warn check does not renotify on the next poll", () => {
  const check = { id: "a", status: "warn", label: "A", message: "uh oh" };
  const first = computeDoctorTrayTransitions(new Map(), [check]);
  assert.equal(first.notifications.length, 1);
  const second = computeDoctorTrayTransitions(first.nextStatusById, [check]);
  assert.deepEqual(second.notifications, []);
});

test("computeDoctorTrayTransitions: recovering then failing again renotifies", () => {
  const warn = { id: "a", status: "warn", label: "A", message: "uh oh" };
  const pass = { id: "a", status: "pass", label: "A", message: "ok" };
  let state = computeDoctorTrayTransitions(new Map(), [warn]).nextStatusById;
  state = computeDoctorTrayTransitions(state, [pass]).nextStatusById;
  const { notifications } = computeDoctorTrayTransitions(state, [warn]);
  assert.deepEqual(notifications, [warn]);
});

test("computeDoctorTrayTransitions: fail also notifies", () => {
  const check = { id: "a", status: "fail", label: "A", message: "broken" };
  const { notifications } = computeDoctorTrayTransitions(new Map(), [check]);
  assert.deepEqual(notifications, [check]);
});

test("pollOnce calls notifyTray once per fresh problem, with the right payload shape", async () => {
  const notified = [];
  const poller = createDoctorTrayPoller({
    doctor: async () => ({
      checks: [
        { id: "a", status: "warn", label: "Vector index", message: "keyword-only" },
        { id: "b", status: "pass", label: "Whisper", message: "configured" },
      ],
    }),
    notifyTray: async (payload) => notified.push(payload),
  });

  const notifications = await poller.pollOnce();
  assert.equal(notifications.length, 1);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "doctor");
  assert.match(notified[0].title, /warning/i);
  assert.equal(notified[0].text, "Vector index: keyword-only");
});

test("pollOnce does not renotify on the second poll when nothing changed", async () => {
  const notified = [];
  const poller = createDoctorTrayPoller({
    doctor: async () => ({
      checks: [{ id: "a", status: "fail", label: "Llama binary", message: "missing" }],
    }),
    notifyTray: async (payload) => notified.push(payload),
  });

  await poller.pollOnce();
  await poller.pollOnce();
  assert.equal(notified.length, 1);
  assert.match(notified[0].title, /problem detected/i);
});

test("pollOnce passes doctorOptions() through to doctor()", async () => {
  let receivedOptions = null;
  const poller = createDoctorTrayPoller({
    doctor: async (options) => {
      receivedOptions = options;
      return { checks: [] };
    },
    notifyTray: async () => {},
    doctorOptions: () => ({ fishTtsWarmup: "warm" }),
  });
  await poller.pollOnce();
  assert.deepEqual(receivedOptions, { fishTtsWarmup: "warm" });
});
