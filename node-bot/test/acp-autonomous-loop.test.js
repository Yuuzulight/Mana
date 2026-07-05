const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const fs = require("fs");

const { executeAutonomousStep } = require("../acp-autonomous-loop");

// This test suite monkeypatches axios.post and fs.promises in-process to provide deterministic,
// dependency-free unit tests for the autonomous loop without any external libs.

function makeMockPost(behavior) {
  return async function mockPost(url, body, opts) {
    // simple routing based on body.query
    const q = body && body.query ? String(body.query) : "";
    // allow async simulation
    await new Promise((r) => setTimeout(r, 0));

    if (behavior[q]) {
      const resp = behavior[q];
      if (resp instanceof Error) throw resp;
      return { data: resp };
    }

    // Default: return empty array
    return { data: [] };
  };
}

test("acp-autonomous-loop: single local_retrieve executes and returns context", async (t) => {
  const originalPost = axios.post;
  try {
    axios.post = makeMockPost({
      "server.js port": [
        {
          meta: { filepath: "server.js", text: "server listens on port 5005" },
        },
      ],
    });

    const mockModelReply =
      'Looking that up:\n[{"tool":"local_retrieve","args":{"query":"server.js port","k":1}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    assert.equal(res.status, "tools_executed");
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results.length, 1);
    const first = res.results[0];
    assert.equal(first.tool, "local_retrieve");
    assert.equal(first.status, "ok");
    assert.equal(first.hits, 1);
    assert.ok(first.injectedContext.includes("server.js"));
    assert.ok(res.combinedInjectedContext.includes("server.js"));
  } finally {
    axios.post = originalPost;
  }
});

test("acp-autonomous-loop: multiple local_retrieve actions aggregate results", async (t) => {
  const originalPost = axios.post;
  try {
    axios.post = makeMockPost({
      "alpha query": [
        { meta: { filepath: "alpha.txt", text: "alpha content" } },
      ],
      "beta query": [{ meta: { filepath: "beta.txt", text: "beta content" } }],
    });

    const mockModelReply =
      'Seq:\n[{"tool":"local_retrieve","args":{"query":"alpha query","k":1}},{"tool":"local_retrieve","args":{"query":"beta query","k":1}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    assert.equal(res.status, "tools_executed");
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].tool, "local_retrieve");
    assert.equal(res.results[1].tool, "local_retrieve");
    assert.equal(res.results[0].status, "ok");
    assert.equal(res.results[1].status, "ok");
    assert.ok(res.combinedInjectedContext.includes("alpha content"));
    assert.ok(res.combinedInjectedContext.includes("beta content"));
    // ensure separator exists between two contexts
    assert.ok(res.combinedInjectedContext.includes("\n\n---\n\n"));
  } finally {
    axios.post = originalPost;
  }
});

test("acp-autonomous-loop: one failing tool does not block others", async (t) => {
  const originalPost = axios.post;
  try {
    axios.post = makeMockPost({
      "fail query": new Error("simulated retriever failure"),
      "ok query": [{ meta: { filepath: "ok.txt", text: "ok content" } }],
    });

    const mockModelReply =
      'Seq:\n[{"tool":"local_retrieve","args":{"query":"fail query","k":1}},{"tool":"local_retrieve","args":{"query":"ok query","k":1}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    // Should include both results and mark the first as error, the second as ok
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results.length, 2);
    assert.equal(res.results[0].tool, "local_retrieve");
    assert.equal(res.results[0].status, "error");
    assert.ok(res.results[0].detail.includes("simulated retriever failure"));
    assert.equal(res.results[1].status, "ok");
    assert.ok(res.combinedInjectedContext.includes("ok content"));
  } finally {
    axios.post = originalPost;
  }
});

// New file_read tests

test("acp-autonomous-loop: file_read reads a file within repo root", async (t) => {
  const origStat = fs.promises.stat;
  const origRead = fs.promises.readFile;
  try {
    // Monkeypatch stat and readFile
    fs.promises.stat = async (p) => ({ isFile: () => true, size: 42 });
    fs.promises.readFile = async (p, opts) => "console.log('hello world')\n";

    const mockModelReply =
      'Fetch file:\n[{"tool":"file_read","args":{"path":"src/index.js"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    assert.equal(res.status, "tools_executed");
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results.length, 1);
    const r = res.results[0];
    assert.equal(r.tool, "file_read");
    assert.equal(r.status, "ok");
    assert.equal(r.path, "src/index.js");
    assert.equal(r.size, 42);
    assert.ok(r.injectedContext.includes("console.log('hello world')"));
  } finally {
    fs.promises.stat = origStat;
    fs.promises.readFile = origRead;
  }
});

