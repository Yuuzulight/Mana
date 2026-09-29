const assert = require("node:assert/strict");
const test = require("node:test");

const { redactSensitive } = require("../utils/sensitive-text");

test("redactSensitive catches secrets and ID numbers", () => {
  const cases = [
    ["OPENAI_API_KEY=sk-proj-abcdEFGH1234ijklMNOP5678", "OPENAI_API_KEY=[redacted]"],
    ['password: "hunter2hunter2"', 'password: "[redacted]"'],
    ["key sk-ant-api03-abcdefghijklmnopqrstu", "key [redacted]"],
    ["AKIAIOSFODNN7EXAMPLE", "[redacted]"],
    ["github_pat_11ABCDEFG0123456789_abcdefghij", "[redacted]"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "jwt [redacted]"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "[redacted]"],
    ["card 4111 1111 1111 1111 exp 12/29", "card [redacted] exp 12/29"],
    ["ssn 123-45-6789", "ssn [redacted]"],
    ["NRIC S1234567D on the form", "NRIC [redacted] on the form"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactSensitive(input), expected, input);
  }
});

test("redactSensitive leaves ordinary text alone", () => {
  const cases = [
    "max_tokens=4096 and token_count: 12345678",
    "order 4111 1111 1111 1112", // fails Luhn
    "commit ae82139 on main, sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "Meeting at 10:30, call 6123 4567",
    "",
  ];
  for (const input of cases) {
    assert.equal(redactSensitive(input), input, input);
  }
});
