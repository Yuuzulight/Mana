#!/usr/bin/env node
"use strict";

// #1287: Mana's good self-work records (merged, tests and review passed,
// not reverted) as chat-format JSONL for a LoRA fine-tune.
//   node scripts/export-self-work-traces.js [out.jsonl] [--unmerged] [--dir <traces dir>]
// Writes to stdout without an out file.

const fs = require("node:fs");
const path = require("node:path");
const { createTraceStore, toChatLines } = require("../self-work-traces");

const args = process.argv.slice(2);
const dirAt = args.indexOf("--dir");
const dir = dirAt >= 0 ? args[dirAt + 1] : path.join(__dirname, "..", "data", "self-work-traces");
const out = args.find((a, i) => !a.startsWith("--") && (dirAt < 0 || i !== dirAt + 1));
const records = createTraceStore({ dir }).list();
const lines = toChatLines(records, { unmerged: args.includes("--unmerged") });
const text = lines.length ? `${lines.join("\n")}\n` : "";
if (out) fs.writeFileSync(out, text);
else process.stdout.write(text);
process.stderr.write(`${lines.length} conversation(s) from ${records.length} record(s).\n`);
