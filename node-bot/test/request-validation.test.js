const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ValidationError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requireFile,
  requireOneOf,
  requireString,
} = require("../request-validation");

test("requireString returns trimmed text and rejects missing values", () => {
  assert.equal(requireString(" hello ", "text"), "hello");
  assert.throws(() => requireString("", "text"), ValidationError);
  assert.throws(() => requireString("   ", "text"), /text is required/);
  assert.throws(() => requireString(null, "text"), /text is required/);
});

test("optionalString trims strings and returns default for missing values", () => {
  assert.equal(optionalString(" Kujata ", "world", "Adamantoise"), "Kujata");
  assert.equal(optionalString(undefined, "world", "Adamantoise"), "Adamantoise");
  assert.throws(() => optionalString(123, "world"), /world must be a string/);
});

test("optionalInteger enforces integer bounds", () => {
  assert.equal(optionalInteger("10", "limit", { min: 1, max: 25, defaultValue: 5 }), 10);
  assert.equal(optionalInteger(undefined, "limit", { min: 1, max: 25, defaultValue: 5 }), 5);
  assert.throws(() => optionalInteger("0", "limit", { min: 1, max: 25 }), /limit must be between 1 and 25/);
  assert.throws(() => optionalInteger("abc", "limit", { min: 1, max: 25 }), /limit must be an integer/);
});

test("optionalBoolean accepts local API boolean forms", () => {
  assert.equal(optionalBoolean("1", "useSalesHistory", false), true);
  assert.equal(optionalBoolean("true", "useSalesHistory", false), true);
  assert.equal(optionalBoolean("0", "useSalesHistory", true), false);
  assert.equal(optionalBoolean("false", "useSalesHistory", true), false);
  assert.equal(optionalBoolean(undefined, "useSalesHistory", true), true);
  assert.throws(() => optionalBoolean("yes", "useSalesHistory"), /useSalesHistory must be true or false/);
});

test("requireFile rejects missing multipart files", () => {
  const file = { path: "tmp/upload.wav" };
  assert.equal(requireFile(file, "file"), file);
  assert.throws(() => requireFile(null, "file"), /file is required/);
});

test("requireOneOf returns first non-empty value or throws", () => {
  assert.equal(
    requireOneOf([
      { value: "", label: "itemId" },
      { value: "Potion", label: "itemName" },
    ]),
    "Potion",
  );
  assert.throws(
    () => requireOneOf([
      { value: "", label: "itemId" },
      { value: "", label: "itemName" },
    ]),
    /itemId or itemName is required/,
  );
});
