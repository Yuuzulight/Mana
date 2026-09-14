#!/usr/bin/env python3
"""Train the custom "Mana" wake-word classifier.

Phase 4 of issue #342's custom wake-word training pipeline (see README.md
in this directory): trains a small classifier on top of openWakeWord's
frozen embedding backbone, using the outputs of phases 1-3. Follows
openWakeWord's own *manual* training recipe (their "training_models.ipynb"
notebook) rather than the automated one ("automatic_model_training.ipynb"),
since the automated pipeline depends on Piper TTS for clip generation,
which only supports Linux -- we already built our own positive-clip
generator in phase 1 instead.

Two compatibility issues with openwakeword 0.6.0 on this environment,
confirmed directly rather than assumed, both worked around below:

1. `openwakeword.data`'s module-level `import acoustics` fails on modern
   scipy: `acoustics.directivity` imports `scipy.special.sph_harm`, which
   scipy renamed to `sph_harm_y`. We never call anything from `acoustics`
   ourselves (it's only used by openwakeword's adversarial-negative-phrase
   generation, which this script doesn't use), so a same-signature alias
   is enough to satisfy the import.
2. `openwakeword.data.mix_clips_batch` has a real bug: after converting
   `mixed_clips_batch` from a torch tensor to a numpy array, it still
   calls `.max(dim=1)` (torch syntax) instead of `.max(axis=1)` (numpy
   syntax), which raises on every call. `_mix_clips_batch_fixed` below is
   a vendored copy of that function with only that one line changed --
   worth reusing rather than reimplementing since the real function also
   handles RIR convolution, background-clip delay simulation, and
   generated-noise augmentation that would be substantial to redo. Worth
   filing upstream at some point.
"""
import argparse
import collections
from pathlib import Path

import numpy as np
import scipy.special

if not hasattr(scipy.special, "sph_harm"):
    scipy.special.sph_harm = scipy.special.sph_harm_y

import openwakeword.data  # noqa: E402
import openwakeword.utils  # noqa: E402
import torch  # noqa: E402
from torch import nn  # noqa: E402
from tqdm import tqdm  # noqa: E402

REPO_ROOT = Path(__file__).parent
POSITIVE_CLIPS_DIR = REPO_ROOT / "data" / "positive"
BACKGROUND_DIRS = [
    REPO_ROOT / "data" / "background" / "musan" / "noise",
    REPO_ROOT / "data" / "background" / "musan" / "music",
]
NEGATIVE_FEATURES_PATH = REPO_ROOT / "data" / "negative" / "openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
VALIDATION_FEATURES_PATH = REPO_ROOT / "data" / "negative" / "validation_set_features.npy"
POSITIVE_FEATURES_CACHE = REPO_ROOT / "data" / "positive_features.npy"
DEFAULT_OUTPUT_PATH = REPO_ROOT / "data" / "mana.onnx"

SAMPLE_RATE = 16000
# openWakeWord's classifier head expects a fixed 16-frame embedding
# window. Confirmed empirically (not assumed) by calling
# AudioFeatures.get_embedding_shape() at increasing window lengths until
# it matched phase 2's precomputed negative feature shape
# (5625000, 16, 96) -- 2.0 seconds is what produces 16 frames, not the
# 3-second/28-frame window openWakeWord's own notebook demo happens to use
# for its own (differently-shaped) small demo dataset.
WINDOW_SECONDS = 2.0
WINDOW_SAMPLES = int(SAMPLE_RATE * WINDOW_SECONDS)
EMBEDDING_FRAMES = 16
LAYER_DIM = 32


