// #1384: improvement proposals. Before Mana files an issue about her own
// improvement she checks what's already there (issues open and closed, PRs,
// roadmap notes, #1385 lessons), and she needs evidence. Nothing here ever
// closes, merges or edits anything, and a similarity score only suggests:
// a likely match is handed back to her to tell me, never acted on.
// Filing goes through its own approval type, bound to the exact payload I
// reviewed: the executor re-checks a digest of it.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { runCommand, stripAttribution } = require("./ai/git-tool-source");
const { sanitizeBridgeOutput } = require("./bridge-output-sanitizer");

// Its own action type: neither a remembered git-github grant nor the
// GitHub "off" setting covers it.
const IMPROVEMENT_ISSUE_ACTION = "improvement-issue";
const IMPROVEMENT_TOOL = "improvement__propose";
const MATCH_AT = 0.5;
const MAX_TITLE = 256;
const MAX_BODY = 20000;
const ROADMAP_FILES = ["INDEX.md", "active-issues.md"];
const ISSUE_FIELDS = "number,title,state,closedAt,url";

const STOPWORDS = new Set(
  "that this with from have will when what your they them then than into also just only more been were does done dont such each some very about after before again while whenever should could would there their which where these those being other over under".split(" "),
);

// Top n distinct words (4+ characters, no stopwords or bare numbers), longest first.
// ponytail: length stands in for rarity; add document frequency if it matches too loosely.
function keywords(text, n = 12) {
  const words = new Set(String(text || "").toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  return [...words]
    .filter((w) => !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .slice(0, n);
}

function overlap(a, b) {
  const other = new Set(b);
  const shared = a.filter((w) => other.has(w));
  const union = new Set([...a, ...b]).size;
  return { shared, score: union ? shared.length / union : 0 };
}

const digestOf = (p) => crypto.createHash("sha256").update(JSON.stringify({ title: p.title, body: p.body, labels: p.labels })).digest("hex");
const isOpen = (m) => m.state !== "closed" && m.state !== "merged";

function ghRunner(repoRoot) {
  return async (args) => {
    const r = await runCommand("gh", args, { cwd: repoRoot, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeoutMs: 60000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 300));
    return r.stdout;
  };
}

// gh: async (args) => stdout, throws on failure (a fake in tests).
// lessons: optional (#1385, not merged yet); assumed shape { listOpen(): [{ title, observed }] }.
function createIssueProposals({ gh, repoRoot = path.join(__dirname, ".."), approvalGate, lessons = null, env = process.env } = {}) {
  if (!approvalGate) throw new Error("approvalGate is required");
  const run = gh || ghRunner(repoRoot);
  const msg = (e) => String(e?.message || e).slice(0, 200);
  const outgoing = (text, max) => sanitizeBridgeOutput(stripAttribution(text), { env }).slice(0, max);
  const inflight = new Set();

  async function findRelated({ title, body }) {
    const text = `${title || ""}\n${body || ""}`;
    const mine = keywords(text);
    const matches = [];
    const limits = [];
    const seen = new Set();
    const add = (m) => {
      const key = `${m.kind}:${m.number ?? m.title}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push(m);
      }
    };
    const lower = (s) => String(s || "").toLowerCase();
    const asMatch = (kind, i, score, why) => ({ kind, number: i.number, title: i.title, state: lower(i.state), url: i.url, score, why });
    const searched = (kind, items, fullText) => {
      for (const i of items) {
        const { shared, score } = overlap(mine, keywords(fullText(i)));
        if (shared.length) add(asMatch(kind, i, score, `shared words: ${shared.join(", ")}`));
      }
    };

    // Exact references: an issue, else a PR.
    const refs = [...new Set([...text.matchAll(/#(\d{1,6})\b/g)].map((m) => m[1]))].slice(0, 10);
    for (const n of refs) {
      let found = null;
      for (const noun of ["issue", "pr"]) {
        try {
          found = JSON.parse(await run([noun, "view", n, "--json", ISSUE_FIELDS]));
          break;
        } catch {}
      }
      if (found) add(asMatch(/\/pull\//.test(found.url || "") ? "pr" : "issue", found, 1, `referenced as #${n}`));
      else limits.push(`#${n} lookup failed`);
    }

    const query = keywords(text, 6).join(" ");
    if (query) {
      try {
        const issues = JSON.parse(await run(["issue", "list", "--state", "all", "--search", query, "--json", `${ISSUE_FIELDS},body`, "--limit", "20"]));
        searched("issue", issues, (i) => `${i.title}\n${i.body || ""}`);
      } catch (e) {
        limits.push(`issue search failed: ${msg(e)}`);
      }
      try {
        const prs = JSON.parse(await run(["pr", "list", "--state", "all", "--search", query, "--json", "number,title,state,url", "--limit", "10"]));
        searched("pr", prs, (p) => p.title);
      } catch (e) {
        limits.push(`pr search failed: ${msg(e)}`);
      }
    }

    // Roadmap lines and open lessons sharing at least 2 keywords.
    const textual = (kind, label, why) => {
      const { shared, score } = overlap(mine, keywords(label));
      if (shared.length >= 2) add({ kind, title: label.trim().slice(0, 200), state: "", score, why: `${why}: ${shared.join(", ")}` });
    };
    for (const file of ROADMAP_FILES) {
      try {
        const lines = (await fs.promises.readFile(path.join(repoRoot, "docs", "roadmap", file), "utf8")).split(/\r?\n/);
        lines.filter(Boolean).forEach((line) => textual("roadmap", line, `${file}, shared words`));
      } catch {
        limits.push(`roadmap ${file} not readable`);
      }
    }
    if (lessons) {
      try {
        for (const l of await lessons.listOpen()) textual("lesson", `${l.title || ""} ${l.observed || ""}`.trim(), "open lesson, shared words");
      } catch (e) {
        limits.push(`lessons lookup failed: ${msg(e)}`);
      }
    }

    matches.sort((a, b) => b.score - a.score);
    const top = matches.slice(0, 15);
    // Only suggests: an open match to link, else a closed one that may have regressed.
    const strong = top.filter((m) => m.score >= MATCH_AT);
    const open = strong.find(isOpen);
    const closed = strong.find((m) => !isOpen(m));
    if (open) return { decision: "link", to: open, matches: top, limits };
    if (closed) return { decision: "reopen-or-regression", to: closed, matches: top, limits };
    return { decision: "new", matches: top, limits };
  }

  const similarPending = (title) =>
    approvalGate
      .listPending()
      .find((p) => p.actionType === IMPROVEMENT_ISSUE_ACTION && overlap(keywords(title, 99), keywords(p.payload?.title, 99)).score >= MATCH_AT);

  async function propose({ title, body, evidence }) {
    const t = outgoing(title, MAX_TITLE).split(/\r?\n/)[0].trim();
    const b = outgoing(body, MAX_BODY);
    const proof = (Array.isArray(evidence) ? evidence : []).map((e) => outgoing(e, 500).trim()).filter(Boolean);
    if (!t || !b) return { status: "refused", reason: "an improvement issue needs a title and a body" };
    if (!proof.length) return { status: "refused", reason: "an improvement issue needs evidence: a run, trace, test or log reference, or a URL" };
    const already = { status: "already-proposed", reason: "already proposed, waiting for approval" };
    const lockKey = t.toLowerCase().replace(/\W+/g, " ").trim();
    if (inflight.has(lockKey) || similarPending(t)) return already;
    inflight.add(lockKey);
    try {
      const related = await findRelated({ title: t, body: b });
      const { decision, matches, limits } = related;
      if (decision !== "new") {
        return { status: "not-filed", decision, to: related.to, matches, limits, note: "Not filed. Tell the user what it matches and let them decide." };
      }
      // Another proposal may have reached the approval queue while the search ran.
      if (similarPending(t)) return already;
      const labels = [];
      const full = outgoing(
        [
          b,
          "",
          "## Evidence",
          ...proof.map((e) => `- ${e}`),
          "",
          "## Related",
          ...(matches.length ? matches.map((m) => `- ${m.number ? `#${m.number} ` : ""}${m.title} (${m.kind}${m.state ? `, ${m.state}` : ""}; ${m.why})`) : ["- Nothing related found."]),
          ...limits.map((l) => `- Could not check: ${l}`),
        ].join("\n"),
        MAX_BODY,
      );
      const payload = { title: t, body: full, labels };
      payload.digest = digestOf(payload);
      const outcome = await approvalGate.requestApproval(IMPROVEMENT_ISSUE_ACTION, {
        summary: `Open an improvement issue: "${t}" (${proof.length} evidence item(s), ${matches.length} related checked)`,
        payload,
        grantKey: `${IMPROVEMENT_ISSUE_ACTION}:${payload.digest}`,
        forceReview: true,
      });
      if (outcome.status === "pending") {
        return { status: "pending-approval", requestId: outcome.requestId, decision, matches, limits, note: "It is filed once the user approves it in Approvals." };
      }
      if (outcome.status === "approved") return { status: "filed", decision, matches, limits, url: String(outcome.result || "").replace(/^Opened /, "") };
      return { status: outcome.status, reason: outcome.reason || "", decision, matches, limits };
    } finally {
      inflight.delete(lockKey);
    }
  }

  // What I approved is what gets filed: the digest must still match.
  approvalGate.registerExecutor(IMPROVEMENT_ISSUE_ACTION, async (p) => {
    if (!p || digestOf(p) !== p.digest) throw new Error("the issue changed after it was reviewed, so I didn't file it");
    const out = await run(["issue", "create", `--title=${p.title}`, `--body=${p.body}`, ...p.labels.map((l) => `--label=${l}`)]);
    return `Opened ${out.trim().split(/\s+/).pop()}`;
  });

  return { findRelated, propose };
}

// Her chat only; #1386's idle proposals can use the same tool later.
function createImprovementToolSource(proposals) {
  const schema = {
    type: "function",
    function: {
      name: IMPROVEMENT_TOOL,
      description:
        "Propose a GitHub issue for an improvement to yourself. It checks open and closed issues, PRs, roadmap notes and lessons first, and links to what exists instead of duplicating it; if something matches, nothing is filed, so tell the user and let them decide. It never closes, merges or edits anything. Evidence is required (a run, trace, test or log reference, or a URL). If nothing matches, the issue waits for the user's approval of exactly this text.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The issue title." },
          body: { type: "string", description: "What to improve and why." },
          evidence: { type: "array", items: { type: "string" }, description: "At least one run, trace, test or log reference, or URL." },
        },
        required: ["title", "body", "evidence"],
      },
    },
  };
  return {
    listToolSchemas: () => [schema],
    isKnownToolName: (name) => name === IMPROVEMENT_TOOL,
    async executeTool(name, args = {}) {
      if (name !== IMPROVEMENT_TOOL) throw new Error(`unknown improvement tool: ${name}`);
      try {
        return JSON.stringify(await proposals.propose({ title: args.title, body: args.body, evidence: args.evidence }));
      } catch (e) {
        return JSON.stringify({ status: "error", error: e.message || String(e) });
      }
    },
  };
}

module.exports = {
  IMPROVEMENT_ISSUE_ACTION,
  IMPROVEMENT_TOOL,
  createImprovementToolSource,
  createIssueProposals,
};
