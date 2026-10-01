# Self-work benchmark: (d) +#1214, 16k

Model: Qwen3.5-9B-heretic-v2-Q4_K_M.gguf. Context: 16384. 10 cases x 3 repeat(s).

**pass@1 10%, pass@3 20%**, passes per repeat 0-2 of 10. 3/30 runs passed.

| Kind | Cases | pass@1 | pass@k | Spread |
| --- | --- | --- | --- | --- |
| multi-file | 1 | 0% | 0% | 0-0 |
| node-bug | 5 | 20% | 40% | 0-2 |
| node-feature | 4 | 0% | 0% | 0-0 |

Failures: out of rounds 14, context overflow 7, no valid edit: bad arguments 2, wrong file 4.

Mean cost of a run: 78s, 20 rounds, 20 tool calls, 154809 prompt / 3638 out tokens, peak prompt 11316, n/a tokens/s, peak VRAM 7346 MB, peak RAM 84%.

| Case | Kind | Run | Hidden test | Ended | Failure | Rounds | Tool calls (errors) | Wall | Tokens (prompt / out / peak) | Calls in text | Diff (+/-, files) | Outside the fix's files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 1 | fail | not-finished | out of rounds | 23 | 23 (1) | 46s | 143629 / 2353 / 10042 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 1 | pass | not-finished | - | 20 | 20 (3) | 54s | 149250 / 3913 / 10234 | 1 | +7/-1, 2 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 1 | fail | not-finished | context overflow | 22 | 22 (6) | 124s | 179377 / 10618 / 12786 | 1 | +0/-0, 0 | no |
| 1072-doctor-gpu-row-that-says-when | node-feature | 1 | fail | not-finished | out of rounds | 20 | 20 (1) | 75s | 167890 / 3766 / 11238 | 1 | +116/-0, 2 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 1 | fail | not-finished | out of rounds | 29 | 29 (0) | 52s | 200076 / 2039 / 10190 | 1 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 1 | fail | not-finished | context overflow | 26 | 26 (1) | 86s | 213780 / 5820 / 12971 | 1 | +61/-6, 2 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 1 | fail | not-finished | out of rounds | 16 | 16 (0) | 27s | 114983 / 1171 / 10111 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 1 | fail | not-finished | out of rounds | 12 | 12 (0) | 23s | 83243 / 1000 / 10861 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 1 | fail | not-finished | context overflow | 24 | 25 (0) | 110s | 238922 / 7471 / 14401 | 1 | +38/-8, 2 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 1 | pass | not-finished | - | 14 | 14 (1) | 31s | 103113 / 1855 / 10012 | 1 | +9/-1, 2 | no |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 2 | fail | not-finished | no valid edit: bad arguments | 23 | 23 (1) | 48s | 155356 / 2578 / 10000 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 2 | fail | not-finished | out of rounds | 20 | 20 (3) | 112s | 144096 / 3093 / 10626 | 1 | +5/-5, 2 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 2 | fail | not-finished | context overflow | 22 | 22 (1) | 110s | 174699 / 8111 / 13328 | 1 | +44/-1, 2 | node-bot/server.js |
| 1072-doctor-gpu-row-that-says-when | node-feature | 2 | fail | not-finished | no valid edit: bad arguments | 20 | 20 (2) | 60s | 170816 / 3381 / 11541 | 1 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 2 | fail | not-finished | context overflow | 14 | 17 (0) | 38s | 137125 / 1188 / 14827 | 1 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 2 | fail | not-finished | out of rounds | 26 | 26 (0) | 68s | 235514 / 2467 / 11359 | 1 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 2 | fail | not-finished | out of rounds | 16 | 16 (0) | 38s | 113882 / 2036 / 10484 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 2 | fail | not-finished | out of rounds | 12 | 12 (0) | 28s | 76236 / 1085 / 10028 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 2 | fail | not-finished | context overflow | 22 | 22 (0) | 90s | 213441 / 5511 / 14016 | 1 | +43/-2, 2 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 2 | fail | not-finished | wrong file | 14 | 14 (2) | 38s | 98858 / 2289 / 10523 | 1 | +16/-0, 1 | no |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 3 | fail | not-finished | out of rounds | 23 | 23 (0) | 44s | 165509 / 2129 / 10917 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 3 | fail | not-finished | out of rounds | 20 | 20 (3) | 30s | 138055 / 845 / 9972 | 1 | +0/-0, 0 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 3 | fail | not-finished | wrong file | 22 | 22 (1) | 146s | 162904 / 6251 / 10896 | 1 | +34/-0, 1 | no |
| 1072-doctor-gpu-row-that-says-when | node-feature | 3 | fail | not-finished | wrong file | 20 | 20 (1) | 73s | 171906 / 4469 / 12186 | 1 | +95/-0, 1 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 3 | fail | not-finished | wrong file | 29 | 29 (1) | 88s | 235086 / 4999 / 11748 | 1 | +0/-35, 1 | no |
| 1089-model-recommendation-subtract | multi-file | 3 | fail | not-finished | out of rounds | 26 | 26 (1) | 57s | 210887 / 2739 / 10959 | 1 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 3 | fail | not-finished | out of rounds | 16 | 16 (0) | 28s | 94972 / 1023 / 7634 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 3 | fail | not-finished | out of rounds | 12 | 12 (0) | 27s | 78930 / 1356 / 10146 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 3 | fail | not-finished | context overflow | 17 | 17 (0) | 534s | 160799 / 9520 / 14428 | 1 | +38/-3, 2 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 3 | pass | not-finished | - | 14 | 14 (0) | 56s | 110940 / 4056 / 11011 | 1 | +9/-3, 2 | no |
