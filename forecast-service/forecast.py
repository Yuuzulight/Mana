"""Issue #358: a forecasting step for the market tools.

Reads a JSON request on stdin and writes a JSON response on stdout, in the
same shape as the other Python helpers Mana shells out to. Deliberately a
one-shot script rather than a long-running service: forecasting happens when
somebody asks a market question, not continuously, and a resident process
would hold RAM the model stack wants.

CPU-only by design (see the issue): 200M parameters is trivial on CPU, and
the point is not to compete with the LLM for VRAM.
"""

import json
import os
import sys

WEIGHTS_REPO = os.environ.get("MANA_TIMESFM_REPO", "google/timesfm-2.5-200m-pytorch")
DEFAULT_HORIZON = 7
# TimesFM is zero-shot, but it still needs enough context to see a shape.
# Below this a forecast is a confident guess about nothing, and saying so is
# more useful than returning one.
MIN_POINTS = 16


def fail(reason, **extra):
    print(json.dumps({"ok": False, "reason": reason, **extra}))
    sys.exit(0)


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        fail(f"invalid request json: {exc}")

    values = [float(v) for v in request.get("values") or []]
    horizon = int(request.get("horizon") or DEFAULT_HORIZON)

    if len(values) < MIN_POINTS:
        fail(
            "not enough history to forecast",
            have=len(values),
            need=MIN_POINTS,
        )

    try:
        import numpy as np
        from huggingface_hub import snapshot_download
        from timesfm.timesfm_2p5.timesfm_2p5_torch import TimesFM_2p5_200M_torch
        from timesfm import ForecastConfig
    except Exception as exc:  # noqa: BLE001 - report rather than crash
        fail(f"forecasting dependencies unavailable: {exc}")

    try:
        path = snapshot_download(WEIGHTS_REPO)
        model = TimesFM_2p5_200M_torch()
        # torch.compile needs a C++ toolchain (MSVC cl.exe on Windows) and
        # fails outright without one. A 200M model on CPU does not need the
        # compile step, and requiring build tools to forecast a market price
        # would be a strange dependency to inherit.
        model.load_checkpoint(path, torch_compile=False)
        model.compile(
            ForecastConfig(
                max_context=max(64, len(values)),
                max_horizon=horizon,
                normalize_inputs=True,
                use_continuous_quantile_head=True,
            )
        )
        point, quantiles = model.forecast(horizon=horizon, inputs=[np.array(values)])
    except Exception as exc:  # noqa: BLE001
        # A missing download, an offline machine, or an incompatible
        # checkpoint should degrade the market answer, not break it.
        fail(f"forecast failed: {exc}")

    forecast = [round(float(v), 2) for v in list(point[0])[:horizon]]
    print(
        json.dumps(
            {
                "ok": True,
                "horizon": horizon,
                "forecast": forecast,
                "contextPoints": len(values),
            }
        )
    )


if __name__ == "__main__":
    main()
