// #1231: a node:test reporter for the task generator: one JSON line per
// finished test, with its describe() path and, on a failure, what threw.
module.exports = async function* reporter(source) {
  const path = [];
  for await (const { type, data } of source) {
    if (type === "test:start") path.splice(data.nesting, Infinity, data.name);
    if (type !== "test:pass" && type !== "test:fail") continue;
    const err = data.details?.error;
    const cause = err?.cause ?? err;
    yield `${JSON.stringify({
      name: data.name,
      parents: path.slice(0, data.nesting),
      passed: type === "test:pass",
      skipped: Boolean(data.skip || data.todo),
      failureType: err?.failureType,
      code: cause?.code,
      error: cause?.name,
      message: err ? String(cause?.message ?? cause ?? "") : undefined,
    })}\n`;
  }
};
