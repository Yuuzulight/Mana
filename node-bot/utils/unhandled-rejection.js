// Node exits on an unhandled promise rejection, and with Express 4 any
// async route that throws outside a try/catch is one -- a single bad
// request took the whole backend (and Mana) down. Log it and keep running.
// An uncaught synchronous exception still exits (Node's default, with its
// stack in the log), and the launcher restarts node-bot then.
function keepRunningOnUnhandledRejection(proc = process, log = console.error) {
  proc.on("unhandledRejection", (reason) => {
    log("[Mana] Unhandled promise rejection (kept running):", reason?.stack || reason);
  });
}

module.exports = { keepRunningOnUnhandledRejection };
