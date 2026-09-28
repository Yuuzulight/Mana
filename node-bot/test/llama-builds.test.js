const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildsToPrune,
  createLlamaBuildManager,
  parseBuildFolder,
  pickLatestRelease,
  readActivePointer,
  rollbackPointer,
  settleActiveBuild,
  writeActivePointer,
} = require("../llama-builds");

const VARIANT = "bin-win-cuda-12.4-x64";
const sha = (text) => `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;

function release(tag, { digest = true, draft = false, cudart = true } = {}) {
  const asset = (name) => ({
    name,
    size: 10,
    browser_download_url: `https://example.test/${name}`,
    ...(digest ? { digest: sha(name) } : {}),
  });
  return {
    tag_name: tag,
    draft,
    assets: [
      asset(`llama-${tag}-bin-win-cpu-x64.zip`),
      asset(`llama-${tag}-${VARIANT}.zip`),
      ...(cudart ? [asset(`cudart-llama-${VARIANT}.zip`)] : []),
    ],
  };
}

test("parseBuildFolder reads the build number and variant from a llama.cpp folder name", () => {
  assert.deepEqual(parseBuildFolder("D:\\Mana\\tools\\llama\\llama-b10507-bin-win-cuda-12.4-x64"), {
    build: 10507,
    variant: VARIANT,
  });
  assert.equal(parseBuildFolder("D:\\tools\\llama"), null);
  assert.equal(parseBuildFolder(""), null);
});

test("pickLatestRelease picks the highest bNNNNN release with this variant's zip plus its cudart", () => {
  const latest = pickLatestRelease(
    [
      { tag_name: "v0.5.0", assets: [{ name: "nightly-tag.txt" }] }, // what /releases/latest returns
      release("b11227", { draft: true }),
      release("b11226"),
      { tag_name: "b11300", assets: [] }, // newer, but no build for this variant
      release("b11225"),
    ],
    VARIANT,
  );
  assert.equal(latest.tag, "b11226");
  assert.equal(latest.build, 11226);
  assert.equal(latest.folder, `llama-b11226-${VARIANT}`);
  assert.deepEqual(latest.assets.map((a) => a.name), [`llama-b11226-${VARIANT}.zip`, `cudart-llama-${VARIANT}.zip`]);
  assert.equal(latest.digestAvailable, true);

  const noDigest = pickLatestRelease([release("b11226", { digest: false })], VARIANT);
  assert.equal(noDigest.digestAvailable, false);
  assert.equal(noDigest.assets[0].digest, null);
  const weirdDigest = release("b11226");
  weirdDigest.assets[1].digest = "md5:abc";
  assert.equal(pickLatestRelease([weirdDigest], VARIANT).digestAvailable, false);
  assert.equal(pickLatestRelease([release("b11226")], "bin-win-vulkan-x64"), null);
});

function tempTools() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mana-llama-builds-"));
}

test("the pointer is written atomically and read back; missing or corrupt reads as no pointer", () => {
  const toolsDir = tempTools();
  try {
    assert.equal(readActivePointer(toolsDir), null);
    writeActivePointer(toolsDir, { active: "C:\\a", previous: "C:\\b", pendingVerification: true, installed: ["C:\\a"] });
    assert.deepEqual(readActivePointer(toolsDir), {
      active: "C:\\a",
      previous: "C:\\b",
      pendingVerification: true,
      installed: ["C:\\a"],
      lastRollback: null,
    });
    assert.deepEqual(fs.readdirSync(toolsDir), ["active.json"], "no temp file left behind");

    fs.writeFileSync(path.join(toolsDir, "active.json"), "{truncated");
    assert.equal(readActivePointer(toolsDir), null);
    fs.writeFileSync(path.join(toolsDir, "active.json"), JSON.stringify({ previous: "C:\\b" }));
    assert.equal(readActivePointer(toolsDir), null);
  } finally {
    fs.rmSync(toolsDir, { recursive: true, force: true });
  }
});

test("rollbackPointer only rolls back an unverified update that has a previous build", () => {
  const pending = { active: "C:\\new", previous: "C:\\old", pendingVerification: true, installed: [] };
  assert.deepEqual(rollbackPointer(pending, "crashed", "t0"), {
    active: "C:\\old",
    previous: "C:\\new",
    pendingVerification: false,
    installed: [],
    lastRollback: { from: "C:\\new", to: "C:\\old", reason: "crashed", at: "t0" },
  });
  assert.equal(rollbackPointer({ ...pending, pendingVerification: false }, "crashed", "t0"), null);
  assert.equal(rollbackPointer({ ...pending, previous: null }, "crashed", "t0"), null);
  assert.equal(rollbackPointer(null, "crashed", "t0"), null);
});

