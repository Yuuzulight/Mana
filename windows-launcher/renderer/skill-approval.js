// Issue #850: what stops a skill typed into Settings from being approved
// straight away -- the content scan's flags, plus Guardian's "not safe"
// verdict, which the approval gate reports as `guardian` (its flags stay
// empty, so on their own they'd look like a clean scan). Empty = clean.
function skillReviewFlags(outcome) {
  const flags = Array.isArray(outcome?.flags) ? [...outcome.flags] : [];
  if (outcome?.guardian && outcome.guardian.safe === false) {
    flags.push(
      outcome.guardian.reason ? `Guardian judged it risky (${outcome.guardian.reason})` : "Guardian judged it risky",
    );
  }
  return flags;
}

module.exports = { skillReviewFlags };
