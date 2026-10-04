const { parentPort, workerData } = require('node:worker_threads');
const { prepareTestExecution } = require('./native-execution');

parentPort.postMessage(prepareTestExecution(workerData.command, workerData.cwd, workerData.profile, {
  workspaceRoot: workerData.workspaceRoot,
  work: workerData.work,
  unrestricted: workerData.unrestricted,
  copySources: workerData.copySources,
}));
