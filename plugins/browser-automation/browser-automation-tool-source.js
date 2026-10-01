// Issue #188: exposes browser-automation's navigate/click/type/snapshot as
// tool-calling schemas, reusing the same live session index.js's own HTTP
// routes use (its exported getSession) -- a tool-calling-initiated browser
// action and an HTTP-route-initiated one operate on the same tab, not two
// separate Chromium instances.
const { createBrowserActivityLog } = require("./browser-automation-activity");
const { wrapUntrusted } = require("../../node-bot/ai/untrusted-content");
const { blockedNote } = require("./browser-automation");
const { createBrowserDownloads } = require("./browser-downloads");
const { reportMarkdown, reportSummary } = require("./site-test");
const SITE_TEST_SIZES = ["phone", "tablet", "desktop"];
const MAX_SITE_TEST_PAGES = 5;
const trayNotifier = require("../../node-bot/tray-notifier");

const BROWSER_TOOL_PREFIX = "browser_automation__";
// Gates the *first* tool-calling use, not every individual call -- once a
// human "always-allow"s this actionType, subsequent navigate/click/type/
// snapshot calls execute immediately, same as approval-gate.js's existing
// design for any other already-trusted action. Blocking every single call
// on a human would freeze the tool-calling loop mid-reply, which nothing
// else in this codebase does either (read_file has never needed approval;
// an MCP server's tools are approved once, at registration, not per call).
const APPROVAL_ACTION_TYPE = "browser-automation-tool-use";
// #1154: before she clicks, types or selects on a site the first time, I'm
// asked (allow once / for the session / always / deny / never), per site.
// Reading, scrolling and going back never ask.
const SITE_ACTION_TYPE = "browser-site";
const JS_ACTION_TYPE = "browser-js";
// #1161: her dev tools too, on any site she's allowed to act on.
const ACTS_ON_SITE = new Set(["click", "type", "select", "press", "drag", "upload", "look_and_click", "devtools"]);

// "shop.example.com" from a page URL (www. dropped), or null off the web.
function siteOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : null;
  } catch (e) {
    return null;
  }
}

const REF_PARAM = { type: "string", description: "The element's ref from the page snapshot, like e5." };
function tool(name, description, properties = {}, required = []) {
  return {
    type: "function",
    function: { name: `${BROWSER_TOOL_PREFIX}${name}`, description, parameters: { type: "object", properties, required } },
  };
}

