#!/usr/bin/env python
"""Tight-crop existing sprite PNGs to remove extra transparent/background margins.
Usage: python scripts/crop_tight.py [path1 path2 ...]
If no args provided, defaults to node-bot/admin/sprite-speak.png and sprite-idle.png
"""
from PIL import Image
import sys
import os

DEFAULTS = [
    os.path.join(os.path.dirname(__file__), '..', 'sprites', 'sprite-speak.png'),
    os.path.join(os.path.dirname(__file__), '..', 'sprites', 'sprite-idle.png'),
]

# optional pad argument
pad_arg = None
trim_factor = None
# parse args: optionally numeric pad or trim_factor (float), then file paths
args = sys.argv[1:]
paths = []
for a in args:
    try:
        if '.' in a:
            # float -> trim factor
            trim_factor = float(a)
            continue
        n = int(a)
        pad_arg = n
        continue
    except:
        paths.append(a)

if not paths:
    paths = DEFAULTS

# default pad if not passed
pad = pad_arg if pad_arg is not None else 0
# default trim factor (keep full) unless provided
trim_factor = trim_factor if trim_factor is not None else 1.0

for p in paths:
    p = os.path.abspath(p)
    if not os.path.exists(p):
        print('Missing', p)
        continue
    im = Image.open(p).convert('RGBA')
    print('Processing', p, 'size', im.size)
    # Determine bbox by content
    bbox = None
    # Prefer alpha channel if it exists and meaningful
    alpha = im.split()[-1]
    if alpha.getbbox():
        bbox = alpha.getbbox()
    else:
        # Fallback: non-black pixel detection (image background is dark)
        # thresholdArg allows overriding
        thresh = pad if pad is not None and pad >= 0 else 10
        # create mask where any channel is brighter than threshold
        r,g,b,a = im.split()
        mask = r.point(lambda v: 255 if v > thresh else 0)
        mask2 = g.point(lambda v: 255 if v > thresh else 0)
        mask3 = b.point(lambda v: 255 if v > thresh else 0)
        # combine
        from PIL import ImageChops
        m12 = ImageChops.lighter(mask, mask2)
        m = ImageChops.lighter(m12, mask3)
        bbox = m.getbbox()
    if not bbox:
        print('Could not determine content bbox for', p)
        continue
    # apply pad (use pad variable as padding amount)
    padpx = pad if pad is not None else 2
    left = max(0, bbox[0] - padpx)
    upper = max(0, bbox[1] - padpx)
    right = min(im.width, bbox[2] + padpx)
    lower = min(im.height, bbox[3] + padpx)

    # optionally trim lower portion by trim_factor (0..1) to focus on head
    try:
        tf = float(trim_factor)
        if 0 < tf <= 1.0:
            h = lower - upper
            new_h = max(10, int(h * tf))
            lower = upper + new_h
    except Exception:
        pass

    cropped = im.crop((left, upper, right, lower))
    cropped.save(p)
    print('Saved tight-cropped', p, 'new size', cropped.size)
print('Done')