test("acp-autonomous-loop: file_read blocks paths outside repo", async (t) => {
  const origStat = fs.promises.stat;
  const origRead = fs.promises.readFile;
  try {
    // These should not be called, but stub to be safe
    fs.promises.stat = async (p) => ({ isFile: () => true, size: 10 });
    fs.promises.readFile = async (p, opts) => "should not read";

    const mockModelReply =
      'Fetch file:\n[{"tool":"file_read","args":{"path":"C:\\Windows\\system.ini"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    // Should return idle or results with error for file_read
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results[0].tool, "file_read");
    assert.equal(res.results[0].status, "error");
    assert.ok(
      res.results[0].detail === "path_outside_repo" ||
        typeof res.results[0].detail === "string",
    );
  } finally {
    fs.promises.stat = origStat;
    fs.promises.readFile = origRead;
  }
});

// file_write tests

test("acp-autonomous-loop: file_write forbidden when disabled", async (t) => {
  const origEnv = process.env.ALLOW_FILE_WRITE;
  const origApproval = process.env.FILE_WRITE_REQUIRE_APPROVAL;
  try {
    process.env.ALLOW_FILE_WRITE = "0";
    process.env.FILE_WRITE_REQUIRE_APPROVAL = "0";
    const mockModelReply =
      'Write file:\n[{"tool":"file_write","args":{"path":"src/out.txt","content":"x"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");
    assert.ok(Array.isArray(res.results));
    assert.equal(res.results[0].tool, "file_write");
    assert.equal(res.results[0].status, "forbidden");
  } finally {
    process.env.ALLOW_FILE_WRITE = origEnv;
    process.env.FILE_WRITE_REQUIRE_APPROVAL = origApproval;
  }
});

test("acp-autonomous-loop: file_write append succeeds when enabled", async (t) => {
  const origEnv = process.env.ALLOW_FILE_WRITE;
  const origApproval = process.env.FILE_WRITE_REQUIRE_APPROVAL;
  const origStat = fs.promises.stat;
  const origAppend = fs.promises.appendFile;
  try {
    process.env.ALLOW_FILE_WRITE = "1";
    process.env.FILE_WRITE_REQUIRE_APPROVAL = "0";
    // simulate existing file size 10
    fs.promises.stat = async (p) => ({ isFile: () => true, size: 10 });
    let appended = false;
    fs.promises.appendFile = async (p, content, opts) => {
      appended = true;
    };

    const mockModelReply =
      'Write file:\n[{"tool":"file_write","args":{"path":"src/log.txt","content":"abc","mode":"append"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    assert.ok(Array.isArray(res.results));
    assert.equal(res.results[0].tool, "file_write");
    assert.equal(res.results[0].status, "ok");
    assert.equal(res.results[0].action, "appended");
    assert.equal(res.results[0].size, 13);
    assert.ok(appended);
  } finally {
    process.env.ALLOW_FILE_WRITE = origEnv;
    process.env.FILE_WRITE_REQUIRE_APPROVAL = origApproval;
    fs.promises.stat = origStat;
    fs.promises.appendFile = origAppend;
  }
});

test("acp-autonomous-loop: file_write overwrite backups and writes when enabled", async (t) => {
  const origEnv = process.env.ALLOW_FILE_WRITE;
  const origApproval = process.env.FILE_WRITE_REQUIRE_APPROVAL;
  const origStat = fs.promises.stat;
  const origCopy = fs.promises.copyFile;
  const origWrite = fs.promises.writeFile;
  try {
    process.env.ALLOW_FILE_WRITE = "1";
    process.env.FILE_WRITE_REQUIRE_APPROVAL = "0";
    let lastWriteSize = null;
    let copyCalled = false;

    // stat behaves: before write -> exists with size 10; after write -> returns {size: lastWriteSize}
    fs.promises.stat = async (p) => {
      if (lastWriteSize === null) return { isFile: () => true, size: 10 };
      return { isFile: () => true, size: lastWriteSize };
    };

    fs.promises.copyFile = async (src, dest) => {
      copyCalled = true;
    };
    fs.promises.writeFile = async (p, content, opts) => {
      lastWriteSize = Buffer.byteLength(content, "utf8");
    };

    const mockModelReply =
      'Write file:\n[{"tool":"file_write","args":{"path":"src/out.txt","content":"hello world","mode":"overwrite"}}]';
    const res = await executeAutonomousStep(mockModelReply, "test-session");

    assert.ok(Array.isArray(res.results));
    assert.equal(res.results[0].tool, "file_write");
    assert.equal(res.results[0].status, "ok");
    assert.equal(res.results[0].action, "overwritten");
    assert.equal(res.results[0].size, Buffer.byteLength("hello world", "utf8"));
    assert.ok(copyCalled);
  } finally {
    process.env.ALLOW_FILE_WRITE = origEnv;
    process.env.FILE_WRITE_REQUIRE_APPROVAL = origApproval;
    fs.promises.stat = origStat;
    fs.promises.copyFile = origCopy;
    fs.promises.writeFile = origWrite;
  }
});
