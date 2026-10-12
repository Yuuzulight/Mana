"use strict";

// The model proposes actions; this controller owns the order in which those
// actions are allowed to affect a coding workspace. Keeping this state outside
// the prompt makes the loop deterministic even when a local model repeats a
// tool call or loses the thread after a long test result.

const READ_TOOLS = new Set([
  "self_work__files",
  "self_work__search",
  "self_work__read",
]);
const PLAN_TOOLS = new Set(["self_work__plan"]);
const EDIT_TOOLS = new Set(["coding__propose_edit"]);
const TEST_TOOLS = new Set(["coding__run_tests"]);
const REVIEW_TOOLS = new Set(["self_work__review"]);
const DEFAULT_MAX_EDITS_BEFORE_VERIFY = 3;
const DEFAULT_REPEAT_LIMIT = 2;
const DEFAULT_MAX_RECOVERY_DENIALS = 3;

const PHASES = Object.freeze({
  INSPECT: "inspect",
  EDIT: "edit",
  VERIFY: "verify",
  DIAGNOSE: "diagnose",
  REVIEW: "review",
  COMPLETE: "complete",
  BLOCKED: "blocked",
});

function stable(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function parseResult(result) {
  if (typeof result !== "string") return result || {};
  try {
    return JSON.parse(result);
  } catch {
    return {};
  }
}

function classifyVerificationResult(result) {
  const parsed = parseResult(result);
  if (parsed?.passed === true) return { kind: "passed", retryable: false };
  const text = String(parsed?.error || parsed?.output || parsed?.stderr || "").toLowerCase();
  if (/file not found|no such file|cannot find module|missing fixture|enoent/.test(text)) {
    return { kind: "harness", retryable: false };
  }
  if (/context window|requested tokens|out of memory|cuda|vram|timed out|timeout/.test(text)) {
    return { kind: "environment", retryable: true };
  }
  return { kind: "model_or_code", retryable: true };
}

function compactText(value, limit = 2400) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.42);
  const tail = limit - head;
  return `${text.slice(0, head)}\n...[context compacted]...\n${text.slice(-tail)}`;
}

function compactAgenticResult(result, limit = 8000) {
  if (typeof result !== "string" || result.length <= limit) return result;
  const parsed = parseResult(result);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return compactText(result, limit);
  const copy = { ...parsed };
  for (const key of ["output", "stdout", "stderr", "diff", "error", "message"]) {
    if (copy[key] !== undefined) copy[key] = compactText(copy[key], key === "diff" ? 5000 : 4200);
  }
  const encoded = JSON.stringify(copy);
  if (encoded.length <= limit) return encoded;
  const fallback = {
    status: copy.status,
    passed: copy.passed,
    error: copy.error ? compactText(copy.error, 700) : undefined,
    output: compactText(copy.output || copy.stdout || copy.stderr || encoded, Math.max(300, limit - 220)),
    context_compacted: true,
  };
  return JSON.stringify(fallback);
}

function validateAction(name, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("tool arguments must be an object");
  const stringField = (field, required = false) => {
    if (args[field] !== undefined && typeof args[field] !== "string") throw new Error(`${field} must be a string`);
    if (required && !String(args[field] || "").trim()) throw new Error(`${field} is required`);
  };
  if (name === "self_work__files") stringField("contains");
  if (name === "self_work__search") {
    stringField("text", true);
    stringField("path");
    if (args.regex !== undefined && typeof args.regex !== "boolean") throw new Error("regex must be boolean");
  }
  if (name === "self_work__read") {
    stringField("path", true);
    for (const field of ["start_line", "end_line"]) {
      if (args[field] !== undefined && (!Number.isInteger(Number(args[field])) || Number(args[field]) < 1)) {
        throw new Error(`${field} must be a positive line number`);
      }
    }
  }
  if (EDIT_TOOLS.has(name)) {
    stringField("path", true);
    stringField("old_text");
    stringField("new_text", true);
    stringField("summary");
    if (String(args.new_text).length > 50000) throw new Error("new_text is too large for one controlled edit");
  }
  if (TEST_TOOLS.has(name)) {
    stringField("path");
    stringField("estimate");
    stringField("execution");
  }
  if (REVIEW_TOOLS.has(name)) stringField("pass", true);
  if (PLAN_TOOLS.has(name)) {
    if (args.steps !== undefined && (!Array.isArray(args.steps) || args.steps.length < 2 || args.steps.length > 6)) {
      throw new Error("steps must contain 2 to 6 items");
    }
    if (args.steps !== undefined && args.steps.some((step) => typeof step !== "string" || !step.trim())) {
      throw new Error("each plan step must be a non-empty string");
    }
  }
  return args;
}

