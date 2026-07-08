#!/usr/bin/env python
"""Tight-crop existing sprite PNGs to remove extra transparent/background margins.
Usage: python scripts/crop_tight.py [path1 path2 ...]
If no args provided, defaults to node-bot/admin/sprite-speak.png and sprite-idle.png
"""
from PIL import Image
import sys
import os

DEFAULTS = [
    os.path.join(os.path.dirname(__file__), '..', 'node-bot', 'admin', 'sprite-speak.png'),
    os.path.join(os.path.dirname(__file__), '..', 'node-bot', 'admin', 'sprite-idle.png'),
]

# optional pad argument
pad_arg = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else None
paths = sys.argv[2:] if pad_arg is not None and len(sys.argv) > 2 else (sys.argv[1:] if len(sys.argv) > 1 and not sys.argv[1].isdigit() else DEFAULTS)

# default pad if not passed
pad = pad_arg if pad_arg is not None else 0

for p in paths:
    p = os.path.abspath(p)
    if not os.path.exists(p):
        print('Missing', p)
        continue
    im = Image.open(p).convert('RGBA')
    print('Processing', p, 'size', im.size)
    # Use alpha channel if present
    alpha = im.split()[-1]
    bbox = alpha.getbbox()
    if not bbox:
        # fallback: compute bbox from luminance threshold
        gray = im.convert('L')
        bbox = gray.point(lambda v: 255 if v > 16 else 0).getbbox()
    if not bbox:
        print('Could not determine content bbox for', p)
        continue
    # apply pad
    left = max(0, bbox[0] - pad)
    upper = max(0, bbox[1] - pad)
    right = min(im.width, bbox[2] + pad)
    lower = min(im.height, bbox[3] + pad)
    cropped = im.crop((left, upper, right, lower))
    cropped.save(p)
    print('Saved tight-cropped', p, 'new size', cropped.size)
print('Done')
