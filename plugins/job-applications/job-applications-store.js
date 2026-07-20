// Local job-application tracker + reusable answer knowledge base. Same
// shape as node-bot/presets-store.js: a small, user-editable collection,
// so a single JSON file with whole-array read/write is simpler than a
// per-item file scheme (see presets-store.js's own comment on that
// tradeoff -- it applies here too).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_SHORT_TEXT_CHARS = 200;
const MAX_NOTES_CHARS = 4000;
const MAX_ANSWER_CHARS = 8000;
const MAX_KEY_CHARS = 80;
const MAX_POSTING_CHARS = 6000;
const MAX_FIT_SUMMARY_CHARS = 1000;
const VALID_STATUSES = [
  // Staged by the job-match flow: a tailored resume/cover letter exist but
  // nothing has been submitted anywhere yet -- the user applies by hand.
  "ready_to_apply",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
];
const DEFAULT_STATUS = "applied";

function cleanShortText(value, maxLength = MAX_SHORT_TEXT_CHARS) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanLongText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function createJobApplicationsStore(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.MANA_JOB_APPLICATIONS_DIR ||
    path.join(__dirname, "data");
  const filePath = path.join(dataDir, "job-applications.json");
  const now = options.now || (() => new Date().toISOString());
  const makeId = options.makeId || (() => crypto.randomUUID());

  function ensureDir() {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  function readState() {
    ensureDir();
    if (!fs.existsSync(filePath)) {
      return { applications: [], answers: [] };
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) {
        return { applications: [], answers: [] };
      }
      const parsed = JSON.parse(raw);
      return {
        applications: Array.isArray(parsed?.applications)
          ? parsed.applications
          : [],
        answers: Array.isArray(parsed?.answers) ? parsed.answers : [],
      };
    } catch (e) {
      return { applications: [], answers: [] };
    }
  }

  function writeState(state) {
    ensureDir();
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  }

  function normalizeStatus(status) {
    const clean = cleanShortText(status, 20).toLowerCase();
    if (!clean) {
      return DEFAULT_STATUS;
    }
    if (!VALID_STATUSES.includes(clean)) {
      throw new Error(`status must be one of: ${VALID_STATUSES.join(", ")}`);
    }
    return clean;
  }

  // --- Applications ---

  function listApplications() {
    return readState().applications.slice().sort((a, b) => {
      return String(b.appliedAt || "").localeCompare(String(a.appliedAt || ""));
    });
  }

  function getApplication(id) {
    if (!id) return null;
    return readState().applications.find((app) => app.id === id) || null;
  }

  function createApplication({
    company,
    role,
    status,
    url,
    notes,
    appliedAt,
    postingText,
    fitSummary,
    tailoredResume,
    tailoredCoverLetter,
  }) {
    const cleanCompany = cleanShortText(company);
    const cleanRole = cleanShortText(role);
    if (!cleanCompany) {
      throw new Error("company is required");
    }
    if (!cleanRole) {
      throw new Error("role is required");
    }

    const state = readState();
    const timestamp = now();
    const application = {
      id: makeId(),
      company: cleanCompany,
      role: cleanRole,
      status: normalizeStatus(status),
      url: cleanShortText(url, 2000),
      notes: cleanLongText(notes, MAX_NOTES_CHARS),
      appliedAt: cleanShortText(appliedAt) || timestamp,
      // Populated by the /jobs/match flow (issue #116); empty strings for
      // applications added by hand via POST /jobs/applications.
      postingText: cleanLongText(postingText, MAX_POSTING_CHARS),
      fitSummary: cleanLongText(fitSummary, MAX_FIT_SUMMARY_CHARS),
      tailoredResume: cleanLongText(tailoredResume, MAX_ANSWER_CHARS),
      tailoredCoverLetter: cleanLongText(tailoredCoverLetter, MAX_ANSWER_CHARS),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.applications.push(application);
    writeState(state);
    return application;
  }

  function updateApplication(id, updates = {}) {
    const state = readState();
    const index = state.applications.findIndex((app) => app.id === id);
    if (index === -1) {
      return null;
    }

    const updated = { ...state.applications[index] };
    if (updates.company !== undefined) {
      const cleanCompany = cleanShortText(updates.company);
      if (!cleanCompany) {
        throw new Error("company cannot be empty");
      }
      updated.company = cleanCompany;
    }
    if (updates.role !== undefined) {
      const cleanRole = cleanShortText(updates.role);
      if (!cleanRole) {
        throw new Error("role cannot be empty");
      }
      updated.role = cleanRole;
    }
    if (updates.status !== undefined) {
      updated.status = normalizeStatus(updates.status);
    }
    if (updates.url !== undefined) {
      updated.url = cleanShortText(updates.url, 2000);
    }
    if (updates.notes !== undefined) {
      updated.notes = cleanLongText(updates.notes, MAX_NOTES_CHARS);
    }
    if (updates.appliedAt !== undefined) {
      updated.appliedAt = cleanShortText(updates.appliedAt) || updated.appliedAt;
    }
    if (updates.postingText !== undefined) {
      updated.postingText = cleanLongText(updates.postingText, MAX_POSTING_CHARS);
    }
    if (updates.fitSummary !== undefined) {
      updated.fitSummary = cleanLongText(updates.fitSummary, MAX_FIT_SUMMARY_CHARS);
    }
    if (updates.tailoredResume !== undefined) {
      updated.tailoredResume = cleanLongText(updates.tailoredResume, MAX_ANSWER_CHARS);
    }
    if (updates.tailoredCoverLetter !== undefined) {
      updated.tailoredCoverLetter = cleanLongText(
        updates.tailoredCoverLetter,
        MAX_ANSWER_CHARS,
      );
    }
    updated.updatedAt = now();

    state.applications[index] = updated;
    writeState(state);
    return updated;
  }

  function deleteApplication(id) {
    const state = readState();
    const next = state.applications.filter((app) => app.id !== id);
    if (next.length === state.applications.length) {
      return false;
    }
    state.applications = next;
    writeState(state);
    return true;
  }

  // --- Answers (resume bullets, project descriptions, canned Q&A) ---

  function listAnswers() {
    return readState().answers.slice().sort((a, b) =>
      String(a.key).localeCompare(String(b.key)),
    );
  }

  function getAnswer(key) {
    const cleanKey = cleanShortText(key, MAX_KEY_CHARS).toLowerCase();
    if (!cleanKey) return null;
    return (
      readState().answers.find((answer) => answer.key === cleanKey) || null
    );
  }

  // Upsert by key: answers are named, reusable content the caller expects
  // to overwrite in place (e.g. re-saving a refined draft) rather than
  // accumulate duplicates of.
  function saveAnswer({ key, content, label }) {
    const cleanKey = cleanShortText(key, MAX_KEY_CHARS).toLowerCase();
    const cleanContent = cleanLongText(content, MAX_ANSWER_CHARS);
    if (!cleanKey) {
      throw new Error("key is required");
    }
    if (!cleanContent) {
      throw new Error("content is required");
    }

    const state = readState();
    const timestamp = now();
    const index = state.answers.findIndex((answer) => answer.key === cleanKey);
    const existing = index === -1 ? null : state.answers[index];
    const answer = {
      key: cleanKey,
      // Omitting label on a re-save (e.g. just updating content) keeps the
      // previously set label rather than resetting it back to the key.
      label: cleanShortText(label) || existing?.label || cleanKey,
      content: cleanContent,
      createdAt: existing ? existing.createdAt : timestamp,
      updatedAt: timestamp,
    };

    if (index === -1) {
      state.answers.push(answer);
    } else {
      state.answers[index] = answer;
    }
    writeState(state);
    return answer;
  }

  function deleteAnswer(key) {
    const cleanKey = cleanShortText(key, MAX_KEY_CHARS).toLowerCase();
    const state = readState();
    const next = state.answers.filter((answer) => answer.key !== cleanKey);
    if (next.length === state.answers.length) {
      return false;
    }
    state.answers = next;
    writeState(state);
    return true;
  }

  return {
    dataDir,
    listApplications,
    getApplication,
    createApplication,
    updateApplication,
    deleteApplication,
    listAnswers,
    getAnswer,
    saveAnswer,
    deleteAnswer,
  };
}

module.exports = {
  MAX_SHORT_TEXT_CHARS,
  MAX_NOTES_CHARS,
  MAX_ANSWER_CHARS,
  MAX_KEY_CHARS,
  MAX_POSTING_CHARS,
  MAX_FIT_SUMMARY_CHARS,
  VALID_STATUSES,
  DEFAULT_STATUS,
  createJobApplicationsStore,
};
