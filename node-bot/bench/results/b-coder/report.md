# Self-work benchmark: (b) baseline, qwen2.5-coder-7b

Model: qwen2.5-coder-7b-instruct-mana-imat-Q4_K_M.gguf. 4 cases x 1 repeat(s).

**pass@1 0%, pass@1 0%**, passes per repeat 0-0 of 4. 0/4 runs passed.

| Kind | Cases | pass@1 | pass@k | Spread |
| --- | --- | --- | --- | --- |
| node-bug | 2 | 0% | 0% | 0-0 |
| node-feature | 2 | 0% | 0% | 0-0 |

Failures: context overflow 2, stuck 1, wrong file 1.

Mean cost of a run: 283s, 4 rounds, 13 tool calls, 50399 prompt / 2626 out tokens, peak prompt 10833, peak VRAM 7060 MB, peak RAM 78%.

| Case | Kind | Run | Hidden test | Ended | Failure | Rounds | Tool calls (errors) | Wall | Tokens (prompt / out / peak) | Calls in text | Diff (+/-, files) | Outside the fix's files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 1 | fail | not-finished | context overflow | 3 | 13 (0) | 475s | 54040 / 2444 / 16236 | 3 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 1 | fail | stuck | stuck | 6 | 19 (5) | 219s | 56785 / 2082 / 7841 | 13 | +0/-0, 0 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 1 | fail | finished | wrong file | 4 | 11 (3) | 381s | 31761 / 2025 / 5987 | 6 | +5/-0, 1 | foreground.js |
| 1072-doctor-gpu-row-that-says-when | node-feature | 1 | fail | not-finished | context overflow | 4 | 9 (0) | 55s | 59009 / 3953 / 13266 | 4 | +0/-0, 0 | no |