class AgenticCodingController {
  constructor(options = {}) {
    this.reviewPasses = Math.max(1, Number(options.reviewPasses) || 3);
    this.reviewNames = Array.isArray(options.reviewNames) && options.reviewNames.length
      ? options.reviewNames.map(String)
      : ["correctness", "edge cases", "scope"];
    this.canSkipVerification = typeof options.canSkipVerification === "function" ? options.canSkipVerification : () => false;
    this.maxEditsBeforeVerify = Math.max(1, Number(options.maxEditsBeforeVerify) || DEFAULT_MAX_EDITS_BEFORE_VERIFY);
    this.phase = PHASES.INSPECT;
    this.version = 0;
    this.edits = 0;
    this.editsSinceTest = 0;
    this.tests = 0;
    this.lastTestPassed = false;
    this.lastTestKey = null;
    this.lastEditKey = null;
    this.reviewed = 0;
    this.actionHistory = [];
    this.reads = new Map();
    this.actionCounts = new Map();
    this.repeatLimit = Math.max(1, Number(options.repeatLimit) || DEFAULT_REPEAT_LIMIT);
    this.failures = [];
    this.blockedReason = null;
    this.planned = false;
    this.lastVerification = null;
    this.recoveryAttempts = new Map();
    this.recoveryDenials = 0;
    this.recoveryKey = null;
    this.maxRecoveryDenials = Math.max(1, Number(options.maxRecoveryDenials) || DEFAULT_MAX_RECOVERY_DENIALS);
    this.requirePlan = Boolean(options.requirePlan);
  }

  snapshot() {
    const snapshot = {
      phase: this.phase,
      version: this.version,
      edits: this.edits,
      editsSinceTest: this.editsSinceTest,
      tests: this.tests,
      lastTestPassed: this.lastTestPassed,
      reviewed: this.reviewed,
      failures: this.failures.slice(-3),
      planned: this.planned,
      lastVerification: this.lastVerification,
      recoveryDenials: this.recoveryDenials,
      allowedActions: this.allowedActions(),
    };
    if (this.blockedReason) snapshot.blockedReason = this.blockedReason;
    return snapshot;
  }

  context() {
    const s = this.snapshot();
    const recovery = this.lastVerification && this.lastVerification.kind !== "passed"
      ? ` recovery=${this.lastVerification.kind}:${this.recoveryAttempts.get(this.lastVerification.kind) || 0}`
      : "";
    return `[controller phase=${s.phase} planned=${s.planned ? "yes" : "no"} edits=${s.edits} tests=${s.tests} last_test=${s.lastTestPassed ? "passed" : "not-passed"} reviews=${s.reviewed}/${this.reviewPasses}${recovery} allowed=${s.allowedActions.join(",")}]`;
  }

  allowedActions() {
    if (this.phase === PHASES.BLOCKED || this.phase === PHASES.COMPLETE) return [];
    if (!this.planned) return ["self_work__plan", "self_work__files", "self_work__search", "self_work__read"];
    if (this.phase === PHASES.VERIFY) {
      const actions = ["coding__run_tests"];
      if (this.editsSinceTest < this.maxEditsBeforeVerify) actions.push("coding__propose_edit");
      if (this.canSkipVerification()) actions.push("self_work__review", "session_goal__finish");
      return actions;
    }
    if (this.phase === PHASES.REVIEW) return ["self_work__review", "session_goal__finish"];
    if (this.phase === PHASES.DIAGNOSE) return ["self_work__search", "self_work__read", "coding__propose_edit", "coding__run_tests"];
    return ["self_work__files", "self_work__search", "self_work__read", "coding__propose_edit"];
  }

  reject(reason) {
    this.blockedReason = reason;
    this.phase = PHASES.BLOCKED;
    const error = new Error(`${reason} ${this.context()}`);
    error.code = "AGENTIC_CONTROLLER_BLOCKED";
    return error;
  }

