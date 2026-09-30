// #1010: "let me try your PR" in the chat. Runs
// windows-native-launcher/try-pr.ps1, which moves the live checkout to the
// PR's head and applies it through update-mana.ps1 (#995): a backend
// restart, or a staged launcher build with its self-check and rollback.
// "back to main" runs it with -Main. A PR number has to come from my own
// message; without one it's her newest open PR (a mana/* branch). Not in
// the built-in risk tiers, so the approval gate asks me first.
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

const TRY_PR_TOOL = "mana_update__try_pr";
const BACK_TO_MAIN_TOOL = "mana_update__back_to_main";

const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: TRY_PR_TOOL,
      description:
        "Run a pull request as your live self so Yuuzulight can try it (you restart on it; Back to main undoes it). Only when they ask. Leave pr out for your own newest open PR.",
      parameters: {
        type: "object",
        properties: { pr: { type: "integer", description: "The PR number from their message." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: BACK_TO_MAIN_TOOL,
      description: "Go back to running main after trying a PR. Only when Yuuzulight asks.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function ghJson(args, cwd) {
  return new Promise((resolve, reject) =>
    execFile("gh", args, { cwd, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve(JSON.parse(stdout)),
    ),
  );
}

// The script runs on its own: the backend it's started from restarts at its end.
function runScript(script, args) {
  spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

function createTryPrToolSource({ userMessage, repoRoot = path.join(__dirname, "..", ".."), gh = ghJson, run = runScript } = {}) {
  const script = path.join(repoRoot, "windows-native-launcher", "try-pr.ps1");
  const asked = new Set(
    [...String(userMessage || "").matchAll(/(?:#|\bPR\s*#?)(\d+)/gi)].map((m) => Number(m[1])),
  );

  async function newestOfMine() {
    const prs = await gh(["pr", "list", "--state", "open", "--author", "@me", "--limit", "100", "--json", "number,headRefName"], repoRoot);
    const mine = prs.filter((p) => p.headRefName.startsWith("mana/")).map((p) => p.number);
    return mine.length ? Math.max(...mine) : null;
  }

  async function executeTool(name, args) {
    if (name === BACK_TO_MAIN_TOOL) {
      run(script, ["-Main"]);
      return JSON.stringify({ status: "ok", note: "Switching back to main; I restart once it's applied." });
    }
    if (name !== TRY_PR_TOOL) throw new Error(`unknown tool: ${name}`);
    let pr = args?.pr == null ? null : Number(args.pr);
    if (pr !== null && !asked.has(pr)) {
      return JSON.stringify({ status: "error", error: `PR #${pr} isn't in Yuuzulight's message.` });
    }
    if (pr === null) {
      try {
        pr = await newestOfMine();
      } catch (e) {
        return JSON.stringify({ status: "error", error: e.message });
      }
      if (!pr) return JSON.stringify({ status: "error", error: "I have no open PR to try." });
    }
    run(script, ["-Pr", String(pr)]);
    return JSON.stringify({
      status: "ok",
      trying: pr,
      note: "Checking it out and building in the background; I restart on it once it's applied. The tray's Back to main undoes it.",
    });
  }

  return {
    listToolSchemas: () => TOOL_SCHEMAS,
    isKnownToolName: (name) => name === TRY_PR_TOOL || name === BACK_TO_MAIN_TOOL,
    executeTool,
  };
}

module.exports = { createTryPrToolSource, TRY_PR_TOOL, BACK_TO_MAIN_TOOL };
