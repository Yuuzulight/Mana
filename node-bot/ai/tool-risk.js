// Issue #669: per-call risk tiers for tool calls, and the gate that uses
// them. approval-gate.js (#152) began as an approval for content Mana
// authored herself; with tool calling on by default (#672) it is also the
// main safety layer between the model and the user's machine, so every
// call is classified before it runs:
//
//   read < low < write < network < install < destructive
//
// #911: "low" is a small, reversible change on this PC that I'd make
// without thinking twice (a media key, the volume, opening an app from my
// Start menu); only built-in tools get it.
//
// Pipes and chained commands take their highest segment's tier; anything
// unrecognized is "write". Destructive calls always go to a human, whatever
// was granted before. The approval mode (Settings > Approvals, else
// MANA_TOOL_APPROVAL) decides the rest: "smart" (default) asks for anything
// above low tier, "ask" for every call, "off" only for destructive ones.
//
// ponytail: pattern rules are a tripwire, not a parser -- a command built
// at run time ($x = 'rm'; & $x -rf) reads as an unknown "write" call, not a
// destructive one. Unknowns defaulting to "write" (which prompts in ask/
// smart mode) is the backstop, not these regexes.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isCredentialPath } = require("./tool-policy");
const { GAME_WIKI_SOURCE, untrustedSources } = require("./untrusted-content");

const TIERS = ["read", "low", "write", "network", "install", "destructive"];
const MODES = ["off", "ask", "smart"];

function maxTier(a, b) {
  return TIERS.indexOf(b) > TIERS.indexOf(a) ? b : a;
}

// Built-in tools have fixed tiers and guard their own arguments (read_file
// and coding__propose_edit refuse credential paths themselves, #268), so
// only tools *not* listed here -- an MCP server's, anything added later --
// get their arguments inspected. "read" means nothing on the user's machine
// changes or leaves it: expression__set, session_goal__finish and
// deep_thinking__set only touch Mana's own reply state, and
// coding__propose_edit only writes a .diff under Mana's own data dir -- the
// user applies it themselves (#276), so asking first would only lose the
// diff path from the reply. reminder__* (#905) only keep Mana's own list of
// reminders the user asked for.
const BUILTIN_TIERS = {
  read_file: "read",
  session_search__query: "read",
  skill__view: "read",
  snapshot__list: "read",
  vision__look: "read",
  vision__camera: "read", // #912: behind its own off-by-default toggle in the launcher
  vision__save_snapshot: "write", // #962: writes a photo to disk, only when I ask
  expression__set: "read",
  session_goal__finish: "read",
  deep_thinking__set: "read",
  // #923: only Mana's own speech word list, and only words from my own
  // message (ai/speech-tool-source.js) -- my asking is the approval.
  speech__add_word: "read",
  speech__remove_word: "read",
  speech__list_words: "read",
  browser_automation__snapshot: "read",
  browser_automation__scroll: "read",
  browser_automation__hand_over: "read", // #1139: only asks me, in the Browser panel
  coding__propose_edit: "read",
  reminder__set: "read",
  reminder__list: "read",
  reminder__cancel: "read",
  // #914: only the speaking character's own relationship notes and
  // milestones (relationship-store.js), capped and shown to her alone.
  relationship__note: "read",
  relationship__milestone: "read",
  // #906: only reach the mail/calendar server I set up in Settings, and
  // change nothing there (read-only mailbox, BODY.PEEK).
  email__recent: "read",
  email__search: "read",
  email__read: "read",
  calendar__events: "read",
  calendar__add_event: "write",
  // #911 (ai/desktop-tool-source.js): the launcher only focuses a window
  // that's already open, and only opens Start-menu apps. Switching the audio
  // output and moving files are "write": they ask first.
  desktop__focus_app: "read",
  desktop__list_audio_outputs: "read",
  desktop__set_audio_output: "write",
  desktop__list_folder: "read",
  desktop__move_files: "write",
  desktop__media: "low",
  desktop__set_volume: "low",
  desktop__open_app: "low",
  // #907: no arguments; searches only the topics and games I set in Settings.
  briefing__now: "read",
  memory__remember: "write",
  skill__create: "write",
  skill__run: "write",
  snapshot__restore: "write",
  // #787: runs the workspace's tests -- the user's own code. #669 has no
  // execute tier; "write" is what an unrecognized command gets.
  coding__run_tests: "write",
  browser_automation__navigate: "network",
  browser_automation__click: "network",
  browser_automation__type: "network",
  browser_automation__select: "network",
  browser_automation__back: "network",
};