  deny(reason, details = {}) {
    const recoveryCodes = new Set([
      "PLAN_ALREADY_SET",
      "DUPLICATE_ACTION",
      "DUPLICATE_TEST",
      "ILLEGAL_ACTION",
      "PLAN_REQUIRED",
      "VERIFY_REQUIRED",
    ]);
    if (recoveryCodes.has(details.recoveryCode)) {
      const key = `${this.currentActionName || "unknown"}:${details.recoveryCode}`;
      this.recoveryDenials = this.recoveryKey === key ? this.recoveryDenials + 1 : 1;
      this.recoveryKey = key;
    } else {
      this.recoveryDenials = 0;
      this.recoveryKey = null;
    }
    if (this.recoveryDenials >= this.maxRecoveryDenials && recoveryCodes.has(details.recoveryCode)) {
      this.phase = PHASES.BLOCKED;
      details = {
        ...details,
        recoveryCode: "LOCAL_MODEL_STALLED",
        escalationRequired: true,
        recoveryDenials: this.recoveryDenials,
        nextActions: [],
      };
      reason = `The local model made ${this.recoveryDenials} recovery attempts without meaningful progress. Escalate this task to the configured fallback model.`;
    }
    const error = new Error(`${reason} ${this.context()}`);
    error.code = "AGENTIC_CONTROLLER_DENIED";
    Object.assign(error, details);
    return error;
  }

  recoveryActions(name) {
    if (name === "self_work__read" || name === "self_work__files") {
      return ["self_work__search", "coding__propose_edit"];
    }
    if (name === "coding__run_tests") {
      return ["self_work__search", "self_work__read", "coding__propose_edit"];
    }
    if (name === "coding__propose_edit") {
      return ["self_work__search", "self_work__read", "coding__run_tests"];
    }
    return this.allowedActions();
  }

  before(name, args = {}) {
    validateAction(name, args);
    this.currentActionName = name;
    if (this.phase === PHASES.BLOCKED) throw this.reject(`Controller stopped this run: ${this.blockedReason}.`);
    if (this.phase === PHASES.COMPLETE) throw this.reject("The coding goal is already complete.");

    if (EDIT_TOOLS.has(name) && this.requirePlan && !this.planned) {
      throw this.deny("Create a short plan with self_work__plan before editing the workspace.", {
        recoveryCode: "PLAN_REQUIRED",
        nextActions: ["self_work__plan", "self_work__files", "self_work__search", "self_work__read"],
      });
    }
    const allowed = this.requirePlan ? this.allowedActions() : [];
    if (PLAN_TOOLS.has(name) && this.planned &&
        args.steps === undefined && args.done === undefined && args.no_test === undefined) {
      throw this.deny("A plan already exists. Advance it with an inspection, edit, verification, review, or finish action instead of restating it.", {
        recoveryCode: "PLAN_ALREADY_SET",
        nextActions: this.allowedActions().filter((action) => action !== "self_work__plan"),
      });
    }
    if (allowed.length && !allowed.includes(name)) {
      throw this.deny(`This is the ${this.phase} phase. Choose one of: ${allowed.join(", ")}.`, {
        recoveryCode: "ILLEGAL_ACTION",
        nextActions: allowed,
      });
    }

    const key = `${name}:${stable(args)}`;
    const count = this.actionCounts.get(key) || 0;
    if (count >= this.repeatLimit && this.actionHistory.some((entry) => entry.key === key && entry.version === this.version)) {
        throw this.deny(`This action was repeated ${count} times without a meaningful change. Choose a different inspection, edit the workspace, or run a targeted verification.`, {
          recoveryCode: "DUPLICATE_ACTION",
          nextActions: this.recoveryActions(name),
        });
    }
    if (READ_TOOLS.has(name)) {
      const previous = this.reads.get(key);
      if (previous === this.version) {
        throw this.deny(`This exact inspection was already performed without a workspace change. Use a different range/search or take the next action; do not repeat it.`, {
          recoveryCode: "DUPLICATE_ACTION",
          nextActions: this.recoveryActions(name),
        });
      }
      return { key, phase: this.phase };
    }

    if (EDIT_TOOLS.has(name)) {
      if (this.requirePlan && !this.planned) {
        throw this.deny("Create a short plan with self_work__plan before editing the workspace.", {
          recoveryCode: "PLAN_REQUIRED",
          nextActions: ["self_work__plan", "self_work__files", "self_work__search", "self_work__read"],
        });
      }
      if (this.editsSinceTest >= this.maxEditsBeforeVerify) {
        throw this.deny(`This edit batch reached ${this.maxEditsBeforeVerify} edits without verification. Run the targeted tests before making another edit.`, {
          recoveryCode: "VERIFY_REQUIRED",
          nextActions: ["coding__run_tests"],
        });
      }
      return { key, phase: PHASES.EDIT };
    }

    if (TEST_TOOLS.has(name)) {
      if (this.tests > 0 && this.editsSinceTest === 0 && key === this.lastTestKey) {
        throw this.deny("The same verification was already run without a change. Inspect the failure or edit the workspace before retrying.", {
          recoveryCode: "DUPLICATE_TEST",
          nextActions: this.recoveryActions(name),
        });
      }
      return { key, phase: PHASES.VERIFY };
    }

    if (REVIEW_TOOLS.has(name)) {
      // Reviews are read-only and can be useful while diagnosing a change;
      // the finish gate below still requires both a passing test and every
      // review pass before the work can be handed in.
      return { key, phase: PHASES.REVIEW };
    }

    if (name === "session_goal__finish") {
      if (this.edits > 0 && this.reviewed < this.reviewPasses) {
        throw this.deny(`Before you finish, review your diff with self_work__review: ${this.reviewNames.join(", then ")}.`);
      }
      if (this.edits > 0 && !this.lastTestPassed && !this.canSkipVerification()) {
        throw this.deny("The goal cannot finish until the latest edit has a passing verification run.");
      }
      return { key, phase: PHASES.COMPLETE };
    }

    return { key, phase: this.phase };
  }

