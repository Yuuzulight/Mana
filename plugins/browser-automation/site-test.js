// #1161: "Test this site" -- each page I name at each size: console errors,
// failed requests, broken links, layout that breaks out of the window, and
// basic accessibility (missing alt text and labels, unnamed buttons, low
// contrast), with a screenshot of each. The report is Markdown with its
// screenshots as data: images, which the Browser panel draws with Folio.

const MAX_LINKS = 25;

// Runs in the page. ponytail: first-pass checks a page can answer by
// itself, not a full audit (axe-core would be the upgrade).
function inspectInPage() {
  const root = document.documentElement;
  const layout = [];
  if (root.scrollWidth > window.innerWidth + 1) {
    layout.push(`the page is ${root.scrollWidth}px wide in a ${window.innerWidth}px window (it scrolls sideways)`);
  }
  let sticking = 0;
  for (const el of [...(document.body?.querySelectorAll("*") || [])].slice(0, 3000)) {
    const box = el.getBoundingClientRect();
    if (box.width > 0 && box.right > window.innerWidth + 1 && getComputedStyle(el).position !== "fixed") sticking += 1;
  }
  if (sticking) layout.push(`${sticking} elements stick out past the right edge`);

  const a11y = [];
  const noAlt = [...document.images].filter((img) => !img.hasAttribute("alt")).length;
  if (noAlt) a11y.push(`${noAlt} images without alt text`);
  const fields = [...document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea')];
  const unlabeled = fields.filter((f) => !f.labels?.length && !f.getAttribute("aria-label") && !f.getAttribute("aria-labelledby") && !f.getAttribute("title")).length;
  if (unlabeled) a11y.push(`${unlabeled} form fields without a label`);
  const unnamed = [...document.querySelectorAll("button, a[href]")].filter(
    (el) => !(el.textContent || "").trim() && !el.getAttribute("aria-label") && !el.getAttribute("title") && !el.querySelector('img[alt]:not([alt=""])'),
  ).length;
  if (unnamed) a11y.push(`${unnamed} buttons or links without a name`);

  // WCAG contrast: 4.5:1, or 3:1 for large text.
  const rgb = (value) => (value.match(/[\d.]+/g) || []).map(Number);
  const luminance = ([r, g, b]) =>
    [r, g, b].map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const background = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const bg = rgb(getComputedStyle(node).backgroundColor);
      if (bg.length >= 3 && (bg.length < 4 || bg[3] > 0.5)) return bg;
    }
    return [255, 255, 255];
  };
  let lowContrast = 0;
  let example = "";
  const texts = [...document.querySelectorAll("p, span, a, li, h1, h2, h3, h4, h5, h6, button, label, td, th")].slice(0, 600);
  for (const el of texts) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own || !el.getClientRects().length) continue;
    const style = getComputedStyle(el);
    const [l1, l2] = [luminance(rgb(style.color)), luminance(background(el))].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) {
      lowContrast += 1;
      example = example || el.textContent.trim().slice(0, 40);
    }
  }
  if (lowContrast) a11y.push(`${lowContrast} text elements with low contrast, e.g. "${example}"`);

  const links = [...new Set([...document.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => /^https?:/.test(h)))];
  return { layout, a11y, links };
}

function problemCount(check) {
  return check.consoleErrors.length + check.failedRequests.length + check.layout.length + check.a11y.length;
}

// report: { site, when, pages: [{ url, title, sizes: [{ size, width, height,
// consoleErrors, failedRequests, layout, a11y, screenshot }], brokenLinks,
// linksChecked }] } -> { title, text (Markdown), images }.
function reportMarkdown(report) {
  const images = {};
  const checks = report.pages.flatMap((p) => p.sizes);
  const problems = checks.reduce((n, c) => n + problemCount(c), 0) + report.pages.reduce((n, p) => n + p.brokenLinks.length, 0);
  const title = `Site test: ${report.site}`;
  const lines = [
    `# ${title}`,
    "",
    `${report.when} · ${report.pages.length} page${report.pages.length === 1 ? "" : "s"} × ${report.pages[0]?.sizes.length || 0} sizes · ${problems ? `${problems} problem${problems === 1 ? "" : "s"}` : "no problems found"}`,
  ];
  const list = (label, items) => (items.length ? [`- **${label}** (${items.length}):`, ...items.slice(0, 10).map((i) => `  - ${i}`)] : [`- ${label}: none`]);
  for (const page of report.pages) {
    lines.push("", `## ${page.title || page.url}`, page.url);
    for (const check of page.sizes) {
      const id = `shot-${Object.keys(images).length + 1}`;
      if (check.screenshot) images[id] = check.screenshot;
      lines.push("", `### ${check.size} (${check.width}×${check.height})`);
      if (check.screenshot) lines.push(`![${check.size} screenshot](${id})`, "");
      lines.push(...list("Console errors", check.consoleErrors), ...list("Failed requests", check.failedRequests), ...list("Layout", check.layout), ...list("Accessibility", check.a11y));
    }
    lines.push("", ...list(`Broken links (${page.linksChecked} checked)`, page.brokenLinks));
  }
  return { title, text: lines.join("\n"), images };
}

// What the model gets: the counts, not the screenshots.
function reportSummary(report) {
  return report.pages
    .map((page) =>
      [
        `${page.url}:`,
        ...page.sizes.map(
          (c) =>
            `  ${c.size}: ${c.consoleErrors.length} console errors, ${c.failedRequests.length} failed requests, ${c.layout.length ? c.layout.join("; ") : "layout ok"}, ${c.a11y.length ? c.a11y.join("; ") : "no accessibility problems found"}`,
        ),
        `  broken links: ${page.brokenLinks.length ? page.brokenLinks.join(", ") : `none of ${page.linksChecked}`}`,
      ].join("\n"),
    )
    .join("\n");
}

module.exports = { inspectInPage, reportMarkdown, reportSummary, MAX_LINKS };