test("settleActiveBuild confirms a clean start and rolls back a failed one", () => {
  const toolsDir = tempTools();
  try {
    assert.equal(settleActiveBuild(toolsDir, fs, "C:\\new", null), null, "no pointer, nothing to do");
    const pending = { active: "C:\\new", previous: "C:\\old", pendingVerification: true, installed: [] };
    writeActivePointer(toolsDir, pending);
    // A start that ran a different build says nothing about the new one.
    assert.equal(settleActiveBuild(toolsDir, fs, "C:\\old", new Error("crashed")), null);
    assert.equal(readActivePointer(toolsDir).pendingVerification, true);
    settleActiveBuild(toolsDir, fs, "c:\\NEW", null);
    assert.equal(readActivePointer(toolsDir).pendingVerification, false);

    writeActivePointer(toolsDir, pending);
    settleActiveBuild(toolsDir, fs, "C:\\new", new Error("exited during startup"), () => "t1");
    const rolled = readActivePointer(toolsDir);
    assert.equal(rolled.active, "C:\\old");
    assert.deepEqual(rolled.lastRollback, { from: "C:\\new", to: "C:\\old", reason: "exited during startup", at: "t1" });
  } finally {
    fs.rmSync(toolsDir, { recursive: true, force: true });
  }
});

test("buildsToPrune keeps active and previous, and never touches the hand-installed or outside folders", () => {
  const toolsDir = path.resolve("/mana/tools/llama");
  const dir = (name) => path.join(toolsDir, name);
  const pointer = {
    active: dir("llama-b3"),
    previous: dir("llama-b2"),
    installed: [dir("llama-b1"), dir("llama-b2"), dir("llama-b3"), dir("llama-hand"), path.resolve("/elsewhere/llama-b0")],
  };
  assert.deepEqual(buildsToPrune(pointer, toolsDir, [dir("llama-hand")]), [dir("llama-b1")]);
});

// A manager wired to a temp tools dir, with GitHub, Expand-Archive and
// `llama-server --version` all faked -- nothing is downloaded or run.
function makeManager({ releases, zipBody = (name) => name, runVersion, env = {} } = {}) {
  const toolsDir = tempTools();
  const handDir = path.join(toolsDir, `llama-b100-${VARIANT}`);
  fs.mkdirSync(handDir);
  fs.writeFileSync(path.join(handDir, "llama-server.exe"), "");
  let stops = 0;
  const extracted = [];
  const manager = createLlamaBuildManager({
    toolsDir,
    env: { LLAMA_BIN: path.join(handDir, "llama-cli.exe"), ...env },
    findLlamaServerBin: () => {
      const pointer = readActivePointer(toolsDir);
      return path.join(pointer ? pointer.active : handDir, "llama-server.exe");
    },
    stopServer: () => {
      stops += 1;
    },
    fetch: async (url) => {
      if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify(releases));
      return new Response(zipBody(path.basename(url)));
    },
    extractZip: async (zip, dest) => {
      extracted.push(path.basename(zip));
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "llama-server.exe"), "");
    },
    runVersion: runVersion || (async () => "version: 1"),
  });
  const waitForJob = async () => {
    while (manager.getStatus().job?.state === "running") await new Promise((r) => setImmediate(r));
    return manager.getStatus().job;
  };
  return { manager, toolsDir, handDir, extracted, stops: () => stops, waitForJob };
}

test("update installs beside the current build, switches the pointer, and stops the running server", async () => {
  const h = makeManager({ releases: [release("b200")] });
  try {
    const checked = await h.manager.check();
    assert.equal(checked.current.build, 100);
    assert.equal(checked.updateAvailable, true);

    assert.deepEqual(await h.manager.startUpdate(), { started: true, tag: "b200" });
    const job = await h.waitForJob();
    assert.equal(job.state, "done", job.error);
    assert.deepEqual(h.extracted, [`llama-b200-${VARIANT}.zip`, `cudart-llama-${VARIANT}.zip`]);

    const target = path.join(h.toolsDir, `llama-b200-${VARIANT}`);
    const pointer = readActivePointer(h.toolsDir);
    assert.equal(pointer.active, target);
    assert.equal(pointer.previous, h.handDir);
    assert.equal(pointer.pendingVerification, true);
    assert.deepEqual(pointer.installed, [target]);
    assert.equal(h.stops(), 1);
    assert.equal(fs.existsSync(path.join(h.toolsDir, ".staging")), false);
    assert.equal(h.manager.getStatus().current.build, 200);
  } finally {
    fs.rmSync(h.toolsDir, { recursive: true, force: true });
  }
});

test("a checksum mismatch installs nothing and leaves the pointer alone", async () => {
  const h = makeManager({ releases: [release("b200")], zipBody: () => "tampered" });
  try {
    await h.manager.startUpdate();
    const job = await h.waitForJob();
    assert.equal(job.state, "failed");
    assert.match(job.error, /Checksum mismatch/);
    assert.deepEqual(h.extracted, [], "nothing is extracted before every archive verifies");
    assert.equal(readActivePointer(h.toolsDir), null);
    assert.deepEqual(fs.readdirSync(h.toolsDir), [`llama-b100-${VARIANT}`]);
    assert.equal(h.stops(), 0);
  } finally {
    fs.rmSync(h.toolsDir, { recursive: true, force: true });
  }
});