// #1138: a small vocabulary, acting by the snapshot's refs.
const TOOL_SCHEMAS = [
  tool("navigate", "Open an http(s) URL in her browser and read the page.", {
    url: { type: "string", description: "The http(s) URL to open." },
  }, ["url"]),
  tool("find", "Find elements on the page by description (like \"the Sign in button\" or \"the search box\"): the best matches with their refs.", {
    description: { type: "string", description: "What you're looking for, in a few words." },
  }, ["description"]),
  tool("snapshot", "Read the current page again: its interactive elements with their refs, and a short text excerpt."),
  tool("click", "Click an element by its ref.", { ref: REF_PARAM }, ["ref"]),
  tool("type", "Replace the text in a field by its ref; submit presses Enter after.", {
    ref: REF_PARAM,
    text: { type: "string", description: "The text to put in the field." },
    submit: { type: "boolean", description: "Press Enter after typing (e.g. to search)." },
  }, ["ref", "text"]),
  tool("select", "Choose an option in a dropdown by its ref.", {
    ref: REF_PARAM,
    value: { type: "string", description: "The option's label or value." },
  }, ["ref", "value"]),
  tool("scroll", "Scroll the page by most of a screen, to load more of it.", {
    direction: { type: "string", enum: ["down", "up"] },
  }, ["direction"]),
  tool("hover", "Move the mouse over an element by its ref, e.g. to open a menu.", { ref: REF_PARAM }, ["ref"]),
  tool("press", "Press a key or an editing shortcut: Enter, Escape, Tab, arrows, Home/End, PageUp/PageDown, Backspace, Delete, Space, a letter, with Shift, or Ctrl+A/Z/Y/B/I/U.", {
    key: { type: "string", description: 'Like "Enter", "Escape", "Shift+Tab", "Ctrl+A".' },
    ref: { type: "string", description: "Optional: the element to press it on; otherwise wherever the focus is." },
  }, ["key"]),
  tool("drag", "Drag one element onto another by their refs (sliders, reordering).", {
    from: REF_PARAM,
    to: { type: "string", description: "The ref of where to drop it." },
  }, ["from", "to"]),
  tool("back", "Go back to the previous page."),
  // #1161
  tool("devtools", "Developer tools on the current page: read its console (errors first) or network (failed and slow requests), run a JavaScript expression, switch to a phone/tablet/desktop size or light/dark mode, or look at it with your eyes and describe it.", {
    do: { type: "string", enum: ["console", "network", "run_js", "viewport", "color_scheme", "look"] },
    code: { type: "string", description: "For run_js: one JavaScript expression; its value comes back as JSON." },
    size: { type: "string", enum: ["phone", "tablet", "desktop"] },
    scheme: { type: "string", enum: ["light", "dark"] },
    question: { type: "string", description: "For look: what to look at or check." },
  }, ["do"]),
  tool("test_site", "Test web pages (the user's site, or one they name): each page at phone, tablet and desktop size, for console errors, failed requests, broken links, layout that breaks out of the window, and basic accessibility (alt text, labels, contrast), with screenshots. You get the counts; the user gets the full report in the Browser panel.", {
    urls: { type: "array", items: { type: "string" }, maxItems: MAX_SITE_TEST_PAGES, description: "The pages to test, http(s)." },
    sizes: { type: "array", items: { type: "string", enum: SITE_TEST_SIZES }, description: "Optional: only these sizes." },
  }, ["urls"]),
  // #1157
  tool("look_and_click", "Last resort when find and the snapshot can't see what you need (a canvas app, unlabeled buttons): look at the page with your eyes and click where it is. Slower; not while the user is gaming.", {
    description: { type: "string", description: "What to click, as it looks on screen, like \"the green Play button\"." },
  }, ["description"]),
  // #1158
  tool("upload", "Put a file into a page's upload field or button, by its ref. Only a file the user pointed you to: its full path from their message, or one they gave you in the Browser panel.", {
    ref: REF_PARAM,
    file: { type: "string", description: "The file's full path, as the user gave it." },
  }, ["ref", "file"]),
  // #1159
  tool("tab", "Work with tabs (a few at most, e.g. to compare pages): open one at a URL, switch to one, or close one. With more than one open, every answer lists them.", {
    do: { type: "string", enum: ["open", "switch", "close"] },
    url: { type: "string", description: "For open: the http(s) URL." },
    number: { type: "integer", description: "For switch and close: the tab's number in the list." },
  }, ["do"]),
  // #1139: the user takes over in a visible window and presses Done.
  tool("hand_over", "Ask the user to take over the browser: for a login, a CAPTCHA, a payment or account change, or when you're stuck. You never type passwords or pay.", {
    reason: { type: "string", description: "What they need to do, short." },
  }, ["reason"]),
];
const ACTIONS = TOOL_SCHEMAS.map((t) => t.function.name.slice(BROWSER_TOOL_PREFIX.length));

// #1160: up to five steps in one call. A step is any action but hand_over
// (she says that herself) with that action's own arguments.
const MAX_BATCH_STEPS = 5;
const BATCH_ACTIONS = ACTIONS.filter((a) => a !== "hand_over");
const stepArgs = Object.assign({}, ...TOOL_SCHEMAS.map((t) => t.function.parameters.properties));
TOOL_SCHEMAS.push(
  tool("batch", `Run up to ${MAX_BATCH_STEPS} browser steps in one go. It stops at the first step that fails or needs the user's OK, and then shows the page as it is.`, {
    steps: {
      type: "array",
      maxItems: MAX_BATCH_STEPS,
      items: {
        type: "object",
        properties: { action: { type: "string", enum: BATCH_ACTIONS }, ...stepArgs },
        required: ["action"],
      },
    },
  }, ["steps"]),
);