// Built-ins that already ask through the approval gate themselves
// (memory-write, skill-write/skill-run, snapshot-restore, coding-run-tests,
// calendar-add-event, browser-
// automation's first-use gate). Per-call approval passes them through
// rather than asking twice for one call.
const SELF_GATED = new Set([
  "memory__remember",
  "skill__create",
  "skill__run",
  "snapshot__restore",
  "coding__run_tests",
  "calendar__add_event",
  "browser_automation__navigate",
  "browser_automation__click",
  "browser_automation__type",
  "browser_automation__snapshot",
  "browser_automation__select",
  "browser_automation__scroll",
  "browser_automation__back",
  "browser_automation__hand_over",
]);

// Once a turn has taken in outside content (a web page, search or wiki
// results, an email, the browser tab: ai/untrusted-content.js), that text
// may be steering the model. For the rest of the turn these read/low-tier
// tools, which act or read my private things, ask me first, and so does
// anything that contacts the network (sends data out) -- in every mode,
// past grants and Guardian (forceReview).
const ASK_AFTER_UNTRUSTED = new Set([
  "vision__look",
  "vision__camera",
  "email__recent",
  "email__search",
  "email__read",
  "calendar__events",
  "reminder__set",
  "reminder__cancel",
  "read_file",
  "session_search__query",
  "coding__propose_edit",
  "speech__add_word",
  "speech__remove_word",
]);

// sources: where the turn's outside content came from. Game wiki results
// alone (mid-game "where do I unlock X", whose prompt says to look at my
// screen) don't make vision__look ask: a screenshot stays on this PC.
function asksAfterUntrusted(name, risk, sources) {
  if (name === "vision__look" && [...sources].every((s) => s === GAME_WIKI_SOURCE)) return false;
  return ASK_AFTER_UNTRUSTED.has(name) || String(name).startsWith("desktop__") || risk.tier === "network";
}

// Outside content arriving through a tool: a framed result (email,
// calendar) or the browser automation's pages.
// ponytail: an MCP server's results don't count (a shell `dir` isn't
// outside content); frame them too if a web-fetching MCP server gets used.
function untrustedSourcesFrom(name, result) {
  const sources = untrustedSources(result);
  return String(name).startsWith("browser_automation__") ? [...sources, "browser automation"] : sources;
}

// Where shell-running MCP tools put their command line and folder.
const COMMAND_KEYS = ["command", "cmd", "commandLine", "command_line", "script", "shell_command"];
const ARGV_KEYS = ["args", "argv", "arguments"];
const CWD_KEYS = ["cwd", "workingDirectory", "working_directory", "workdir", "directory"];
const PATH_KEY_RE = /path|file|dir|folder|src|source|dest|target/i;
const HOST_KEY_RE = /^(url|uri|href|host|hostname|domain|endpoint|server|base_?url)$/i;

