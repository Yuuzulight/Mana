# Self-work benchmark: (a) baseline, Qwen3.5-9B

Model: Qwen3.5-9B-heretic-v2-Q4_K_M.gguf. 10 cases x 3 repeat(s).

**pass@1 13%, pass@3 20%**, passes per repeat 1-2 of 10. 4/30 runs passed.

| Kind | Cases | pass@1 | pass@k | Spread |
| --- | --- | --- | --- | --- |
| multi-file | 1 | 0% | 0% | 0-0 |
| node-bug | 5 | 27% | 40% | 1-2 |
| node-feature | 4 | 0% | 0% | 0-0 |

Failures: context overflow 18, no valid edit: reviewer refusal 7, no valid edit: parse failure 1.

Mean cost of a run: 26s, 10 rounds, 10 tool calls, 74234 prompt / 1811 out tokens, peak prompt 12438, peak VRAM 7465 MB, peak RAM 77%.

| Case | Kind | Run | Hidden test | Ended | Failure | Rounds | Tool calls (errors) | Wall | Tokens (prompt / out / peak) | Calls in text | Diff (+/-, files) | Outside the fix's files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 1 | fail | not-finished | context overflow | 13 | 13 (0) | 23s | 85753 / 1084 / 13193 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 1 | pass | not-finished | - | 19 | 19 (3) | 45s | 149149 / 2780 / 13432 | 1 | +7/-1, 2 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 1 | fail | refuted | context overflow | 15 | 15 (0) | 49s | 126821 / 4040 / 13448 | 1 | +12/-0, 1 | no |
| 1072-doctor-gpu-row-that-says-when | node-feature | 1 | fail | not-finished | context overflow | 6 | 6 (0) | 14s | 55477 / 568 / 14918 | 1 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 1 | fail | not-finished | context overflow | 6 | 7 (0) | 10s | 32646 / 324 / 12998 | 0 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 1 | fail | error | context overflow | 7 | 7 (0) | 11s | 57038 / 412 / 13693 | 0 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 1 | fail | not-finished | context overflow | 15 | 15 (0) | 41s | 145364 / 3072 / 13839 | 1 | +2/-2, 1 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 1 | fail | refuted | no valid edit: reviewer refusal | 20 | 20 (0) | 50s | 125448 / 3807 / 10449 | 1 | +1/-0, 1 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 1 | fail | refuted | no valid edit: reviewer refusal | 5 | 5 (0) | 44s | 31912 / 4397 / 8917 | 1 | +0/-0, 0 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 1 | fail | refuted | no valid edit: reviewer refusal | 3 | 4 (0) | 11s | 16684 / 767 / 7077 | 1 | +0/-0, 0 | no |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 2 | fail | not-finished | context overflow | 15 | 15 (0) | 26s | 131518 / 1466 / 14195 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 2 | fail | refuted | no valid edit: reviewer refusal | 13 | 14 (1) | 27s | 96066 / 1618 / 10259 | 1 | +1/-1, 1 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 2 | fail | refuted | no valid edit: reviewer refusal | 9 | 9 (0) | 58s | 52988 / 5605 / 9539 | 1 | +45/-1, 2 | no |
| 1072-doctor-gpu-row-that-says-when | node-feature | 2 | fail | not-finished | context overflow | 6 | 6 (0) | 14s | 56204 / 528 / 14994 | 1 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 2 | fail | error | context overflow | 4 | 7 (0) | 9s | 28824 / 297 / 14925 | 0 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 2 | fail | not-finished | context overflow | 6 | 5 (0) | 7s | 30402 / 252 / 12797 | 0 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 2 | fail | not-finished | context overflow | 12 | 12 (1) | 28s | 95493 / 1907 / 13903 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 2 | fail | not-finished | context overflow | 8 | 7 (0) | 11s | 41379 / 492 / 13080 | 0 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 2 | fail | refuted | no valid edit: reviewer refusal | 6 | 6 (0) | 52s | 49684 / 5288 / 11260 | 1 | +10/-5, 1 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 2 | pass | finished | - | 13 | 13 (0) | 27s | 116426 / 1759 / 11869 | 0 | +6/-1, 2 | no |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 3 | fail | not-finished | context overflow | 17 | 17 (1) | 39s | 146435 / 2885 / 13886 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 3 | pass | not-finished | - | 14 | 14 (0) | 36s | 121367 / 2175 / 13333 | 1 | +7/-1, 2 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 3 | fail | refuted | no valid edit: reviewer refusal | 9 | 9 (0) | 27s | 38703 / 2053 / 6448 | 1 | +0/-0, 0 | no |
| 1072-doctor-gpu-row-that-says-when | node-feature | 3 | fail | not-finished | context overflow | 6 | 6 (0) | 13s | 55934 / 469 / 14933 | 1 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 3 | fail | not-finished | context overflow | 6 | 5 (0) | 7s | 31953 / 257 / 12821 | 0 | +0/-0, 0 | no |
| 1089-model-recommendation-subtract | multi-file | 3 | fail | error | context overflow | 6 | 6 (0) | 9s | 45685 / 321 / 15790 | 0 | +0/-0, 0 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 3 | fail | not-finished | context overflow | 9 | 9 (0) | 23s | 85598 / 1153 / 14861 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 3 | fail | not-finished | context overflow | 8 | 8 (0) | 17s | 69130 / 749 / 13983 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 3 | fail | error | no valid edit: parse failure | 5 | 4 (1) | 22s | 14233 / 2181 / 6617 | 0 | +0/-0, 0 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 3 | pass | finished | - | 10 | 11 (0) | 25s | 92715 / 1637 / 11696 | 0 | +12/-1, 2 | no |