// #1157: the vision model's "x,y" (or NONE) inside the screenshot, or null.
// Its answer is a few tokens; the cap keeps the regex short whatever comes.
function parsePoint(answer, width, height) {
  const text = String(answer || "").slice(0, 200);
  const match = /(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/.exec(text);
  if (!match || /\bnone\b/i.test(text)) return null;
  const [x, y] = [Number(match[1]), Number(match[2])];
  return x >= 0 && y >= 0 && x < width && y < height ? { x: Math.round(x), y: Math.round(y) } : null;
}

// What the model reads: everything from the page sits inside one untrusted
// frame.
function describeForModel(result) {
  const lines = [`URL: ${result.url}`, `Title: ${result.title}`, ...(result.tabs ? ["Tabs:", ...result.tabs] : []), ""];
  if (result.siteTest) {
    lines.push("Site test (the full report, with screenshots, is in the user's Browser panel):", result.siteTest);
  } else if (result.devtools) {
    lines.push(`${result.what}:`, ...(result.devtools.length ? result.devtools : ["(nothing)"]));
  } else if (result.matches) {
    lines.push(result.matches.length ? `Best matches for "${result.description}":` : `Nothing on the page matches "${result.description}".`, ...result.matches);
  } else if (result.elements) {
    lines.push("Interactive elements:", ...result.elements);
  } else if (result.added.length || result.removed.length) {
    lines.push("Changed elements (the rest are as in the last snapshot):");
    lines.push(...result.added.map((l) => `new: ${l}`), ...result.removed.map((l) => `gone: ${l}`));
  } else {
    lines.push("The elements didn't change.");
  }
  if (result.text !== undefined) lines.push("", "Page text (start):", result.text);
  // Outside the frame: this is Mana's code talking, not the page.
  const notes = [wrapUntrusted("browser page", lines.join("\n"))];
  if (result.sensitive) {
    notes.push(`This page asks for ${result.sensitive}. That's the user's to do: don't click or type here. The Browser panel now asks them to take over; tell them and wait.`);
  }
  // #1168
  if (result.blockedMayBreak) notes.push(`Note: ${blockedNote(result.blockedMayBreak)}.`);
  return notes.join("\n");
}

function isBrowserAutomationToolName(name) {
  return typeof name === "string" && name.startsWith(BROWSER_TOOL_PREFIX);
}

// options.getSession: browser-automation/index.js's exported getSession.
// options.approvalGate: required -- gates first tool-calling use.
// options.sessionDeps: forwarded to getSession() (env/chromium overrides).
// options.activityLog: issue #418's human-facing activity feed -- defaults
// to a fresh one, but server.js passes a shared instance so its own
// GET /browser-automation/activity route reads from the same log this
// tool source writes to.
function createBrowserAutomationToolSource(options = {}) {
  const getSession = options.getSession;
  const approvalGate = options.approvalGate;
  const sessionDeps = options.sessionDeps || {};
  const activityLog = options.activityLog || createBrowserActivityLog();
  // #1139: flags "she needs you" in the Browser panel (plugin index.js).
  const requestHandOver = options.requestHandOver || (() => {});
  // #1157: her own vision model, (prompt, images, maxTokens) => text.
  const runVisionReply = options.runVisionReply || null;

  // #1161: her vision model describing a screenshot -- off while gaming.
  async function lookAt(image, question) {
    if (sessionDeps.isGaming?.()) throw new Error("looking at the page is off while the user is gaming");
    if (!runVisionReply) throw new Error("no vision model is set up for looking at pages");
    return runVisionReply(`This is a screenshot of a web page. ${question}`, [image], 400);
  }

  // #1161: "Test this site". Every site in it needs her permission (#1154),
  // like the rest of her dev tools.
  async function testSite(session, args = {}) {
    const urls = [].concat(args.urls || []).map(String);
    if (urls.length < 1 || urls.length > MAX_SITE_TEST_PAGES) throw new Error(`name 1 to ${MAX_SITE_TEST_PAGES} pages to test`);
    const sizes = Array.isArray(args.sizes) && args.sizes.length ? args.sizes : SITE_TEST_SIZES;
    for (const url of urls) {
      if (!siteOf(url)) throw new Error(`"${url}" isn't a web page`);
      await requireSitePermission(url);
    }
    const pages = [];
    for (const url of urls) pages.push(await session.testPage(url, sizes));
    const report = { site: siteOf(urls[0]), when: new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }), pages };
    activityLog.recordSiteTest(reportMarkdown(report));
    const last = pages[pages.length - 1];
    return { url: last.url, title: last.title, siteTest: reportSummary(report) };
  }

  async function lookAndClick(session, description) {
    const what = String(description || "").trim();
    if (!what) throw new Error("say what to click, like \"the green Play button\"");
    if (sessionDeps.isGaming?.()) throw new Error("looking at the page is off while the user is gaming; use find and click");
    if (!runVisionReply) throw new Error("no vision model is set up for looking at pages");
    // Only a fallback: if the snapshot can see it, a ref is cheaper and surer.
    const found = await session.find(what);
    if (found.matches.length) {
      throw new Error(`the page's elements already match that; click one by its ref instead: ${found.matches.join("; ")}`);
    }
    return session.lookAndClick(what, async (image, width, height) => {
      const answer = await runVisionReply(
        `This is a ${width}x${height} screenshot of a web page. Where is this: "${what}"? Answer with only the pixel coordinates of its center as x,y (like 412,230), or NONE if it isn't there.`,
        [image],
        32,
      );
      return parsePoint(answer, width, height);
    });
  }
  // #1158: each download waits for my OK; the chat shows where it went.
  const downloads = createBrowserDownloads({
    approvalGate,
    dir: options.downloadDir,
    pendingDir: options.pendingDownloadDir,
    notify: options.notifyTray || trayNotifier.notifyTray,
  });
  function onDownload(download) {
    return downloads.handle(download).then(
      ({ name }) => activityLog.recordActivity({ action: "download", args: { name }, status: "ok" }),
      (err) => activityLog.recordActivity({ action: "download", args: {}, status: "error", error: err.message }),
    );
  }

  if (!approvalGate) {
    throw new Error("an approvalGate is required");
  }
  approvalGate.registerExecutor(APPROVAL_ACTION_TYPE, async () => ({ approved: true }));
  // "Allow once" lets her next action of that kind on that site through.
  const allowedOnce = new Set();

  // One action type per site, so the gate's grants, "never" and its
  // three-denials stop are all per site. js: running JavaScript there
  // (#1161's run_js), asked for on its own -- allowing a site for clicks
  // doesn't allow scripts.
  async function requireSitePermission(pageUrl, js = false) {
    const site = siteOf(pageUrl);
    if (!site) throw new Error("open a web page first");
    const actionType = `${js ? JS_ACTION_TYPE : SITE_ACTION_TYPE}:${site}`;
    const doing = js ? "running JavaScript" : "clicking or typing";
    if (approvalGate.isGranted(actionType) || allowedOnce.delete(actionType)) return;
    approvalGate.registerExecutor(actionType, async () => {
      allowedOnce.add(actionType);
      return { approved: true };
    });
    const result = await approvalGate.requestApproval(actionType, {
      summary: js ? `Let Mana run JavaScript on ${site}` : `Let Mana click and type on ${site}`,
      payload: { site },
    });
    if (result.status === "approved") {
      allowedOnce.delete(actionType);
      return;
    }
    throw new Error(
      result.status === "pending"
        ? `${doing} on ${site} needs the user's OK first (request ${result.requestId}); tell them, and try again once they allow it. Reading pages there doesn't need it.`
        : result.never
          ? `the user said never for ${doing} on ${site}; don't do it there`
          : `${doing} on ${site} isn't allowed: ${result.reason || "denied"}`,
    );
  }

  function listToolSchemas() {
    return TOOL_SCHEMAS;
  }

  async function executeTool(qualifiedName, args) {
    // isGranted, not isAlwaysAllowed: an "allow for this session" (#669)
    // counts too.
    if (!approvalGate.isGranted(APPROVAL_ACTION_TYPE)) {
      // Not yet trusted -- ask, and report back through the same
      // error-to-the-model path runToolAwareReply already uses for a
      // failed tool call (see tool-policy.js's ToolPolicyError handling),
      // rather than blocking this call on a human decision.
      const result = await approvalGate.requestApproval(APPROVAL_ACTION_TYPE, {
        summary: "Allow Mana to use browser-automation (open, read, click, type, select, scroll, back, hand over) as a tool during replies",
        payload: null,
      });
      throw new Error(
        result.status === "pending"
          ? `browser-automation tool use needs approval first (request ${result.requestId}) -- see GET /approvals/pending`
          : "browser-automation tool use is not approved",
      );
    }

    const action = qualifiedName.slice(BROWSER_TOOL_PREFIX.length);
    if (action !== "batch" && !ACTIONS.includes(action)) {
      throw new Error(`unknown browser-automation tool: ${qualifiedName}`);
    }

    if (action === "hand_over") {
      requestHandOver(args?.reason, sessionDeps);
      activityLog.recordActivity({ action, args, status: "ok" });
      return "The Browser panel now asks the user to take over. Tell them what's needed and wait; once they press Done, the browser is yours again with their login kept.";
    }
    // #1137: her page loads images only while the Browser panel watches.
    const session = await getSession({ ...sessionDeps, isWatched: activityLog.isWatched, onDownload });
    if (action === "batch") return runBatch(session, args?.steps);
    const result = await act(session, action, args);
    await recordScreenshot(session);
    return describeForModel(result);
  }

  // #1160: each step as if called alone (site permission, activity feed);
  // the first failure or needed approval ends the batch with a fresh look
  // at the page so she can recover.
  async function runBatch(session, steps) {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_BATCH_STEPS) {
      throw new Error(`a batch has 1 to ${MAX_BATCH_STEPS} steps`);
    }
    let result;
    for (const [i, step] of steps.entries()) {
      const stepAction = step?.action;
      try {
        if (!BATCH_ACTIONS.includes(stepAction)) throw new Error(`"${stepAction}" isn't a step a batch can take`);
        result = await act(session, stepAction, step);
      } catch (e) {
        const now = await session.snapshot().catch(() => null);
        await recordScreenshot(session);
        const head = `Step ${i + 1} of ${steps.length} (${stepAction}) didn't go through: ${e.message}\nThe batch stopped there${i ? ` after ${i} step${i === 1 ? "" : "s"}` : ""}.`;
        return now ? `${head}\n${describeForModel(now)}` : head;
      }
    }
    await recordScreenshot(session);
    return `All ${steps.length} steps went through.\n${describeForModel(result)}`;
  }

  // One action: the site check, the step itself and the activity feed.
  async function act(session, action, args) {
    let result;
    try {
      if (ACTS_ON_SITE.has(action)) await requireSitePermission(await session.url());
      if (action === "devtools" && args?.do === "run_js") await requireSitePermission(await session.url(), true);
      if (action === "navigate") result = await session.navigate(args?.url);
      else if (action === "snapshot") result = await session.snapshot();
      else if (action === "find") result = await session.find(args?.description);
      else if (action === "click") result = await session.click(args?.ref);
      else if (action === "type") result = await session.type(args?.ref, args?.text, args?.submit === true);
      else if (action === "select") result = await session.select(args?.ref, args?.value);
      else if (action === "scroll") result = await session.scroll(args?.direction);
      else if (action === "hover") result = await session.hover(args?.ref);
      else if (action === "press") result = await session.press(args?.key, args?.ref);
      else if (action === "drag") result = await session.drag(args?.from, args?.to);
      else if (action === "tab") result = await session.tab(args);
      else if (action === "upload") result = await session.upload(args?.ref, args?.file);
      else if (action === "look_and_click") result = await lookAndClick(session, args?.description);
      else if (action === "devtools") result = await session.devtools(args, lookAt);
      else if (action === "test_site") result = await testSite(session, args);
      else result = await session.back();
    } catch (err) {
      // Issue #418: the launcher's activity feed should show a failed step
      // too ("clicking element 5 -- failed"), not just successful ones --
      // the human watching benefits from seeing where it got stuck. The
      // real error still propagates to the model unchanged.
      activityLog.recordActivity({ action, args, status: "error", error: err.message });
      if (err.blockedMayBreak) activityLog.recordBlocked(await session.url(), err.blockedMayBreak);
      throw err;
    }

    activityLog.recordActivity({ action, args, status: "ok" });
    activityLog.recordPage(result);
    activityLog.recordBlocked(result.url, result.blockedMayBreak || 0);
    if (result.sensitive) requestHandOver(`This page asks for ${result.sensitive}.`, sessionDeps);
    return result;
  }

  async function recordScreenshot(session) {
    // Screenshots are for the Browser panel only, taken while it's on
    // screen. Best-effort: a capture failure (page mid-navigation, tab
    // closed) must never break the real tool call it happened alongside.
    // Wrapped in try/catch, not just a .catch() on the call, so a session
    // that doesn't even expose screenshot as a function (a synchronous
    // TypeError, not a rejected promise) is caught the same way.
    // An unwatched step clears the old one: it showed an earlier page.
    let screenshotBase64 = null;
    try {
      if (activityLog.isWatched()) screenshotBase64 = await session.screenshot();
    } catch (e) {
      screenshotBase64 = null;
    }
    activityLog.recordScreenshot(screenshotBase64);
  }

  return {
    listToolSchemas,
    executeTool,
    isKnownToolName: isBrowserAutomationToolName,
    activityLog,
  };
}

// Same merge shape #169's buildToolPolicyWithMcp already established --
// combines a base {tools, isKnownTool, executeTool} policy with this
// source's tools into one object matching that exact shape.
async function buildToolPolicyWithBrowserAutomation(basePolicy, browserToolSource) {
  return {
    tools: [...basePolicy.tools, ...browserToolSource.listToolSchemas()],
    isKnownTool: (name) => basePolicy.isKnownTool(name) || isBrowserAutomationToolName(name),
    executeTool: async (name, args) => {
      if (isBrowserAutomationToolName(name)) return browserToolSource.executeTool(name, args);
      return basePolicy.executeTool(name, args);
    },
  };
}

module.exports = {
  BROWSER_TOOL_PREFIX,
  APPROVAL_ACTION_TYPE,
  SITE_ACTION_TYPE,
  TOOL_SCHEMAS,
  describeForModel,
  parsePoint,
  isBrowserAutomationToolName,
  createBrowserAutomationToolSource,
  buildToolPolicyWithBrowserAutomation,
};