// Deliberately short: anything that can also write (sort -o, date/hostname
// with an argument, ipconfig /release, ForEach-Object's %) is left out and
// so reads as "write".
const READ_COMMANDS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "less", "more", "pwd", "cd", "echo",
  "whoami", "grep", "egrep", "fgrep", "rg", "findstr", "where", "which", "wc", "tree",
  "stat", "file", "du", "df", "ps", "tasklist", "ver", "systeminfo", "printenv", "env",
  "find", "diff", "fc", "uname", "sls", "gci", "gc", "gi", "gl", "gps", "gcm", "select",
  "measure", "write-output", "write-host",
]);
// PowerShell verbs that only read. Test-NetConnection/Resolve-DnsName are
// caught by NETWORK_COMMANDS first; Format-Volume by DESTRUCTIVE_RULES.
const READ_PS_VERB_RE = /^(get|test|select|measure|resolve|compare|format|where|sort|group|convertto|convertfrom)-/;
const NETWORK_COMMANDS = new Set([
  "curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "ssh", "scp",
  "sftp", "ftp", "rsync", "ping", "tracert", "traceroute", "nslookup", "dig", "nc",
  "ncat", "telnet", "test-netconnection", "resolve-dnsname", "start-bitstransfer",
  "bitsadmin", "certutil",
]);
// First argument is the host to contact.
const HOST_FIRST_COMMANDS = new Set([
  "ssh", "ping", "nslookup", "dig", "telnet", "nc", "ncat", "tracert", "traceroute",
  "sftp", "ftp", "test-netconnection",
]);
const PACKAGE_MANAGERS = new Set([
  "npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipx", "uv", "winget", "choco", "scoop",
  "apt", "apt-get", "yum", "dnf", "pacman", "brew", "snap", "cargo", "go", "gem", "dotnet",
  "composer",
]);
const INSTALL_SUBCOMMANDS = new Set([
  "install", "i", "add", "ci", "update", "upgrade", "up", "uninstall", "remove", "rm",
  "un", "get", "download", "tool", "sync",
]);
const INSTALL_COMMANDS = new Set([
  "npx", "pnpx", "bunx", "uvx", "msiexec", "install-module", "install-package",
  "install-script", "update-module", "save-module", "add-appxpackage",
  "install-windowsfeature",
]);
const GIT_READ = new Set(["status", "log", "diff", "show", "blame", "rev-parse", "ls-files", "grep", "describe", "shortlog"]);
const GIT_NETWORK = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule"]);
const SHELLS = new Set(["powershell", "pwsh", "cmd", "bash", "sh", "zsh", "dash"]);
const SHELL_RUN_FLAG_RE = /^(-c|\/c|\/k|-com\w*)$/;
const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "nice", "start", "call", "exec", "command", "xargs"]);