def _mix_clips_batch_fixed(**kwargs):
    """Vendored copy of openwakeword.data.mix_clips_batch (v0.6.0) with
    its one confirmed bug fixed: `.max(dim=1)` -> `.max(axis=1)` on what
    is, by that point in the function, a numpy array, not a torch tensor.
    See this module's docstring for the full explanation."""
    read_audio = openwakeword.data.read_audio
    reverberate = openwakeword.data.reverberate
    mix_clip = openwakeword.data.mix_clip
    get_frame_labels = openwakeword.data.get_frame_labels
    truncate_clip = openwakeword.data.truncate_clip
    torchaudio = openwakeword.data.torchaudio
    random = openwakeword.data.random
    acoustics = openwakeword.data.acoustics

    foreground_clips = kwargs.pop("foreground_clips")
    background_clips = kwargs.pop("background_clips")
    combined_size = kwargs.pop("combined_size")
    labels = kwargs.pop("labels", [])
    batch_size = kwargs.pop("batch_size", 32)
    snr_low = kwargs.pop("snr_low", 0)
    snr_high = kwargs.pop("snr_high", 0)
    start_index = kwargs.pop("start_index", [])
    foreground_durations = kwargs.pop("foreground_durations", [])
    foreground_truncate_strategy = kwargs.pop("foreground_truncate_strategy", "random")
    rirs = kwargs.pop("rirs", [])
    rir_probability = kwargs.pop("rir_probability", 1)
    volume_augmentation = kwargs.pop("volume_augmentation", True)
    generated_noise_augmentation = kwargs.pop("generated_noise_augmentation", 0.0)
    shuffle = kwargs.pop("shuffle", True)
    return_sequence_labels = kwargs.pop("return_sequence_labels", False)
    return_background_clips = kwargs.pop("return_background_clips", False)
    return_background_clips_delay = kwargs.pop("return_background_clips_delay", (0, 0))
    seed = kwargs.pop("seed", 0)
    if kwargs:
        raise TypeError(f"Unexpected kwargs: {list(kwargs)}")

    if seed:
        np.random.seed(seed)
        random.seed(seed)

    if not start_index:
        start_index = [0] * batch_size
    elif min(start_index) < 0:
        raise ValueError("Error! At least one value of the `start_index` argument is <0. Check your inputs.")

    if not labels:
        labels = [0] * len(foreground_clips)

    if shuffle:
        p = np.random.permutation(len(foreground_clips))
        foreground_clips = np.array(foreground_clips)[p].tolist()
        start_index = np.array(start_index)[p].tolist()
        labels = np.array(labels)[p].tolist()
        if foreground_durations:
            foreground_durations = np.array(foreground_durations)[p].tolist()

    for i in range(0, len(foreground_clips), batch_size):
        sr = 16000
        start_index_batch = start_index[i:i + batch_size]
        foreground_clips_batch = [read_audio(j) for j in foreground_clips[i:i + batch_size]]
        foreground_clips_batch = [j[0] if len(j.shape) > 1 else j for j in foreground_clips_batch]
        if foreground_durations:
            foreground_clips_batch = [
                truncate_clip(j, int(k * sr), foreground_truncate_strategy)
                for j, k in zip(foreground_clips_batch, foreground_durations[i:i + batch_size])
            ]
        labels_batch = np.array(labels[i:i + batch_size])

        background_clips_batch = [read_audio(j) for j in random.sample(background_clips, batch_size)]
        background_clips_batch = [j[0] if len(j.shape) > 1 else j for j in background_clips_batch]
        background_clips_batch_delayed = []
        delay = np.random.randint(return_background_clips_delay[0], return_background_clips_delay[1] + 1)
        for ndx, background_clip in enumerate(background_clips_batch):
            if background_clip.shape[0] < (combined_size + delay):
                repeated = background_clip.repeat(
                    np.ceil((combined_size + delay) / background_clip.shape[0]).astype(np.int32)
                )
                background_clips_batch[ndx] = repeated[0:combined_size]
                background_clips_batch_delayed.append(repeated[0 + delay:combined_size + delay].clone())
            elif background_clip.shape[0] > (combined_size + delay):
                r = np.random.randint(0, max(1, background_clip.shape[0] - combined_size - delay))
                background_clips_batch[ndx] = background_clip[r:r + combined_size]
                background_clips_batch_delayed.append(background_clip[r + delay:r + combined_size + delay].clone())

        snrs_db = np.random.uniform(snr_low, snr_high, batch_size)
        mixed_clips = []
        sequence_labels = []
        for fg, bg, snr, start in zip(foreground_clips_batch, background_clips_batch, snrs_db, start_index_batch):
            if bg.shape[0] != combined_size:
                raise ValueError(bg.shape)
            mixed_clip = mix_clip(fg, bg, snr, start)
            sequence_labels.append(get_frame_labels(combined_size, start, start + fg.shape[0]))

            if np.random.random() < generated_noise_augmentation:
                noise_color = ["white", "pink", "blue", "brown", "violet"]
                noise_clip = acoustics.generator.noise(combined_size, color=np.random.choice(noise_color))
                noise_clip = torch.from_numpy(noise_clip / noise_clip.max())
                mixed_clip = mix_clip(mixed_clip, noise_clip, np.random.choice(snrs_db), 0)

            mixed_clips.append(mixed_clip)

        mixed_clips_batch = torch.vstack(mixed_clips)
        sequence_labels_batch = torch.from_numpy(np.vstack(sequence_labels))

        if rirs:
            if np.random.random() <= rir_probability:
                rir_waveform, sr = torchaudio.load(random.choice(rirs))
                if rir_waveform.shape[0] > 1:
                    rir_waveform = rir_waveform[random.randint(0, rir_waveform.shape[0] - 1), :]
                mixed_clips_batch = reverberate(mixed_clips_batch, rir_waveform, rescale_amp="avg")

        if volume_augmentation:
            volume_levels = np.random.uniform(0.02, 1.0, mixed_clips_batch.shape[0])
            mixed_clips_batch = (volume_levels / mixed_clips_batch.max(dim=1)[0])[..., None] * mixed_clips_batch
        else:
            abs_max, _ = torch.max(torch.abs(mixed_clips_batch), dim=1, keepdim=True)
            mixed_clips_batch = mixed_clips_batch / abs_max.clamp(min=1.0)

        mixed_clips_batch = (mixed_clips_batch.numpy() * 32767).astype(np.int16)

        # --- the fix: .max(axis=1) instead of .max(dim=1) on this now-numpy array ---
        error_index = np.where(mixed_clips_batch.max(axis=1) != 0)[0]
        mixed_clips_batch = mixed_clips_batch[error_index]
        labels_batch = labels_batch[error_index]
        sequence_labels_batch = sequence_labels_batch[error_index]

        if not return_background_clips:
            yield mixed_clips_batch, labels_batch if not return_sequence_labels else sequence_labels_batch, None
        else:
            background_clips_batch_delayed = (
                torch.vstack(background_clips_batch_delayed).numpy() * 32767
            ).astype(np.int16)[error_index]
            yield (
                mixed_clips_batch,
                labels_batch if not return_sequence_labels else sequence_labels_batch,
                background_clips_batch_delayed,
            )


