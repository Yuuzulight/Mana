# Self-work training traces

Mana works my issues on her own code (`node-bot/self-work.js`) with her local coding model. Her runs that work out are kept as training records, so that later on her local model can be fine-tuned on her own good work and she gets better at it over time. This is the collection half only. No training happens yet.

## What's kept

When a self-work run opens a PR whose tests passed and whose diff her reviewer passed, she writes `node-bot/data/self-work-traces/pr-<N>.json` (the folder is git-ignored). Each record holds:

- `issue`: number, title and body
- `conversations`: one per loop of hers on the kept attempt (her main loop, plus a review round when she had one), with `messages` exactly as the model saw them: system, user, assistant turns with `tool_calls`, and `tool` results
- `diff`: the commit she pushed
- `tests`: the test command that passed, and her attempts when she made several
- `source`: `local`, or `gemini-cli` when the change came from her Gemini fallback
- `outcome`: `testsPassed`, `reviewPassed`, `merged` (set when she next sees her merged PRs) and `reverted` (set when I revert the PR from Mana)

A draft PR whose tests still fail isn't kept.

## Rules

- **Local model only.** A record whose `source` isn't `local` is never written. A change that started as Gemini CLI's (or any cloud model's) doesn't count as hers to learn from.
- **Scrubbed.** Every string goes through the same sanitizer her GitHub text does (`bridge-output-sanitizer.js`): keys, tokens and the values of secret env vars are redacted, and local paths outside the repo become `[local path]`.
- **Capped.** The folder is kept under `MANA_SELF_WORK_TRACES_MAX_MB` (200 MB by default); the oldest records go first.
- **Can be turned off.** `MANA_SELF_WORK_TRACES=0` in `.env` stops her saving records.

## The plan

1. **Collect.** Every passing PR of hers leaves a record; merges and reverts update its labels.
2. **Filter.** Only records that are `local`, with tests and review passed, merged, and not reverted, are training data:

   ```
   cd node-bot
   node scripts/export-self-work-traces.js self-work.jsonl
   ```

   That writes one chat-format line (`{"messages": [...]}`) per conversation, the shape LoRA trainers take for tool-calling chat data. `--unmerged` also takes records that passed tests and review but aren't merged; `--dir <folder>` reads another folder.
3. **Fine-tune** once there are about 200+ good runs: a LoRA on her local coding model, then the self-work benchmark (`node-bot/bench/self-work-bench.js`) on the tuned model against today's before it replaces anything.