// Checked against the whole command line after normalize() -- quotes, cmd's
// ^ and PowerShell's ` escapes removed, lowercased -- so r"m" -r^f and
// Re`move-Item don't slip past. [^|;&\n]* keeps a flag inside the same
// command as the verb it modifies.
const DESTRUCTIVE_RULES = [
  // -re\w*: PowerShell accepts any unambiguous prefix of -Recurse. \/s
  // without a leading space: cmd takes /q/s as two flags.
  { id: "recursive-delete", pattern: /\b(rm|remove-item|ri|del|erase|rd|rmdir)\b[^|;&\n]*(\s-[rfdiv]*r[rfdiv]*\b|\s--recursive\b|\s-re\w*|\/s\b)/ },
  { id: "dotnet-delete", pattern: /\[(system\.)?io\.(directory|file)\]::delete\b/ },
  { id: "wildcard-delete", pattern: /\b(rm|remove-item|ri|del|erase)\b[^|;&\n]*\s\S*\*/ },
  { id: "piped-delete", pattern: /\|\s*(remove-item|ri|rm|del|erase)\b|\bxargs\s+(-\S+\s+)*(rm|del)\b|\s-delete\b|-exec\s+rm\b/ },
  { id: "disk-format", pattern: /\bformat(\.com)?\s+[a-z]:|\b(format-volume|clear-disk|initialize-disk|diskpart|mkfs(\.\w+)?|wipefs|shred)\b|\bcipher(\.exe)?\s+\/w|\bdd\b[^|;&\n]*\bof=/ },
  { id: "git-force-push", pattern: /\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(\s--force\S*|\s-[a-z]*f[a-z]*\b|\s\+\S)/ },
  { id: "git-discard", pattern: /\bgit\b[^|;&\n]*\breset\b[^|;&\n]*\s--hard\b|\bgit\b[^|;&\n]*\bclean\b[^|;&\n]*\s-[a-z]*f/ },
  { id: "registry-edit", pattern: /\breg(\.exe)?\s+(add|delete|import|restore|load|unload|copy|save)\b|\bregedit(\.exe)?\b[^|;&\n]*\s[/-]s\b/ },
  { id: "download-and-run", pattern: /\b(iwr|invoke-webrequest|irm|invoke-restmethod|curl|wget|net\.webclient|start-bitstransfer)\b[^\n]*\|\s*(iex|invoke-expression|sh|bash|zsh|dash|python\d?|node|pwsh|powershell|cmd)\b|\b(iex|invoke-expression)\b|\bdownload(string|file)\b|\bcertutil(\.exe)?\b[^|;&\n]*-urlcache|\bbitsadmin(\.exe)?\b[^|;&\n]*\/transfer|\bmshta(\.exe)?\s|\bregsvr32(\.exe)?\b[^|;&\n]*\/i:/ },
  { id: "encoded-command", pattern: /\b(powershell|pwsh)(\.exe)?\b[^|;&\n]*\s-e(?![xp])[a-z]*\s/ },
  { id: "system-change", pattern: /\b(shutdown|restart-computer|stop-computer|bcdedit|set-executionpolicy|takeown)\b|\b(vssadmin|wbadmin)\b[^|;&\n]*\bdelete\b|\bnet(\.exe)?\s+(user|localgroup)\b[^|;&\n]*\s\/(add|delete)\b|\b(chmod|chown)\s+-r\b|\bsetx\b[^|;&\n]*\s\/m\b/ },
  { id: "credential-access", pattern: /\.git-credentials|(^|[\s\\/])_?\.?netrc\b|\.pgpass\b|\.pypirc\b|\.npmrc\b|login data|logins\.json|\bkey[34]\.db\b|\.kdbx\b|\bid_(rsa|dsa|ecdsa|ed25519)|\b(cmdkey|vaultcmd|get-storedcredential|mimikatz|lsass)\b|\\config\\(sam|security)\b|\bhklm\\(sam|security)\b/ },
];
const REGISTRY_PATH_RE = /\bhk(lm|cu|cr|u|cc):|registry::|\bhkey_/;