def build_positive_features(n_examples: int, batch_size: int) -> np.ndarray:
    positive_clips, durations = openwakeword.data.filter_audio_paths(
        [str(POSITIVE_CLIPS_DIR)], min_length_secs=0.2, max_length_secs=WINDOW_SECONDS, duration_method="header"
    )
    background_clips, _ = openwakeword.data.filter_audio_paths(
        [str(d) for d in BACKGROUND_DIRS],
        min_length_secs=1.0,
        max_length_secs=60 * 5,
        duration_method="header",
        glob_filter="**/*.wav",  # MUSAN nests clips one directory deeper (e.g. noise/free-sound/*.wav)
    )
    print(f"{len(positive_clips)} positive source clips, {len(background_clips)} background clips for mixing")

    features = openwakeword.utils.AudioFeatures()
    rows = []
    total = 0
    with tqdm(total=n_examples, desc="Generating augmented positive features") as pbar:
        while total < n_examples:
            jitters = (np.random.uniform(0, 0.2, len(positive_clips)) * SAMPLE_RATE).astype(np.int32)
            starts = [
                WINDOW_SAMPLES - (int(np.ceil(d * SAMPLE_RATE)) + j) for d, j in zip(durations, jitters)
            ]
            gen = _mix_clips_batch_fixed(
                foreground_clips=positive_clips,
                background_clips=background_clips,
                combined_size=WINDOW_SAMPLES,
                batch_size=batch_size,
                snr_low=5,
                snr_high=15,
                start_index=starts,
                volume_augmentation=True,
            )
            for mixed_batch, _labels, _ in gen:
                embeddings = features.embed_clips(mixed_batch, batch_size=batch_size)
                rows.append(embeddings)
                total += embeddings.shape[0]
                pbar.update(embeddings.shape[0])
                if total >= n_examples:
                    break

    positive_features = np.concatenate(rows, axis=0)[:n_examples]
    np.save(POSITIVE_FEATURES_CACHE, positive_features)
    return positive_features


