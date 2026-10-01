# Self-work benchmark: (c) +#1209

Model: Qwen3.5-9B-heretic-v2-Q4_K_M.gguf. 10 cases x 3 repeat(s).

**pass@1 13%, pass@3 20%**, passes per repeat 1-2 of 10. 4/30 runs passed.

| Kind | Cases | pass@1 | pass@k | Spread |
| --- | --- | --- | --- | --- |
| multi-file | 1 | 0% | 0% | 0-0 |
| node-bug | 5 | 27% | 40% | 1-2 |
| node-feature | 4 | 0% | 0% | 0-0 |

Failures: context overflow 18, no valid edit: reviewer refusal 7, no valid edit: parse failure 1.

Mean cost of a run: 29s, 9 rounds, 9 tool calls, 68733 prompt / 1460 out tokens, peak prompt 11712, peak VRAM 7434 MB, peak RAM 77%.

| Case | Kind | Run | Hidden test | Ended | Failure | Rounds | Tool calls (errors) | Wall | Tokens (prompt / out / peak) | Calls in text | Diff (+/-, files) | Outside the fix's files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 1 | fail | not-finished | context overflow | 10 | 10 (0) | 29s | 77879 / 1302 / 13886 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 1 | fail | refuted | no valid edit: reviewer refusal | 9 | 10 (1) | 29s | 52216 / 2302 / 8660 | 1 | +1/-1, 1 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 1 | fail | refuted | no valid edit: reviewer refusal | 12 | 12 (0) | 31s | 58443 / 2322 / 7771 | 1 | +0/-0, 0 | no |
| 1072-doctor-gpu-row-that-says-when | node-feature | 1 | fail | not-finished | context overflow | 6 | 6 (0) | 11s | 53349 / 318 / 13730 | 1 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 1 | fail | not-finished | context overflow | 6 | 5 (0) | 8s | 31934 / 251 / 12816 | 0 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 1 | fail | error | context overflow | 6 | 6 (0) | 9s | 45685 / 313 / 15791 | 0 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 1 | fail | not-finished | context overflow | 13 | 13 (0) | 21s | 113305 / 908 / 13445 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 1 | fail | not-finished | context overflow | 15 | 15 (0) | 31s | 121486 / 1857 / 13644 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 1 | fail | refuted | no valid edit: reviewer refusal | 5 | 5 (0) | 43s | 30566 / 4351 / 8195 | 1 | +0/-0, 0 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 1 | pass | finished | - | 9 | 9 (0) | 25s | 76908 / 1709 / 11505 | 0 | +6/-1, 2 | no |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 2 | fail | not-finished | context overflow | 8 | 8 (0) | 15s | 82846 / 590 / 14962 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 2 | pass | not-finished | - | 15 | 18 (1) | 231s | 139242 / 2548 / 14468 | 1 | +7/-1, 2 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 2 | fail | refuted | no valid edit: reviewer refusal | 15 | 15 (0) | 43s | 73107 / 2838 / 7732 | 1 | +4/-1, 2 | node-bot/server.js |
| 1072-doctor-gpu-row-that-says-when | node-feature | 2 | fail | not-finished | context overflow | 8 | 8 (0) | 23s | 76132 / 1414 / 13795 | 1 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 2 | fail | not-finished | context overflow | 7 | 9 (0) | 12s | 34104 / 437 / 13022 | 0 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 2 | fail | not-finished | context overflow | 6 | 6 (0) | 12s | 57649 / 510 / 13709 | 1 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 2 | fail | not-finished | context overflow | 10 | 10 (0) | 17s | 90078 / 673 / 14427 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 2 | fail | not-finished | context overflow | 14 | 14 (0) | 26s | 126549 / 1406 / 13146 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 2 | fail | not-finished | no valid edit: parse failure | 4 | 4 (3) | 5s | 8088 / 188 / 1911 | 1 | +0/-0, 0 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 2 | pass | finished | - | 6 | 6 (0) | 13s | 41766 / 725 / 8899 | 0 | +1/-1, 1 | no |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 3 | fail | not-finished | context overflow | 13 | 13 (0) | 19s | 113329 / 747 / 13629 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 3 | fail | refuted | no valid edit: reviewer refusal | 7 | 7 (0) | 19s | 36632 / 1364 / 7499 | 1 | +1/-1, 1 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 3 | fail | refuted | no valid edit: reviewer refusal | 6 | 6 (0) | 26s | 19687 / 2437 / 4734 | 1 | +0/-0, 0 | no |
| 1072-doctor-gpu-row-that-says-when | node-feature | 3 | fail | error | context overflow | 6 | 6 (0) | 10s | 41049 / 395 / 13893 | 0 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 3 | fail | not-finished | context overflow | 6 | 5 (0) | 9s | 32084 / 424 / 12858 | 0 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 3 | fail | not-finished | context overflow | 6 | 5 (0) | 8s | 30609 / 350 / 12894 | 0 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 3 | fail | not-finished | context overflow | 9 | 9 (0) | 30s | 85317 / 2154 / 13639 | 1 | +3/-3, 1 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 3 | fail | refuted | context overflow | 20 | 20 (0) | 47s | 161150 / 3582 / 13091 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 3 | fail | refuted | no valid edit: reviewer refusal | 9 | 9 (0) | 44s | 79657 / 3953 / 12189 | 1 | +15/-0, 1 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 3 | pass | finished | - | 8 | 9 (0) | 22s | 71139 / 1422 / 11408 | 0 | +8/-1, 2 | no |
