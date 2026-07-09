#!/usr/bin/env python
from PIL import Image
import sys
import os

SRC = sys.argv[1] if len(sys.argv) > 1 else r"C:\ManaAI\Mana\Screenshot 2026-06-19 193421.png"
OUT_DIR = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'sprites')

os.makedirs(OUT_DIR, exist_ok=True)

im = Image.open(SRC).convert('RGBA')
W, H = im.size
print('Loaded', SRC, 'size', W, H)

# convert to grayscale and threshold to find non-background areas
gray = im.convert('L')
# create mask: light pixels considered sprite
mask = gray.point(lambda p: 255 if p > 40 else 0)

# split into left and right halves
mid = W // 2
left_mask = mask.crop((0, 0, mid, H))
right_mask = mask.crop((mid, 0, W, H))

def bbox_from_mask(m):
    bbox = m.getbbox()
    return bbox

lb = bbox_from_mask(left_mask)
rb = bbox_from_mask(right_mask)
print('left bbox', lb, 'right bbox', rb)

pad = 12
if lb:
    lbox = (max(0, lb[0]-pad), max(0, lb[1]-pad), min(mid, lb[2]+pad), min(H, lb[3]+pad))
    left_crop = im.crop(lbox)
    left_out = os.path.join(OUT_DIR, 'sprite-speak.png')
    left_crop.save(left_out)
    print('Saved', left_out)
else:
    print('No non-background detected in left half')

if rb:
    # rb coordinates relative to right mask, translate to full image coords
    rbox = (mid + max(0, rb[0]-pad), max(0, rb[1]-pad), mid + min(W-mid, rb[2]+pad), min(H, rb[3]+pad))
    right_crop = im.crop(rbox)
    right_out = os.path.join(OUT_DIR, 'sprite-idle.png')
    right_crop.save(right_out)
    print('Saved', right_out)
else:
    print('No non-background detected in right half')

print('Done')