// Folded before anything is matched: PowerShell takes Unicode dashes and
// quotes as - and " ("Remove-Item x \u2013Recurse" works); line
// continuations (\, ` or ^ before a newline) join one command; bash's
// ${IFS} is a space.
function fold(text) {
  return String(text)
    .replace(/[\\`^]\r?\n/g, " ")
    .replace(/\$\{?ifs\}?/gi, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201f]/g, '"');
}

function normalize(text) {
  return fold(text).replace(/[\^`"']/g, "").toLowerCase().replace(/[^\S\n]+/g, " ");
}

// Quote-aware so "C:\Program Files\x.exe" stays one token; quotes and cmd's
// ^ escapes are then dropped from each token.
function tokenize(segment) {
  return (fold(segment).match(/"[^"]*"|'[^']*'|\S+/g) || [])
    .map((t) => t.replace(/[\^"']/g, ""))
    .filter(Boolean);
}

function commandName(token) {
  return path.win32.basename(String(token).toLowerCase()).replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

// Harmless redirections are dropped first so `dir 2>&1` isn't split on its
// "&" into a bogus "1" command, and `2>nul` isn't counted as a file write.
function splitSegments(command) {
  const cleaned = fold(command)
    .replace(/\d?>&\d/g, " ")
    .replace(/\d?>\s*(nul|\/dev\/null)(?=\s|$)/gi, " ");
  // Pipes, && ||, ;, cmd's &, newlines, and command substitution
  // ($(...), `...`, PowerShell's (...) and {...}). Over-splitting inside a
  // quoted string only adds "unknown" segments -- the safe direction.
  return cleaned.split(/\|\||&&|\$\(|[|;&\n\r`(){}]/).map((s) => s.trim()).filter(Boolean);
}

// Returns { tier, exes, reason? } for one command. exes: the raw executable
// tokens it starts, including ones nested in `cmd /c ...` (for approval
// binding).
function classifySegment(tokens, depth = 0) {
  let i = 0;
  let floor = "read";
  while (i < tokens.length && /^[\w.]+=/.test(tokens[i])) i += 1; // FOO=bar cmd
  while (i < tokens.length && WRAPPERS.has(commandName(tokens[i]))) {
    if (["sudo", "doas"].includes(commandName(tokens[i]))) floor = "write";
    i += 1;
    while (i < tokens.length && /^[-/]/.test(tokens[i])) i += 1; // start /b, sudo -u ...
  }
  if (i >= tokens.length) return { tier: floor, exes: [] };
  const exe = tokens[i];
  const name = commandName(exe);
  const rest = tokens.slice(i + 1);
  const redirects = rest.some((t) => t.includes(">"));
  const at = (tier) => ({ tier: maxTier(maxTier(floor, tier), redirects ? "write" : "read"), exes: [exe] });
  const isRead = READ_COMMANDS.has(name) || READ_PS_VERB_RE.test(name);

  if (exe.startsWith("$")) return at("write"); // $var = ... / & $var
  if (!isRead && REGISTRY_PATH_RE.test(rest.join(" ").toLowerCase())) {
    return { tier: "destructive", exes: [exe], reason: "registry-edit" };
  }
  if (SHELLS.has(name)) {
    const flag = rest.findIndex((t) => SHELL_RUN_FLAG_RE.test(t.toLowerCase()));
    if (flag === -1 || depth >= 3) return at("write");
    return splitSegments(rest.slice(flag + 1).join(" "))
      .map((s) => classifySegment(tokenize(s), depth + 1))
      .reduce(
        (acc, seg) => ({
          tier: maxTier(acc.tier, seg.tier),
          exes: [...acc.exes, ...seg.exes],
          reason: acc.reason || seg.reason,
        }),
        at("read"),
      );
  }
  if (["python", "python3", "py"].includes(name) && rest[0] === "-m" && rest[1]) {
    const inner = classifySegment(rest.slice(1), depth + 1);
    return { ...inner, exes: [exe, ...inner.exes] };
  }
  if (name === "git") {
    const sub = String(rest[0] || "").toLowerCase();
    if (GIT_READ.has(sub) && !rest.some((t) => /^--output/.test(t))) return at("read");
    return at(GIT_NETWORK.has(sub) ? "network" : "write");
  }
  if (NETWORK_COMMANDS.has(name)) return at("network");
  if (INSTALL_COMMANDS.has(name)) return at("install");
  if (PACKAGE_MANAGERS.has(name)) {
    return at(INSTALL_SUBCOMMANDS.has(String(rest[0] || "").toLowerCase()) ? "install" : "write");
  }
  // read commands that can still run or write something
  if (name === "find" && rest.some((t) => /^-(delete|exec|execdir|ok|fprint)/.test(t))) return at("write");
  if (name === "rg" && rest.some((t) => /^--pre/.test(t))) return at("write");
  return at(isRead ? "read" : "write");
}

// Only a tool that evidently just runs its command line (run_command,
// shell_exec, start_process, interact_with_process...) earns a tier below
// "write" from that command -- otherwise any MCP tool could pass
// command: "ls" to be auto-approved as read-only.
const SHELL_TOOL_WORDS = new Set([
  "run", "exec", "execute", "start", "shell", "command", "cmd", "terminal", "process",
  "powershell", "pwsh", "bash", "sh", "interact", "with", "in",
]);

function isShellTool(name) {
  return String(name).split("__").pop().toLowerCase().split(/[_-]/).every((w) => SHELL_TOOL_WORDS.has(w));
}

function extractCommand(name, args) {
  if (!args || typeof args !== "object") return null;
  // "input": what interact_with_process-style tools type into a shell
  const keys = isShellTool(name) ? [...COMMAND_KEYS, "input"] : COMMAND_KEYS;
  const key = keys.find(
    (k) => (typeof args[k] === "string" && args[k].trim()) || (Array.isArray(args[k]) && args[k].length),
  );
  if (!key) return null;
  const head = Array.isArray(args[key]) ? args[key].map(String).join(" ") : args[key];
  const argvKey = ARGV_KEYS.find((k) => Array.isArray(args[k]));
  return argvKey ? `${head} ${args[argvKey].map(String).join(" ")}` : head;
}

function extractCwd(args) {
  const key = CWD_KEYS.find((k) => typeof args?.[k] === "string" && args[k].trim());
  return key ? args[key] : "";
}

// Every string in args, with the key it sat under (arrays inherit theirs).
function stringEntries(value, key = "", out = [], depth = 0) {
  if (depth > 6) return out;
  if (typeof value === "string") out.push([key, value]);
  else if (Array.isArray(value)) value.forEach((v) => stringEntries(v, key, out, depth + 1));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) stringEntries(v, k, out, depth + 1);
  }
  return out;
}

const URL_RE = /\b(?:https?|ftps?|wss?|ssh|sftp|git):\/\/[^\s"'<>`|)]+/gi;
const SCP_RE = /\b[\w.-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+):/gi;
const UNC_RE = /\\\\([a-z0-9][\w.-]*)\\/gi;
const BARE_HOST_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$|^\d{1,3}(?:\.\d{1,3}){3}$/i;

function hostOf(candidate) {
  try {
    return new URL(candidate).hostname.toLowerCase() || null;
  } catch (e) {
    return null;
  }
}

// Issue #669 item 6 (egress inspector): the hosts a call's arguments point
// at -- URLs, user@host: scp targets, \\host\share paths, url/host-named
// keys, and the host argument of ssh/ping-style commands.
function extractHosts(args, command) {
  const hosts = new Set();
  const add = (h) => h && hosts.add(h.toLowerCase().replace(/\.$/, ""));
  for (const [key, value] of stringEntries(args)) {
    for (const m of value.match(URL_RE) || []) add(hostOf(m));
    for (const m of value.matchAll(SCP_RE)) add(m[1]);
    for (const m of value.matchAll(UNC_RE)) add(m[1]);
    const trimmed = value.trim();
    if (HOST_KEY_RE.test(key) && BARE_HOST_RE.test(trimmed)) add(trimmed);
  }
  for (const segment of command ? splitSegments(command) : []) {
    const tokens = normalize(segment).split(" "); // unquoted: cmd /c "ping x"
    const idx = tokens.findIndex((t) => HOST_FIRST_COMMANDS.has(commandName(t)));
    const host = (idx === -1 ? [] : tokens.slice(idx + 1))
      .map((t) => t.split("@").pop().replace(/:\d+$/, ""))
      .find((t) => BARE_HOST_RE.test(t)); // first host-shaped arg, past -n 1 etc.
    add(host);
  }
  return [...hosts];
}

// Credential files named in a path-like argument or anywhere in a command
// line, reusing read_file's own list (#268).
function touchesCredentials(args, command) {
  const candidates = stringEntries(args)
    .filter(([key]) => PATH_KEY_RE.test(key))
    .map(([, v]) => v);
  if (command) candidates.push(...tokenize(command));
  return candidates.some((c) => isCredentialPath(path.win32.basename(String(c).trim())));
}

// { tier, reasons, hosts, command, cwd } for one tool call. reasons lists
// the destructive rules that matched (non-empty iff tier is destructive).
function classifyToolCall(name, args) {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_TIERS, name)) {
    const tier = BUILTIN_TIERS[name];
    const hosts = tier === "network" ? extractHosts(args, null) : [];
    return { tier, reasons: [], hosts, command: null, cwd: "" };
  }
  const command = extractCommand(name, args);
  const reasons = new Set();
  let tier = "write";
  if (command) {
    const segments = splitSegments(command).map((s) => classifySegment(tokenize(s)));
    tier = segments.reduce((acc, s) => maxTier(acc, s.tier), isShellTool(name) ? "read" : "write");
    segments.forEach((s) => s.reason && reasons.add(s.reason));
    const text = normalize(command);
    for (const rule of DESTRUCTIVE_RULES) if (rule.pattern.test(text)) reasons.add(rule.id);
  }
  if (touchesCredentials(args, command)) reasons.add("credential-access");
  const hosts = extractHosts(args, command);
  if (hosts.length) tier = maxTier(tier, "network");
  if (reasons.size) tier = "destructive";
  return { tier, reasons: [...reasons], hosts, command, cwd: command ? extractCwd(args) : "" };
}

// Issue #669 item 5: an approval is bound to the exact call -- tool name,
// arguments, working folder, and the path + SHA-256 of every executable the
// command line starts. Recomputed right before an approved call runs.
// deps (all injectable for tests): env, platform, cwd, existsSync,
// statSync, readFileSync.
function resolveExecutable(exe, cwd, deps) {
  const win = deps.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const exts = win
    ? ["", ...String(deps.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  const dirs = /[\\/]/.test(exe)
    ? [cwd || deps.cwd()]
    : String(deps.env.PATH || deps.env.Path || "").split(win ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.resolve(dir, exe + ext);
      try {
        if (deps.existsSync(candidate) && deps.statSync(candidate).isFile()) return candidate;
      } catch (e) {
        // unreadable candidate -- keep looking
      }
    }
  }
  return null;
}

function bindCall(name, args, overrides = {}) {
  const deps = {
    env: process.env,
    platform: process.platform,
    cwd: () => process.cwd(),
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    readFileSync: fs.readFileSync,
    ...overrides,
  };
  const command = extractCommand(name, args) || "";
  const cwd = extractCwd(args);
  const executables = splitSegments(command)
    .flatMap((s) => classifySegment(tokenize(s)).exes)
    .map((exe) => {
      const resolved = resolveExecutable(exe, cwd, deps);
      let sha256 = null;
      try {
        if (resolved) sha256 = crypto.createHash("sha256").update(deps.readFileSync(resolved)).digest("hex");
      } catch (e) {
        sha256 = null;
      }
      // Shell builtins (dir, Remove-Item) resolve to nothing; bound by name.
      return { name: exe, path: resolved, sha256 };
    });
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ name, args, cwd, executables }))
    .digest("hex");
  return { digest, cwd, executables };
}

// #911: a call without a command line shows its arguments, so approving
// desktop__set_audio_output says which device.
function describeCall(name, risk, args) {
  const parts = [`${name} (${risk.tier})`];
  if (risk.command) parts.push(`runs: ${risk.command.slice(0, 200)}`);
  else if (args && typeof args === "object" && Object.keys(args).length) {
    const json = JSON.stringify(args);
    parts.push(`with ${json.length > 300 ? `${json.slice(0, 300)}...` : json}`);
  }
  if (risk.cwd) parts.push(`in ${risk.cwd}`);
  if (risk.reasons.length) parts.push(`destructive: ${risk.reasons.join(", ")}`);
  if (risk.hosts.length) parts.push(`will contact ${risk.hosts.join(", ")}`);
  return parts.join(" -- ");
}

// The first valid mode among the candidates (saved setting, then env), else
// "smart".
function resolveToolApprovalMode(...candidates) {
  for (const candidate of candidates) {
    const mode = String(candidate ?? "").trim().toLowerCase();
    if (MODES.includes(mode)) return mode;
  }
  return "smart";
}

// Wraps a {tools, isKnownTool, executeTool} policy (server.js applies it
// around wrapWithHooks). mode: "smart" (default -- ask, but read- and low-tier calls
// run without a prompt), "ask" (every call asks unless its capability/
// command is granted), "off" (only destructive calls ask). The Guardian
// pre-check (#284), when enabled, is the optional model confirmation for
// what still asks; it never sees destructive calls (forceReview).
//
// Grants: a call without a command line is granted per tier ("tool-read",
// "tool-network", ...); one with a command line only for that exact
// binding ("tool-exec:<digest>"), so approving `dir` never approves `del`.
// Executors are re-registered per reply with the latest policy -- the same
// tradeoff hooks-store.js's "hook-ask" already documents.
// options.alwaysReview: further tiers that, like destructive, always go to a
// human and are never granted (#699: a heartbeat check's install calls).
//
// options.untrustedSources: the sources of the outside content the turn's
// prompt already holds (see ASK_AFTER_UNTRUSTED above); a tool result can
// bring more in later.
function wrapWithRiskGate(policy, approvalGate, options = {}) {
  const mode = resolveToolApprovalMode(options.mode);
  const alwaysReview = options.alwaysReview || [];
  const bindingDeps = options.bindingDeps || {};
  // One wrap per reply, so this is "for the rest of this turn".
  const tookInUntrusted = new Set(options.untrustedSources || []);

  async function ask(name, args, risk, afterUntrusted = false) {
    const binding = risk.command ? bindCall(name, args, bindingDeps) : null;
    const summary = describeCall(name, risk, args);
    const outcome = await approvalGate.requestApproval(`tool-${risk.tier}`, {
      summary: afterUntrusted ? `after reading outside content this turn: ${summary}` : summary,
      payload: { name, args, ...(binding ? { digest: binding.digest } : {}) },
      scanText: risk.command || undefined,
      grantKey: binding ? `tool-exec:${binding.digest}` : undefined,
      forceReview: afterUntrusted || risk.tier === "destructive" || alwaysReview.includes(risk.tier),
      details: {
        tier: risk.tier,
        reasons: risk.reasons,
        hosts: risk.hosts,
        ...(binding ? { command: risk.command, cwd: binding.cwd, executables: binding.executables } : {}),
      },
    });
    return outcome.status === "approved" ? outcome.result : JSON.stringify(outcome);
  }

  for (const tier of TIERS) {
    approvalGate.registerExecutor(`tool-${tier}`, async ({ name, args, digest }) => {
      // Anything changed since the human looked (the binary was replaced,
      // PATH now resolves elsewhere) -- don't run it, ask again instead.
      if (digest && bindCall(name, args, bindingDeps).digest !== digest) {
        return ask(name, args, classifyToolCall(name, args));
      }
      return policy.executeTool(name, args);
    });
  }

  return {
    tools: policy.tools,
    isKnownTool: policy.isKnownTool,
    executeTool: async (name, args) => {
      const risk = classifyToolCall(name, args);
      if (tookInUntrusted.size && asksAfterUntrusted(name, risk, tookInUntrusted)) {
        return ask(name, args, risk, true);
      }
      const gated =
        risk.tier === "destructive" ||
        (mode !== "off" && !SELF_GATED.has(name) && !(mode === "smart" && ["read", "low"].includes(risk.tier)));
      const result = await (gated ? ask(name, args, risk) : policy.executeTool(name, args));
      for (const source of untrustedSourcesFrom(name, result)) tookInUntrusted.add(source);
      return result;
    },
  };
}

module.exports = {
  MODES,
  PATH_KEY_RE,
  classifyToolCall,
  stringEntries,
  tokenize,
  resolveToolApprovalMode,
  extractHosts,
  bindCall,
  resolveExecutable,
  wrapWithRiskGate,
};
