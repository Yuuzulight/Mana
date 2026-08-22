const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseAccessibilityTreeOutput,
  isAccessibilityTreeTextUsable,
} = require("../accessibility-tree");

test("parseAccessibilityTreeOutput splits the PID line from the extracted text", () => {
  const result = parseAccessibilityTreeOutput("PID:4321\n---\nSave As\nFile name:\nreport.docx\n");
  assert.equal(result.ownerPid, 4321);
  assert.equal(result.text, "Save As\nFile name:\nreport.docx");
});

test("parseAccessibilityTreeOutput handles an empty tree (no text after the separator)", () => {
  const result = parseAccessibilityTreeOutput("PID:0\n---\n");
  assert.equal(result.ownerPid, 0);
  assert.equal(result.text, "");
});

test("parseAccessibilityTreeOutput falls back to pid 0 and empty text when malformed", () => {
  const result = parseAccessibilityTreeOutput("garbage, no separator at all");
  assert.equal(result.ownerPid, 0);
  assert.equal(result.text, "");
});

test("parseAccessibilityTreeOutput handles missing/blank input", () => {
  assert.deepEqual(parseAccessibilityTreeOutput(""), { ownerPid: 0, text: "" });
  assert.deepEqual(parseAccessibilityTreeOutput(null), { ownerPid: 0, text: "" });
  assert.deepEqual(parseAccessibilityTreeOutput(undefined), { ownerPid: 0, text: "" });
});

test("isAccessibilityTreeTextUsable rejects null/empty/short results", () => {
  assert.equal(isAccessibilityTreeTextUsable(null), false);
  assert.equal(isAccessibilityTreeTextUsable(""), false);
  assert.equal(isAccessibilityTreeTextUsable("OK"), false);
});

test("isAccessibilityTreeTextUsable rejects a token tree (one generic line, no real content)", () => {
  // Long enough to clear the char floor alone, but only one distinct line --
  // exactly the "one generic Pane, nothing else" case OCR should handle instead.
  assert.equal(isAccessibilityTreeTextUsable("Untitled - Notepad, a rather long single line"), false);
});

test("isAccessibilityTreeTextUsable accepts a real dialog's worth of content", () => {
  assert.equal(isAccessibilityTreeTextUsable("Save As\nFile name:\nreport.docx\nSave\nCancel"), true);
});

test("isAccessibilityTreeTextUsable ignores blank lines when counting distinct lines", () => {
  assert.equal(isAccessibilityTreeTextUsable("Save As\n\n\nFile name:\n\nreport.docx"), true);
  assert.equal(isAccessibilityTreeTextUsable("Save As\n\n\n\n\n"), false);
});