  after(name, args = {}, result) {
    const key = `${name}:${stable(args)}`;
    const parsed = parseResult(result);
    this.recoveryDenials = 0;
    this.recoveryKey = null;
    this.actionCounts.set(key, (this.actionCounts.get(key) || 0) + 1);
    this.actionHistory.push({ name, key, version: this.version, at: new Date().toISOString() });
    if (this.actionHistory.length > 40) this.actionHistory.shift();

    if (PLAN_TOOLS.has(name)) {
      if (Array.isArray(args.steps) && args.steps.length >= 2) this.planned = true;
      if (args.done !== undefined && this.planned) this.planned = true;
      this.phase = PHASES.INSPECT;
    } else if (READ_TOOLS.has(name)) {
      this.reads.set(key, this.version);
      if (this.phase === PHASES.INSPECT) this.phase = PHASES.INSPECT;
    } else if (EDIT_TOOLS.has(name)) {
      if (parsed?.status === "error") return;
      this.edits += 1;
      this.editsSinceTest += 1;
      this.version += 1;
      this.lastEditKey = key;
      this.lastTestPassed = false;
      this.reviewed = 0;
      this.phase = PHASES.VERIFY;
    } else if (TEST_TOOLS.has(name)) {
      this.tests += 1;
      this.editsSinceTest = 0;
      this.lastTestKey = key;
      this.lastTestPassed = parsed?.passed === true;
      const verification = classifyVerificationResult(result);
      this.lastVerification = verification;
      if (verification.kind !== "passed") {
        this.failures.push(verification.kind);
        this.recoveryAttempts.set(verification.kind, (this.recoveryAttempts.get(verification.kind) || 0) + 1);
      }
      this.phase = this.lastTestPassed ? PHASES.REVIEW : PHASES.DIAGNOSE;
    } else if (REVIEW_TOOLS.has(name)) {
      this.reviewed = Math.min(this.reviewPasses, this.reviewed + 1);
      this.phase = PHASES.REVIEW;
    } else if (name === "session_goal__finish") {
      this.phase = PHASES.COMPLETE;
    }
    return this.snapshot();
  }
}

function createAgenticCodingController(options) {
  return new AgenticCodingController(options);
}

module.exports = {
  AgenticCodingController,
  PHASES,
  classifyVerificationResult,
  compactAgenticResult,
  validateAction,
  createAgenticCodingController,
};
