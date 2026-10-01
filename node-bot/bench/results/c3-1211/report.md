# Self-work benchmark: (c) +#1211

Model: Qwen3.5-9B-heretic-v2-Q4_K_M.gguf. 10 cases x 2 repeat(s).

**pass@1 20%, pass@2 30%**, passes per repeat 1-3 of 10. 4/20 runs passed.

| Kind | Cases | pass@1 | pass@k | Spread |
| --- | --- | --- | --- | --- |
| multi-file | 1 | 0% | 0% | 0-0 |
| node-bug | 5 | 40% | 60% | 1-3 |
| node-feature | 4 | 0% | 0% | 0-0 |

Failures: context overflow 13, no valid edit: reviewer refusal 2, no valid edit: bad arguments 1.

Mean cost of a run: 32s, 10 rounds, 10 tool calls, 77857 prompt / 1606 out tokens, peak prompt 12542, peak VRAM 7513 MB, peak RAM 76%.

| Case | Kind | Run | Hidden test | Ended | Failure | Rounds | Tool calls (errors) | Wall | Tokens (prompt / out / peak) | Calls in text | Diff (+/-, files) | Outside the fix's files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 1 | fail | not-finished | context overflow | 11 | 11 (0) | 21s | 88891 / 903 / 13581 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 1 | fail | not-finished | context overflow | 13 | 13 (0) | 34s | 122134 / 2354 / 13913 | 1 | +7/-1, 2 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 1 | fail | refuted | no valid edit: reviewer refusal | 11 | 11 (0) | 25s | 52402 / 1836 / 6978 | 1 | +0/-0, 0 | no |
| 1072-doctor-gpu-row-that-says-when | node-feature | 1 | fail | not-finished | context overflow | 18 | 18 (0) | 37s | 156733 / 2431 / 13408 | 1 | +34/-0, 1 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 1 | fail | not-finished | context overflow | 6 | 5 (0) | 7s | 33138 / 272 / 13069 | 0 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 1 | fail | not-finished | context overflow | 6 | 6 (0) | 12s | 47490 / 570 / 13336 | 1 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 1 | fail | not-finished | no valid edit: bad arguments | 8 | 6 (1) | 25s | 20638 / 2448 / 6614 | 0 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 1 | fail | not-finished | context overflow | 15 | 15 (0) | 25s | 102810 / 1421 / 13653 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 1 | fail | refuted | no valid edit: reviewer refusal | 6 | 6 (0) | 34s | 45305 / 3186 / 9185 | 1 | +9/-1, 1 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 1 | pass | finished | - | 8 | 8 (0) | 17s | 62029 / 968 / 9689 | 0 | +1/-1, 1 | no |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 2 | fail | not-finished | context overflow | 9 | 9 (0) | 17s | 75074 / 760 / 13504 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 2 | pass | not-finished | - | 17 | 17 (1) | 40s | 149442 / 2870 / 13888 | 1 | +7/-1, 2 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 2 | fail | error | context overflow | 17 | 17 (1) | 61s | 99214 / 5589 / 13986 | 0 | +57/-1, 2 | node-bot/server.js |
| 1072-doctor-gpu-row-that-says-when | node-feature | 2 | fail | not-finished | context overflow | 9 | 9 (0) | 16s | 81953 / 722 / 13989 | 1 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 2 | fail | error | context overflow | 8 | 8 (0) | 11s | 41003 / 342 / 13493 | 0 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 2 | fail | not-finished | context overflow | 6 | 5 (0) | 7s | 31555 / 279 / 13048 | 0 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 2 | pass | not-finished | - | 13 | 13 (1) | 31s | 106553 / 2066 / 14057 | 1 | +3/-3, 1 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 2 | fail | error | context overflow | 7 | 8 (0) | 11s | 57407 / 399 / 15588 | 0 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 2 | fail | not-finished | context overflow | 9 | 9 (0) | 19s | 84331 / 1021 / 13468 | 1 | +8/-0, 1 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 2 | pass | paused | - | 12 | 12 (0) | 183s | 99041 / 1676 / 12402 | 1 | +1/-1, 1 | no |
