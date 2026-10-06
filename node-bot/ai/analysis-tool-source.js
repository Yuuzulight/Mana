const fs = require("node:fs");
const path = require("node:path");
const { runAnalysisSandbox, isAnalysisAvailable, MAX_INPUT_BYTES, MAX_CODE_CHARS } = require("../tools/analysis-sandbox");
const { isPrivateSandboxFile } = require('../tools/native-execution');
const { pathsIn } = require("../../plugins/browser-automation");
const { wrapUntrusted } = require("./untrusted-content");

const TOOL_NAME = "analysis__run_python";
const SCHEMA = {
  type: "function",
  function: {
    name: TOOL_NAME,
    description: "Run Python with pandas, matplotlib and openpyxl in a native Windows AppContainer for analysis or a scratch reproduction. Only user-offered files and explicitly approved attachments are copied into scratch. Call display(dataframe) for a table preview (20 rows, 8 columns). Save PNG charts and downloadable files under output_dir (256KB each, about 1MB total). Charts, tables and files are retained with the chat; scratch and processes are cleaned after every run. Private host files, network and child processes are restricted by Windows. Never use this to run workspace tests that need host access.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python code. Input files are in the current directory, output_dir contains chart outputs." },
        files: { type: "array", maxItems: 8, items: { type: "string" }, description: "Full paths explicitly named by the user or listed as approved Python analysis inputs for this turn." },
      },
      required: ["code"],
    },
  },
};

function createAnalysisToolSource(options = {}) {
  const env = options.env || process.env;
  const enabled = env.MANA_ANALYSIS_ENABLED === "1" || (env.MANA_ANALYSIS_ENABLED !== "0" && isAnalysisAvailable(env));
  const allowed = new Set(pathsIn(options.userMessage || "").map((file) => path.resolve(file)));
  const approved = new Map((options.approvedFiles || []).filter(file => typeof file?.path === 'string' && Buffer.isBuffer(file.buffer))
    .map(file => [path.resolve(file.path), file]));
  const run = options.runSandbox || runAnalysisSandbox;
  return {
    listToolSchemas: () => enabled ? [SCHEMA] : [],
    isKnownToolName: (name) => enabled && name === TOOL_NAME,
    executeTool: async (name, args = {}) => {
      if (!enabled || name !== TOOL_NAME) throw new Error(`unknown analysis tool: ${name}`);
      try {
        if (typeof args.code !== 'string' || !args.code.trim() || args.code.length > MAX_CODE_CHARS) throw new Error(`code must contain 1 to ${MAX_CODE_CHARS} characters`);
        const requested = args.files || [];
        if (!Array.isArray(requested) || requested.length > 8) throw new Error("files must be an array of up to eight paths");
        const names = new Set();
        let total = 0;
        const files = requested.map((file) => {
          if (typeof file !== "string" || (!allowed.has(path.resolve(file)) && !approved.has(path.resolve(file)))) throw new Error("input files must be explicitly named in the user's current message or approved attachments");
          const attachment = approved.get(path.resolve(file));
          const real = attachment ? attachment.path : fs.realpathSync(file);
          const name = path.basename(real);
          if (isPrivateSandboxFile(path.basename(file)) || isPrivateSandboxFile(name)) throw new Error("refusing to read a credential file");
          if (!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$/.test(name) || ['output', 'worker.py', 'request.json', 'result.json'].includes(name.toLowerCase())) throw new Error("unsupported input filename");
          if (names.has(name.toLowerCase())) throw new Error("input filenames must be unique");
          names.add(name.toLowerCase());
          if (attachment) {
            total += attachment.buffer.length;
            if (total > MAX_INPUT_BYTES / 2) throw new Error('input files exceed the analysis size limit');
            return { name, data: attachment.buffer.toString('base64') };
          }
          const descriptor = fs.openSync(real, "r");
          try {
            const stat = fs.fstatSync(descriptor);
            total += stat.size;
            if (!stat.isFile() || total > MAX_INPUT_BYTES / 2) throw new Error("input files exceed the analysis size limit");
            const buffer = Buffer.alloc(stat.size);
            let count = 0;
            while (count < buffer.length) {
              const read = fs.readSync(descriptor, buffer, count, buffer.length - count, count);
              if (!read) break;
              count += read;
            }
            const after = fs.fstatSync(descriptor);
            if (count !== stat.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => after[key] !== stat[key])) throw new Error('Input file changed while reading; offer it again');
            return { name, data: buffer.subarray(0, count).toString("base64") };
          } finally { fs.closeSync(descriptor); }
        });
        const result = await run({ code: args.code, files }, { helperPath: env.MANA_ANALYSIS_HELPER, runtimeDir: env.MANA_ANALYSIS_PYTHON_DIR, shouldStop: options.shouldStop });
        options.onCharts?.(result.charts);
        options.onOutputs?.(result);
        if (result.error) throw new Error(JSON.stringify({ logs: result.logs, error: result.error }));
        return wrapUntrusted("analysis output", JSON.stringify({ logs: result.logs, error: result.error, charts: result.charts.length,
          files: (result.files || []).map(file => file.name), tables: result.tables || [] }));
      } catch (error) {
        throw new Error(wrapUntrusted("analysis failure", error.message));
      }
    },
  };
}

module.exports = { createAnalysisToolSource, TOOL_NAME };
