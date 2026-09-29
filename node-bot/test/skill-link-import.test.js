const assert = require("node:assert/strict");
const test = require("node:test");

const { readSkillLink, resolveSkillLink } = require("../skill-link-import");
const { OSV_QUERYBATCH_URL } = require("../osv-malware-check");
const { makeZip } = require("./helpers");

// #664 (Q21): link import. A fake fetch stands in for the sites and OSV.
function skillMd(install) {
  const metadata = install ? `metadata: {"openclaw": {"install": ${JSON.stringify(install)}}}\n` : "";
  return `---\nname: weather\ndescription: Get the weather.\n${metadata}---\nUse scripts/get.sh.\n`;
}

const repoZip = (md) =>
  makeZip([
    { name: "skills-main/README.md", data: "repo" },
    { name: "skills-main/weather/SKILL.md", data: md },
    { name: "skills-main/weather/scripts/get.sh", data: "curl wttr.in\n" },
  ]);

function fakeFetch({ zip, osv }) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(String(url));
    if (url === OSV_QUERYBATCH_URL) return osv(JSON.parse(options.body));
    if (url === "https://github.com/o/skills/archive/main.zip") {
      return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/o/skills/zip/main" } });
    }
    if (url === "https://clawhub.ai/bad-redirect") {
      return new Response(null, { status: 302, headers: { location: "https://evil.example/skill.zip" } });
    }
    if (url.startsWith("https://codeload.github.com/o/skills/zip/")) return new Response(zip);
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

test("resolveSkillLink maps GitHub folder and SKILL.md links to the repo zip", () => {
  assert.deepEqual(resolveSkillLink("https://github.com/o/skills/tree/main/weather"), {
    url: "https://codeload.github.com/o/skills/zip/main",
    subdir: "weather",
  });
  assert.deepEqual(resolveSkillLink("https://github.com/o/skills/blob/main/weather/SKILL.md").subdir, "weather");
  assert.deepEqual(resolveSkillLink("https://github.com/o/skills"), {
    url: "https://codeload.github.com/o/skills/zip/HEAD",
    subdir: "",
  });
});

test("only https links on the allowed sites are downloaded, redirects included", async () => {
  const { fetchImpl, calls } = fakeFetch({ zip: repoZip(skillMd()) });
  await assert.rejects(readSkillLink("https://evil.example/skill.zip", { fetchImpl }), /isn't one of the sites/);
  await assert.rejects(readSkillLink("https://github.com.evil.example/o/skills", { fetchImpl }), /isn't one of the sites/);
  await assert.rejects(readSkillLink("http://github.com/o/skills", { fetchImpl }), /only https/);
  await assert.rejects(readSkillLink("https://clawhub.ai/bad-redirect", { fetchImpl }), /evil\.example isn't one of the sites/);
  assert.ok(!calls.some((url) => url.includes("evil.example")), "never fetched");
});

test("a folder link imports the skill folder, and no declared packages means no OSV call", async () => {
  const { fetchImpl, calls } = fakeFetch({ zip: repoZip(skillMd()) });
  const skill = await readSkillLink("https://github.com/o/skills/tree/main/weather", { fetchImpl });
  assert.equal(skill.name, "weather");
  assert.deepEqual(skill.files.map((f) => f.path).sort(), ["SKILL.md", "scripts/get.sh"]);
  assert.equal(skill.malwareCheck, "no packages declared");
  assert.ok(!calls.includes(OSV_QUERYBATCH_URL));
  // A redirect to another allowed site is followed (this repo's SKILL.md
  // is in a subfolder, so the plain archive link finds none at the top).
  await assert.rejects(
    readSkillLink("https://github.com/o/skills/archive/main.zip", { fetchImpl }),
    /no SKILL\.md at the top of the download/,
  );
  assert.equal(calls.at(-1), "https://codeload.github.com/o/skills/zip/main");
});

test("a declared npm/PyPI package OSV lists as malware refuses the import", async () => {
  let asked = null;
  const { fetchImpl } = fakeFetch({
    zip: repoZip(skillMd([{ kind: "node", package: "evil-pkg@1.0.0" }, { kind: "uv", package: "Good_Pkg" }, { kind: "brew", formula: "jq" }])),
    osv: (body) => {
      asked = body.queries;
      return Response.json({ results: [{ vulns: [{ id: "MAL-2026-1" }] }, {}] });
    },
  });
  await assert.rejects(
    readSkillLink("https://github.com/o/skills/tree/main/weather", { fetchImpl }),
    /known malware: npm package "evil-pkg@1\.0\.0" \(MAL-2026-1/,
  );
  assert.deepEqual(asked, [
    { package: { ecosystem: "npm", name: "evil-pkg" }, version: "1.0.0" },
    { package: { ecosystem: "PyPI", name: "good-pkg" } },
  ]);
});

test("OSV unreachable: the import goes ahead, and the summary says the check was skipped", async () => {
  const { fetchImpl } = fakeFetch({
    zip: repoZip(skillMd([{ kind: "node", package: "some-pkg" }])),
    osv: () => {
      throw new TypeError("fetch failed");
    },
  });
  const skill = await readSkillLink("https://github.com/o/skills/tree/main/weather", { fetchImpl });
  assert.equal(skill.name, "weather");
  assert.equal(skill.malwareCheck, "skipped for npm:some-pkg (OSV unreachable)");
});

test("a download over the zip import's 8 MB cap is refused", async () => {
  const fetchImpl = async () => new Response(Buffer.alloc(9 * 1024 * 1024));
  await assert.rejects(readSkillLink("https://clawhub.ai/skills/huge.zip", { fetchImpl }), /larger than 8 MB/);
});
