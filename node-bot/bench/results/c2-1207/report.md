# Self-work benchmark: (c) +#1207

Model: Qwen3.5-9B-heretic-v2-Q4_K_M.gguf. 10 cases x 3 repeat(s).

**pass@1 10%, pass@3 20%**, passes per repeat 0-2 of 10. 3/30 runs passed.

| Kind | Cases | pass@1 | pass@k | Spread |
| --- | --- | --- | --- | --- |
| multi-file | 1 | 0% | 0% | 0-0 |
| node-bug | 5 | 20% | 40% | 0-2 |
| node-feature | 4 | 0% | 0% | 0-0 |

Failures: context overflow 21, no valid edit: reviewer refusal 5, wrong file 1.

Mean cost of a run: 32s, 10 rounds, 11 tool calls, 77668 prompt / 1768 out tokens, peak prompt 12850, peak VRAM 7417 MB, peak RAM 75%.

| Case | Kind | Run | Hidden test | Ended | Failure | Rounds | Tool calls (errors) | Wall | Tokens (prompt / out / peak) | Calls in text | Diff (+/-, files) | Outside the fix's files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 1 | fail | not-finished | context overflow | 19 | 19 (0) | 36s | 160667 / 1690 / 13298 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 1 | pass | not-finished | - | 16 | 16 (1) | 36s | 136287 / 2375 / 13575 | 1 | +7/-1, 2 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 1 | fail | not-finished | context overflow | 16 | 16 (1) | 45s | 135979 / 3493 / 13134 | 1 | +8/-1, 1 | node-bot/server.js |
| 1072-doctor-gpu-row-that-says-when | node-feature | 1 | fail | error | context overflow | 8 | 8 (0) | 12s | 63618 / 458 / 15421 | 0 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 1 | fail | not-finished | context overflow | 6 | 5 (0) | 8s | 32442 / 311 / 12931 | 0 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 1 | fail | not-finished | context overflow | 6 | 5 (0) | 8s | 30781 / 312 / 12916 | 0 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 1 | fail | not-finished | context overflow | 13 | 13 (0) | 64s | 109476 / 6219 / 14088 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 1 | fail | not-finished | context overflow | 9 | 9 (0) | 16s | 57387 / 642 / 13111 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 1 | fail | refuted | no valid edit: reviewer refusal | 5 | 6 (0) | 50s | 40657 / 4975 / 9508 | 1 | +0/-0, 0 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 1 | pass | finished | - | 6 | 6 (0) | 18s | 44444 / 1233 / 9584 | 0 | +6/-12, 1 | no |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 2 | fail | not-finished | context overflow | 16 | 16 (0) | 24s | 130771 / 1135 / 13749 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 2 | fail | refuted | no valid edit: reviewer refusal | 9 | 9 (1) | 23s | 44916 / 1691 / 7641 | 1 | +1/-1, 1 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 2 | fail | not-finished | wrong file | 20 | 18 (1) | 59s | 108445 / 5197 / 12256 | 0 | +58/-0, 2 | node-bot/server.js |
| 1072-doctor-gpu-row-that-says-when | node-feature | 2 | fail | not-finished | context overflow | 6 | 6 (0) | 12s | 55597 / 421 / 14785 | 1 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 2 | fail | error | context overflow | 4 | 7 (0) | 9s | 29124 / 320 / 15013 | 0 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 2 | fail | not-finished | context overflow | 6 | 6 (0) | 13s | 58098 / 566 / 13733 | 1 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 2 | fail | not-finished | context overflow | 10 | 11 (0) | 24s | 97256 / 1487 / 13113 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 2 | fail | error | context overflow | 10 | 10 (0) | 13s | 62298 / 516 / 16162 | 0 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 2 | fail | refuted | no valid edit: reviewer refusal | 9 | 9 (2) | 45s | 50446 / 4199 / 9459 | 1 | +0/-0, 0 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 2 | pass | finished | - | 11 | 11 (0) | 23s | 94009 / 1329 / 11580 | 0 | +1/-1, 1 | no |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 3 | fail | not-finished | context overflow | 17 | 17 (0) | 27s | 127389 / 1370 / 13783 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 3 | fail | not-finished | context overflow | 15 | 21 (0) | 223s | 140753 / 2009 / 13920 | 1 | +1/-1, 1 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 3 | fail | not-finished | context overflow | 15 | 17 (0) | 56s | 124484 / 4559 / 14465 | 1 | +27/-1, 2 | node-bot/server.js, node-bot/test/proactive.test.js |
| 1072-doctor-gpu-row-that-says-when | node-feature | 3 | fail | not-finished | context overflow | 9 | 9 (0) | 15s | 79058 / 659 / 13456 | 1 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 3 | fail | not-finished | context overflow | 4 | 6 (0) | 8s | 14048 / 295 / 10856 | 0 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 3 | fail | error | context overflow | 6 | 6 (0) | 9s | 46098 / 316 / 15859 | 0 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 3 | fail | refuted | no valid edit: reviewer refusal | 14 | 14 (0) | 25s | 109290 / 1441 / 10121 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 3 | fail | not-finished | context overflow | 8 | 8 (0) | 15s | 67604 / 581 / 16244 | 0 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 3 | fail | error | context overflow | 10 | 10 (2) | 29s | 57110 / 2443 / 14554 | 0 | +0/-0, 0 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 3 | fail | refuted | no valid edit: reviewer refusal | 4 | 4 (0) | 11s | 21508 / 802 / 7170 | 1 | +0/-0, 0 | no |
