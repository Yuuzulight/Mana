// #664 (Q21): import a skill from a link. Only these sites, over https;
// a redirect elsewhere is refused too. The download is a zip read with the
// zip import's rules and limits (readSkillZipBuffer) and goes through the
// same forceReview approval. Before that, the npm/PyPI packages the skill
// says it installs (metadata.openclaw.install) are checked against OSV like
// MCP packages (#772): a MAL- hit refuses the import; OSV unreachable
// allows it with a warning (Q24).
const { parseSkillFile, readSkillZipBuffer, MAX_ZIP_BYTES } = require("./skills-store");
const { assertNoMalwareIn, parseSpec } = require("./osv-malware-check");

const SKILL_LINK_HOSTS = ["github.com", "codeload.github.com", "clawhub.ai"];
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 30000;
// OpenClaw install kinds that pull a registry package.
const INSTALL_ECOSYSTEMS = { node: "npm", npm: "npm", uv: "PyPI", pip: "PyPI", python: "PyPI" };

function allowedUrl(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new Error(`not a link: ${link}`);
  }
  if (url.protocol !== "https:") throw new Error(`only https links can be imported: ${link}`);
  if (!SKILL_LINK_HOSTS.includes(url.hostname)) {
    throw new Error(`${url.hostname} isn't one of the sites skills can be imported from (${SKILL_LINK_HOSTS.join(", ")})`);
  }
  return url;
}

// A GitHub repo, folder (/tree/<ref>/<path>) or SKILL.md (/blob/...) link
// becomes that repo's zip plus the folder to read inside it. A ref with a
// "/" in it isn't supported (the rest is read as the path). Any other
// allowed link is downloaded as it is and must be a zip.
function resolveSkillLink(link) {
  const url = allowedUrl(link);
  if (url.hostname === "github.com") {
    const [owner, repo, kind, ref, ...rest] = url.pathname.split("/").filter(Boolean);
    if (owner && repo && (!kind || kind === "tree" || kind === "blob")) {
      if (kind === "blob" && rest[rest.length - 1] === "SKILL.md") rest.pop();
      return {
        url: `https://codeload.github.com/${owner}/${repo.replace(/\.git$/, "")}/zip/${kind ? ref : "HEAD"}`,
        subdir: kind ? rest.join("/") : "",
      };
    }
  }
  return { url: url.href, subdir: "" };
}

async function downloadZip(link, fetchImpl) {
  let current = link;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { hostname } = allowedUrl(current);
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) throw new Error(`${hostname} answered HTTP ${response.status}`);
    const tooBig = new Error(`the download is larger than ${MAX_ZIP_BYTES / 1024 / 1024} MB`);
    if (Number(response.headers.get("content-length")) > MAX_ZIP_BYTES) throw tooBig;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_ZIP_BYTES) throw tooBig;
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("too many redirects");
}

function declaredPackages(skillMd) {
  const metadata = parseSkillFile(skillMd, "skill").extra?.metadata;
  const gate = metadata && typeof metadata === "object" ? metadata.openclaw || metadata.clawdbot : null;
  const installs = Array.isArray(gate?.install) ? gate.install : [];
  return installs.flatMap((spec) => {
    const ecosystem = INSTALL_ECOSYSTEMS[String(spec?.kind || "").toLowerCase()];
    const pkg = ecosystem && typeof spec.package === "string" ? parseSpec(ecosystem, spec.package.trim()) : null;
    return pkg ? [pkg] : [];
  });
}

// What readSkillFolder/readSkillZip return, plus the link and a line on
// what the malware check found, for the approval summary.
async function readSkillLink(link, { fetchImpl = fetch } = {}) {
  const { url, subdir } = resolveSkillLink(String(link || "").trim());
  const zip = await downloadZip(url, fetchImpl);
  const skill = readSkillZipBuffer(zip, "the download", subdir);
  const packages = declaredPackages(skill.files.find((file) => file.path === "SKILL.md").content);
  const answered = await assertNoMalwareIn(packages, { fetchImpl });
  const names = packages.map((p) => `${p.ecosystem}:${p.name}`).join(", ");
  return {
    ...skill,
    source: link,
    malwareCheck: !packages.length
      ? "no packages declared"
      : answered
        ? `OSV knows no malware in ${names}`
        : `skipped for ${names} (OSV unreachable)`,
  };
}

module.exports = { SKILL_LINK_HOSTS, readSkillLink, resolveSkillLink };
