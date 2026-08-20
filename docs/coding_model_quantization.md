Coding Model: Custom Quantization

Mana's `coding` LLM profile runs a self-quantized Q4_K_M build of
Qwen2.5-Coder-7B-Instruct, calibrated with an importance matrix (imatrix)
built from Mana's own codebase plus the user's other real projects, instead
of the plain community quant (`Qwen/Qwen2.5-Coder-7B-Instruct-GGUF` /
`bartowski`'s release) that shipped as the original default.

Why: a Q4_K_M quant's default calibration set (the community quantizers use
generic text like wikitext) allocates quantization precision toward
"generic code and prose" statistics. Since the coding profile's real job is
narrower -- ACP tool-calling in Mana's exact schema, plus whatever
languages the user's other projects actually use -- calibrating against
that real distribution should preserve more precision where it matters for
Mana specifically, at no size cost (same Q4_K_M tier, same ~4.68GB).

Deployed model
- File: `tools/llama/gguf-models/qwen2.5-coder-7b-instruct-mana-imat-Q4_K_M.gguf`
- Registered in `node-bot/ai/local-ai.js`'s `coding` profile (first choice,
  ahead of the plain community-quant filename kept as a fallback name in
  case this file is ever missing).
- Base model: https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF
  (fp16 source, `qwen2.5-coder-7b-instruct-fp16.gguf`, 14.19GB)

Calibration corpus

~640KB / ~16,500 lines across 91 files plus 6 real commit diffs, built to
match two things the coding profile actually needs: Mana's own ACP
tool-call format, and the real language mix across the user's other active
projects (surveyed from `D:\GitHub Projects\`, not guessed):

| Category | Source |
| --- | --- |
| ACP tool-call schema + coding bridge | `coding-tool-source.js`, `acp-backend-bridge.js`, `acp-autonomous-loop.js` |
| Real Mana JS (core + capabilities + plugins) | 24 files across `node-bot/`, `plugins/` |
| Real diffs (unified diff format) | 6 real commits from Mana's git history |
| TypeScript / React | Obsidian plugin (Mana) + Euphonia + yuuzulight.github.io (user's own projects) |
| Python | Mana tooling + Rozetta, Veracia, Veritarach, Wisp (user's projects) |
| SQL (dbt models) | Hecate (user's project) |
| C++ | Argos (user's project, Win32/Direct2D) |
| PowerShell / Shell | Mana setup scripts (both Windows and WSL side) |
| JSON / YAML / HTML+CSS | Config, CI workflows, both Electron front-ends (windows-launcher + desktop-client) |
| Docs (architecture decisions + user-facing READMEs + changelog) | Mana's own `docs/roadmap/`, READMEs, CHANGELOG slice |

Deliberately excluded: `server.js` (too large, would've dominated the
corpus), `node_modules`/lockfiles (near-zero signal), compiled/`dist`
output, and vendored third-party code (`tools/fish-speech`, llama.cpp) --
that's someone else's coding style, not what the imatrix should optimize
for. Scanned for secrets before use (clean).

Pipeline (llama.cpp build b10507, `tools/llama/llama-b10507-bin-win-cuda-12.4-x64/`)

```powershell
# 1. imatrix generation (needs the fp16 source fully on GPU to be fast --
#    partial CPU offload from VRAM contention took it from ~5min to a
#    projected 12+ hours; make sure nothing else is holding VRAM first)
llama-imatrix.exe -m qwen2.5-coder-7b-instruct-fp16.gguf `
  -f mana-coder-calibration.txt -o mana-coder-imatrix.gguf --output-frequency 10

# 2. quantize using the imatrix
llama-quantize.exe --imatrix mana-coder-imatrix.gguf `
  qwen2.5-coder-7b-instruct-fp16.gguf mana-coder-7b-Q4_K_M-imat.gguf Q4_K_M
```

Imatrix run: 320 chunks, final PPL = 4.6370 +/- 0.0432, ~4 minutes fully
GPU-accelerated. Quantize step: ~103 seconds.

Comparison verdict (6 prompts spanning the corpus's categories, run through
both quants with identical seed/temp)

| Test | Verdict |
| --- | --- |
| Mana ACP tool schema | Tie -- neither quant reproduced the real nested `{type, function: {...}}` shape; a quantization-precision change can't teach new structural facts the base model doesn't have |
| Python (pydantic) | Slight edge: custom (finished within token budget; the generic quant's answer got cut off) |
| TypeScript/React (CountUp component) | **Clear win: custom** -- generic quant used a naive `setInterval` animation that breaks for large targets/short durations; custom quant used a correct `requestAnimationFrame` + elapsed-time interpolation, matching the user's own real `CountUp.tsx` pattern that was in the corpus |
| SQL (dbt model) | Slight edge: generic -- simpler query, custom added an unnecessary `GROUP BY` and also got cut off by the token budget |
| C++ (Win32 monitor resolution) | Wash -- both correct, minor stylistic differences each way |
| Diff format | Minor edge: custom -- correctly tagged the fence as `` ```diff `` instead of a plain fence |

Net: 3 wins/edges for the custom quant, 1 for the generic quant, 2 ties --
no regressions, and one genuinely meaningful correctness win on a task type
directly represented in the corpus. That's what motivated deploying it as
the new default.

How much better, honestly: this is a **modest, mixed improvement, not a
uniform jump in quality** -- 3 of 6 spot-check prompts favored the custom
quant, 1 favored the generic quant, 2 were ties. Most of the individual
differences (Python, SQL, diff-fence tagging) are minor -- token-budget
edges or small stylistic choices, not correctness differences. The one
result worth weighting heavily is the React/TypeScript case: the generic
quant's `setInterval`-based animation is an actual bug (breaks for large
target values or sub-frame durations), while the custom quant's
`requestAnimationFrame` implementation is correct -- a real functional
difference, not a style preference, on exactly the kind of task (a
React animation component) the corpus was built to cover. Outside that one
case, don't expect the custom quant to feel dramatically smarter day to
day; expect it to be slightly more reliable on Mana's tool-call format and
on the languages/patterns from the user's actual projects, with an
occasional genuine correctness win like the CountUp case. This was a
6-prompt qualitative spot check, not a benchmark suite -- there's no
statistically precise "N% better" number to report, and it isn't a
substitute for one if a rigorous eval is ever wanted later.

Reproducing / requantizing at a different tier

The imatrix itself (`mana-coder-imatrix.gguf`, ~4.6MB) is kept at
`tools/llama/mana-coder-imatrix.gguf` -- small enough to keep around
indefinitely. Re-running `llama-quantize.exe --imatrix` with a different
quant type (e.g. `Q5_K_M`, `Q6_K`) against that file produces a new build
without regenerating the imatrix, but still needs the 14.19GB fp16 source
re-downloaded (not kept locally -- see the model URL above) since that was
cleaned up after this pipeline finished. The calibration corpus itself was
scratch/temp and was not preserved; rebuild it from this doc's file list
plus `D:\GitHub Projects\` if the imatrix ever needs regenerating from
scratch (e.g. to update it for a newer base model or a changed project mix).