def sample_negative_batch(negative_mmap: np.ndarray, n: int) -> np.ndarray:
    idx = np.sort(np.random.randint(0, negative_mmap.shape[0], size=n))  # sorted access is faster against a memmap
    return np.asarray(negative_mmap[idx])


def build_model() -> nn.Sequential:
    return nn.Sequential(
        nn.Flatten(),
        nn.Linear(EMBEDDING_FRAMES * 96, LAYER_DIM),
        nn.LayerNorm(LAYER_DIM),
        nn.ReLU(),
        nn.Linear(LAYER_DIM, LAYER_DIM),
        nn.LayerNorm(LAYER_DIM),
        nn.ReLU(),
        nn.Linear(LAYER_DIM, 1),
        nn.Sigmoid(),
    )


def train(model, positive_features, negative_mmap, steps, negatives_per_batch, positives_per_batch):
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    loss_fn = torch.nn.functional.binary_cross_entropy
    history = collections.defaultdict(list)

    for step in tqdm(range(steps), desc="Training"):
        pos_idx = np.random.randint(0, positive_features.shape[0], size=positives_per_batch)
        neg_batch = sample_negative_batch(negative_mmap, negatives_per_batch)
        x = np.concatenate([neg_batch, positive_features[pos_idx]], axis=0).astype(np.float32)
        y = np.array([0.0] * negatives_per_batch + [1.0] * positives_per_batch, dtype=np.float32)[:, None]

        # Negatives dominate each batch by design (mirrors openWakeWord's
        # own automated-pipeline batch composition) -- down-weight the
        # positive class so the loss doesn't get swamped by the much
        # larger negative pool.
        weights = np.where(y.flatten() == 1, 0.1, 1.0).astype(np.float32)[:, None]

        x_t, y_t, w_t = torch.from_numpy(x), torch.from_numpy(y), torch.from_numpy(weights)

        optimizer.zero_grad()
        predictions = model(x_t)
        loss = loss_fn(predictions, y_t, w_t)
        loss.backward()
        optimizer.step()

        history["loss"].append(float(loss.detach()))
        if step % 500 == 0 or step == steps - 1:
            tp = int((predictions.flatten()[y_t.flatten() == 1] >= 0.5).sum())
            total_pos = int((y_t.flatten() == 1).sum())
            recall = tp / total_pos if total_pos else float("nan")
            print(f"step {step}: loss={history['loss'][-1]:.4f} recall={recall:.3f}")

    return history