test("a release without a published digest is refused unless the user confirms", async () => {
  const h = makeManager({ releases: [release("b200", { digest: false })] });
  try {
    await assert.rejects(() => h.manager.startUpdate(), { code: "digest_missing" });
    assert.equal(h.manager.getStatus().job, null);
    await h.manager.startUpdate({ allowMissingDigest: true });
    assert.equal((await h.waitForJob()).state, "done");
  } finally {
    fs.rmSync(h.toolsDir, { recursive: true, force: true });
  }
});

test("a failed smoke test removes the new folder and keeps the current build", async () => {
  const h = makeManager({
    releases: [release("b200")],
    runVersion: async () => {
      throw new Error("llama-server --version failed: missing DLL");
    },
  });
  try {
    await h.manager.startUpdate();
    const job = await h.waitForJob();
    assert.match(job.error, /missing DLL/);
    assert.equal(fs.existsSync(path.join(h.toolsDir, `llama-b200-${VARIANT}`)), false);
    assert.equal(readActivePointer(h.toolsDir), null);
  } finally {
    fs.rmSync(h.toolsDir, { recursive: true, force: true });
  }
});

test("a second update prunes the oldest Mana-installed build but never the hand-installed one", async () => {
  const h = makeManager({ releases: [release("b200")] });
  try {
    await h.manager.startUpdate();
    await h.waitForJob();
    // Pretend an older Mana install is still tracked, then update again.
    const old = path.join(h.toolsDir, `llama-b150-${VARIANT}`);
    fs.mkdirSync(old);
    const pointer = readActivePointer(h.toolsDir);
    writeActivePointer(h.toolsDir, { ...pointer, installed: [old, ...pointer.installed] });
    const again = makeManagerFor(h, [release("b300")]);
    await again.startUpdate();
    while (again.getStatus().job?.state === "running") await new Promise((r) => setImmediate(r));
    assert.equal(again.getStatus().job.state, "done", again.getStatus().job.error);

    const after = readActivePointer(h.toolsDir);
    assert.equal(after.active, path.join(h.toolsDir, `llama-b300-${VARIANT}`));
    assert.equal(after.previous, path.join(h.toolsDir, `llama-b200-${VARIANT}`));
    assert.equal(fs.existsSync(old), false, "b150 pruned");
    assert.equal(fs.existsSync(h.handDir), true, "hand-installed build kept");
    assert.deepEqual(after.installed, [after.previous, after.active]);
  } finally {
    fs.rmSync(h.toolsDir, { recursive: true, force: true });
  }
});

function makeManagerFor(h, releases) {
  return createLlamaBuildManager({
    toolsDir: h.toolsDir,
    env: { LLAMA_BIN: path.join(h.handDir, "llama-cli.exe") },
    findLlamaServerBin: () => path.join(readActivePointer(h.toolsDir).active, "llama-server.exe"),
    fetch: async (url) =>
      url.startsWith("https://api.github.com/") ? new Response(JSON.stringify(releases)) : new Response(path.basename(url)),
    extractZip: async (zip, dest) => {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "llama-server.exe"), "");
    },
    runVersion: async () => "version: 1",
  });
}

test("rollback swaps to the previous build; with no pointer there is nothing to roll back", async () => {
  const h = makeManager({ releases: [release("b200")] });
  try {
    assert.throws(() => h.manager.rollback(), { code: "no_previous" });
    await h.manager.startUpdate();
    await h.waitForJob();
    const status = h.manager.rollback();
    assert.equal(status.current.dir, h.handDir);
    assert.equal(status.previous, path.join(h.toolsDir, `llama-b200-${VARIANT}`));
    assert.equal(readActivePointer(h.toolsDir).pendingVerification, false);
    assert.equal(h.stops(), 2, "update and rollback each restart llama-server");
  } finally {
    fs.rmSync(h.toolsDir, { recursive: true, force: true });
  }
});

test("updates refuse to start when already current or while another update runs", async () => {
  const h = makeManager({ releases: [release("b100")] });
  try {
    await assert.rejects(() => h.manager.startUpdate(), { code: "up_to_date" });
  } finally {
    fs.rmSync(h.toolsDir, { recursive: true, force: true });
  }
  const busy = makeManager({ releases: [release("b200")] });
  try {
    const first = busy.manager.startUpdate();
    await assert.rejects(() => busy.manager.startUpdate(), { code: "busy" });
    await first;
    await busy.waitForJob();
  } finally {
    fs.rmSync(busy.toolsDir, { recursive: true, force: true });
  }
});
