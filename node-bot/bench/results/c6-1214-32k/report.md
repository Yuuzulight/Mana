# Self-work benchmark: (c) +#1214, 32k

Model: Qwen3.5-9B-heretic-v2-Q4_K_M.gguf. 10 cases x 3 repeat(s).

**pass@1 13%, pass@3 20%**, passes per repeat 1-2 of 10. 4/30 runs passed.

| Kind | Cases | pass@1 | pass@k | Spread |
| --- | --- | --- | --- | --- |
| multi-file | 1 | 0% | 0% | 0-0 |
| node-bug | 5 | 27% | 40% | 1-2 |
| node-feature | 4 | 0% | 0% | 0-0 |

Failures: out of rounds 15, wrong file 7, no valid edit: bad arguments 2, no valid edit: parse failure 1, no valid edit: reviewer refusal 1.

Mean cost of a run: 67s, 20 rounds, 20 tool calls, 214737 prompt / 4019 out tokens, peak prompt 16338, n/a tokens/s, peak VRAM 8134 MB, peak RAM 80%.

| Case | Kind | Run | Hidden test | Ended | Failure | Rounds | Tool calls (errors) | Wall | Tokens (prompt / out / peak) | Calls in text | Diff (+/-, files) | Outside the fix's files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 1 | fail | not-finished | out of rounds | 23 | 23 (0) | 54s | 247430 / 2132 / 17525 | 1 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 1 | fail | not-finished | out of rounds | 20 | 20 (2) | 34s | 156215 / 1260 / 12431 | 1 | +0/-0, 0 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 1 | fail | not-finished | wrong file | 13 | 11 (1) | 57s | 57295 / 3939 / 10082 | 0 | +30/-0, 1 | no |
| 1072-doctor-gpu-row-that-says-when | node-feature | 1 | fail | not-finished | out of rounds | 20 | 20 (2) | 42s | 249218 / 1906 / 18606 | 1 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 1 | fail | not-finished | wrong file | 29 | 32 (1) | 105s | 398673 / 5413 / 20301 | 1 | +46/-0, 1 | no |
| 1089-model-recommendation-subtract | multi-file | 1 | fail | not-finished | out of rounds | 26 | 26 (3) | 127s | 360923 / 9328 / 20848 | 1 | +34/-6, 2 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 1 | fail | not-finished | out of rounds | 16 | 16 (0) | 36s | 119025 / 1861 / 11762 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 1 | fail | not-finished | out of rounds | 12 | 12 (0) | 26s | 70443 / 1037 / 10301 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 1 | fail | not-finished | out of rounds | 26 | 26 (2) | 107s | 328885 / 7555 / 20973 | 1 | +35/-3, 2 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 1 | pass | not-finished | - | 14 | 14 (0) | 40s | 129609 / 1534 / 13931 | 1 | +4/-5, 2 | no |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 2 | fail | not-finished | out of rounds | 23 | 23 (1) | 60s | 219721 / 3587 / 14946 | 1 | +79/-0, 2 | node-bot/test/acp-test-runner.test.js |
| 1052-put-oneesan-imouto-naming-and | node-bug | 2 | pass | refuted | - | 18 | 18 (1) | 58s | 164045 / 2969 / 14060 | 1 | +7/-1, 2 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 2 | fail | not-finished | out of rounds | 22 | 22 (2) | 119s | 217159 / 9296 / 20035 | 1 | +53/-1, 2 | no |
| 1072-doctor-gpu-row-that-says-when | node-feature | 2 | fail | not-finished | wrong file | 20 | 20 (1) | 79s | 266825 / 4338 / 20979 | 1 | +66/-0, 1 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 2 | fail | not-finished | out of rounds | 29 | 32 (0) | 130s | 416952 / 7019 / 20811 | 1 | +37/-1, 2 | no |
| 1089-model-recommendation-subtract | multi-file | 2 | fail | not-finished | wrong file | 26 | 26 (1) | 71s | 305103 / 4030 / 19325 | 1 | +24/-0, 1 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 2 | fail | not-finished | out of rounds | 16 | 16 (0) | 42s | 171907 / 1777 / 16096 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 2 | fail | not-finished | out of rounds | 12 | 12 (0) | 25s | 64250 / 946 / 8810 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 2 | fail | not-finished | out of rounds | 26 | 26 (1) | 91s | 323210 / 5664 / 19785 | 1 | +25/-4, 2 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 2 | fail | not-finished | wrong file | 14 | 14 (3) | 47s | 123434 / 2393 / 13309 | 1 | +7/-0, 1 | no |
| 1013-acp-mana-test-run-runs-tests-i | node-bug | 3 | fail | not-finished | no valid edit: bad arguments | 18 | 16 (1) | 51s | 113256 / 3506 / 13013 | 0 | +0/-0, 0 | no |
| 1052-put-oneesan-imouto-naming-and | node-bug | 3 | pass | not-finished | - | 20 | 20 (3) | 51s | 166014 / 2533 / 14532 | 1 | +7/-1, 2 | no |
| 1069-alt-tabbing-to-discord-or-obs | node-feature | 3 | fail | not-finished | wrong file | 22 | 22 (2) | 80s | 207124 / 5609 / 19234 | 1 | +32/-0, 2 | node-bot/server.js |
| 1072-doctor-gpu-row-that-says-when | node-feature | 3 | fail | not-finished | no valid edit: bad arguments | 20 | 20 (1) | 47s | 215164 / 2776 / 19680 | 1 | +0/-0, 0 | no |
| 1085-memory-vault-mana-only-writes | node-feature | 3 | fail | not-finished | wrong file | 29 | 29 (1) | 107s | 342911 / 6845 / 20417 | 1 | +30/-0, 1 | no |
| 1089-model-recommendation-subtract | multi-file | 3 | fail | error | no valid edit: parse failure | 26 | 26 (2) | 112s | 275389 / 8202 / 19824 | 0 | +25/-6, 2 | no |
| 1170-discord-bot-can-t-find-discord | node-bug | 3 | fail | not-finished | out of rounds | 16 | 16 (1) | 30s | 182139 / 1172 / 15916 | 1 | +0/-0, 0 | no |
| 897-doctor-warns-about-llama-serve | node-bug | 3 | fail | not-finished | out of rounds | 12 | 12 (0) | 27s | 58247 / 1263 / 8131 | 1 | +0/-0, 0 | no |
| 903-let-me-add-my-own-words-to-the | node-feature | 3 | fail | refuted | no valid edit: reviewer refusal | 26 | 26 (1) | 128s | 356099 / 8990 / 20471 | 1 | +47/-3, 2 | no |
| 921-whisper-keeps-writing-my-wake | node-bug | 3 | pass | not-finished | - | 14 | 14 (0) | 35s | 135456 / 1696 / 14011 | 1 | +5/-1, 2 | no |