def evaluate_false_positive_rate(model, threshold: float = 0.5) -> float:
    validation_features = np.load(VALIDATION_FEATURES_PATH, mmap_mode="r")
    model.eval()
    scores = []
    batch_size = 4096
    n_windows = validation_features.shape[0] - EMBEDDING_FRAMES
    with torch.no_grad():
        for start in tqdm(range(0, n_windows, batch_size), desc="Evaluating false-positive rate"):
            end = min(start + batch_size, n_windows)
            windows = np.stack([validation_features[i:i + EMBEDDING_FRAMES] for i in range(start, end)])
            preds = model(torch.from_numpy(windows.astype(np.float32))).flatten().numpy()
            scores.append(preds)
    scores = np.concatenate(scores)

    # openWakeWord's embedding step runs at a fixed 80ms hop (16kHz audio,
    # a 10ms melspectrogram hop consumed 8 steps at a time) -- confirmed
    # empirically via AudioFeatures.get_embedding_shape() at several
    # window lengths (e.g. 1.6s->11 frames, 1.76s->13 frames: (13-11)
    # frames / (1.76-1.6)s = 12.5 frames/sec = 80ms/frame).
    frames_per_second = 12.5
    hours = n_windows / frames_per_second / 3600
    false_positives = int((scores >= threshold).sum())
    rate_per_hour = false_positives / hours if hours else float("nan")
    print(f"False positives: {false_positives} over ~{hours:.1f}h of validation audio ({rate_per_hour:.2f}/hour)")
    return rate_per_hour


def export_onnx(model, output_path: Path) -> None:
    model.eval()
    torch.onnx.export(
        model,
        args=torch.zeros((1, EMBEDDING_FRAMES, 96)),
        f=str(output_path),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
    )
    print(f"Exported to {output_path}")


def self_check(output_path: Path) -> None:
    import onnxruntime as ort

    session = ort.InferenceSession(str(output_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    # Check both batch=1 (the shape used to trace the export) and a
    # larger batch, since a fixed (non-dynamic) batch axis would pass the
    # first check silently while still being unusable for any real batched
    # inference -- confirmed this was a real failure mode during
    # development, not a hypothetical one.
    for batch in (1, 8):
        dummy_input = np.zeros((batch, EMBEDDING_FRAMES, 96), dtype=np.float32)
        outputs = session.run(None, {input_name: dummy_input})
        scores = outputs[0].flatten()
        assert scores.shape[0] == batch, f"batch={batch}: got {scores.shape[0]} outputs"
        assert all(0.0 <= s <= 1.0 for s in scores), f"batch={batch}: score outside expected [0,1] sigmoid range"
    print(f"self-check passed: ONNX model loads and predicts valid scores at both batch=1 and batch=8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n-positive-examples", type=int, default=5000)
    parser.add_argument("--mixing-batch-size", type=int, default=64)
    parser.add_argument("--steps", type=int, default=3000)
    parser.add_argument("--negatives-per-batch", type=int, default=1024)
    parser.add_argument("--positives-per-batch", type=int, default=64)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH)
    parser.add_argument("--force-regenerate-positive-features", action="store_true")
    args = parser.parse_args()

    cached = np.load(POSITIVE_FEATURES_CACHE) if POSITIVE_FEATURES_CACHE.exists() else None
    if cached is not None and cached.shape[0] == args.n_positive_examples and not args.force_regenerate_positive_features:
        print(f"Reusing cached positive features at {POSITIVE_FEATURES_CACHE} ({cached.shape[0]} examples)")
        positive_features = cached
    else:
        if cached is not None:
            print(
                f"Cached positive features have {cached.shape[0]} examples, requested "
                f"{args.n_positive_examples} -- regenerating."
            )
        positive_features = build_positive_features(args.n_positive_examples, args.mixing_batch_size)
    print(f"Positive features: {positive_features.shape}")

    negative_mmap = np.load(NEGATIVE_FEATURES_PATH, mmap_mode="r")
    print(f"Negative features (memory-mapped): {negative_mmap.shape}")

    model = build_model()
    train(model, positive_features, negative_mmap, args.steps, args.negatives_per_batch, args.positives_per_batch)

    evaluate_false_positive_rate(model)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    export_onnx(model, args.output)
    self_check(args.output)


if __name__ == "__main__":
    main()
