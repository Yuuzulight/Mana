const axios = require("axios");

const RETRIEVER_URL = "http://127.0.0.1:9000";
const NODE_BOT_URL = "http://127.0.0.1:5005";

async function runSmokeTest() {
  console.log("🚀 Starting ManaAI System Smoke Test...\n");
  let passed = true;

  // Test 1: Verify Python Retriever Health & Tokenizer Type
  try {
    console.log("🔄 Test 1/4: Checking Python Retriever /health...");
    const res = await axios.get(`${RETRIEVER_URL}/health`);
    if (res.status === 200) {
      console.log("  ✅ Passed! Status: Healthy.");
      console.log(
        `  📊 State: Index Loaded [${res.data.index_loaded}], Model Loaded [${res.data.model_loaded}]`,
      );
      console.log(
        `  🔬 Active Tokenizer: ${(res.data.tokenizer_type || "heuristic").toString().toUpperCase()}\n`,
      );
    } else {
      console.error(`  ❌ Test 1 Failed: Unexpected status ${res.status}`);
      passed = false;
    }
  } catch (err) {
    console.error(
      `  ❌ Test 1 Failed: Retriever is unreachable or loading. (${err.message})\n`,
    );
    passed = false;
  }

  // Test 2: Verify Exact Tokenization
  try {
    console.log("🔄 Test 2/4: Verifying token-count accuracy via Python...");
    const sampleText = "function test() { return 'ManaAI'; }";
    const res = await axios.post(`${RETRIEVER_URL}/tokenize`, {
      text: sampleText,
    });
    if (res && res.data && typeof res.data.tokens === "number") {
      console.log(
        `  ✅ Passed! Text string calculated to [${res.data.tokens}] tokens.\n`,
      );
    } else {
      console.error("  ❌ Test 2 Failed: Unexpected tokenize response shape");
      passed = false;
    }
  } catch (err) {
    console.error(
      `  ❌ Test 2 Failed: Tokenization endpoint error. (${err.message})\n`,
    );
    passed = false;
  }

  // Test 3: Verify Vector Store Document Retrieval
  try {
    console.log(
      "🔄 Test 3/4: Testing embedding model & vector store indexing...",
    );
    const res = await axios.post(`${RETRIEVER_URL}/retrieve`, {
      query: "node server start",
      k: 1,
    });
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      const top = res.data[0];
      const snippet = (top.meta && (top.meta.text || top.meta.preview)) || "";
      console.log("  ✅ Passed! Retrieved semantic match from local index.");
      console.log(
        `  📄 Top match snippet: "${snippet.substring(0, 120).replace(/\n/g, " ")}..."\n`,
      );
    } else if (res.data && Array.isArray(res.data) && res.data.length === 0) {
      console.warn(
        "  ⚠️ Warning: Service responded, but returned 0 vector index matches. Did you run ingest_codebase.py?\n",
      );
    } else {
      console.error("  ❌ Test 3 Failed: Unexpected retrieve response shape");
      passed = false;
    }
  } catch (err) {
    console.error(
      `  ❌ Test 3 Failed: Vector retrieval pipeline failed. (${err.message})\n`,
    );
    passed = false;
  }

  // Test 4: Verify Node Backend Memory Pipeline
  try {
    console.log("🔄 Test 4/5: Pinging Node Backend Reply loop...");
    const res = await axios.post(
      `${NODE_BOT_URL}/reply`,
      {
        text: "Hello local assistant, verify memory tracking.",
        sessionId: "smoke-test-session",
      },
      { timeout: 10000 },
    );
    if (
      res.status === 200 &&
      res.data &&
      (typeof res.data.reply === "string" || res.data.reply !== undefined)
    ) {
      console.log(
        "  ✅ Passed! Node backend processed message and returned a reply.\n",
      );
    } else {
      console.error(
        "  ❌ Test 4 Failed: Node backend returned unexpected response",
      );
      passed = false;
    }
  } catch (err) {
    console.error(
      `  ❌ Test 4 Failed: Node backend at port 5005 is unreachable. (${err.message})\n`,
    );
    passed = false;
  }

  // Test 5: Verify Frontend Debug /debug/intent Endpoint
  try {
    console.log(
      "🔄 Test 5/5: Verifying Frontend Debug /debug/intent Endpoint...",
    );
    const sampleInput = "Can you check my git branch structure?";
    const res = await axios.post(`${NODE_BOT_URL}/debug/intent`, {
      text: sampleInput,
    });

    if (res.status === 200 && res.data && res.data.mode === "coding") {
      console.log(
        `  ✅ Passed! Correctly classified text to [${res.data.mode}] via rule [${res.data.reason}].\n`,
      );
    } else {
      throw new Error(
        `Unexpected classifier layout returned: ${JSON.stringify(res.data)}`,
      );
    }
  } catch (err) {
    console.error(
      `  ❌ Test 5 Failed: Intent debugging route returned an error. (${err.message})\n`,
    );
    passed = false;
  }

  // Test 6: Verify Autonomous Tool Loop Execution Integration
  try {
    console.log(
      "🔄 Test 6/6: Verifying Autonomous Tool Loop Execution Integration...",
    );
    const {
      executeAutonomousStep,
    } = require("../node-bot/acp-autonomous-loop");

    // Mocking an unstructured model reply wrapping a tool array call block
    const mockModelReply =
      'Sure developer! Let me look that up for you:\n[{"tool": "local_retrieve", "args": {"query": "server.js port", "k": 1}}]';

    const result = await executeAutonomousStep(
      mockModelReply,
      "smoke-test-session",
    );

    // Expect multi-tool sequencing result shape
    if (
      result.status === "tools_executed" &&
      Array.isArray(result.results) &&
      result.results.length > 0 &&
      result.results[0].tool === "local_retrieve" &&
      result.results[0].status === "ok"
    ) {
      console.log(
        "  ✅ Passed! Autonomous pipeline successfully executed and aggregated local vector search results.\n",
      );
    } else {
      throw new Error(
        `Unexpected loop reaction returned: ${JSON.stringify(result)}`,
      );
    }
  } catch (err) {
    console.error(
      `  ❌ Test 6 Failed: Autonomous tool pipeline tracking crashed. (${err.message})\n`,
    );
    passed = false;
  }

  if (passed) {
    console.log(
      "🎉 SUCCESS: Core local infrastructure is configured and ready for agent deployment!",
    );
    process.exit(0);
  } else {
    console.error(
      "🚨 FAILURE: One or more local components are broken. Review logs above.",
    );
    process.exit(1);
  }
}

runSmokeTest();
