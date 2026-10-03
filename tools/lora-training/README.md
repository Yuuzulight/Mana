# Mana Multi-LoRA Training & Serving Architecture (#1343)

This directory contains the dataset synthesis, QLoRA fine-tuning, and GGUF conversion tooling for Mana's Everyday Resident Brain (`Qwen3.5-9B-heretic-v2`).

## Architecture Specification

- **Everyday Resident Model**: `Qwen3.5-9B-heretic-v2-Q4_K_M.gguf` (~5.6 GB VRAM resident).
- **Casual Banter / Persona**: `mana-companion.gguf` ($r=16, \alpha=32$, ~45 MB).
- **Desktop Tools & Automation**: `mana-assistant.gguf` ($r=32, \alpha=64$, ~180 MB).
- **Vision Screen Glances / OCR**: `mmproj-Qwen3.5-9B-heretic-v2-Q8_0.gguf` (~0.6 GB VRAM).
- **On-Demand Engineering Engine**: `Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf` (~8.98 GB, loaded on NVMe SSD on demand during sticky coding sessions, masked by Qwen3-TTS).

Dynamic adapter routing operates sub-15ms via `llama-server` `--lora-init-without-apply` and `POST /lora-adapters` without reloading the base model.

## Workflow

### 1. Synthesize Datasets
Generates ~1,500 companion dialogue turns and ~4,500 assistant function calling / negative rejection samples:
```bash
python synthesize_datasets.py
```

### 2. Fine-Tune QLoRA Adapters
Runs PEFT / QLoRA training with completion-only loss masking on `<|im_start|>assistant\n`:
```bash
# Fine-tune companion adapter (r=16, alpha=32)
python train_lora.py --mode companion

# Fine-tune assistant adapter (r=32, alpha=64)
python train_lora.py --mode assistant
```

### 3. Convert Adapters to GGUF
Exports trained safetensors into `.gguf` format ready for `llama-server.exe`:
```bash
python convert_lora_to_gguf.py --input-dir adapters/mana-companion --output-file ../llama/gguf-models/loras/mana-companion.gguf
python convert_lora_to_gguf.py --input-dir adapters/mana-assistant --output-file ../llama/gguf-models/loras/mana-assistant.gguf
```
