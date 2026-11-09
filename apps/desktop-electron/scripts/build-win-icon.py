#!/usr/bin/env python3
"""Build build/icon.ico, the Windows app icon, from apps/web/public/brand/dosco-crest.png.

Generates crisp multi-resolution icon frames (16, 20, 24, 32, 40, 48, 64, 96, 128, 256 px)
with appropriate margins.

Usage:
  python apps/desktop-electron/scripts/build-win-icon.py
"""
import pathlib
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[3]
SOURCE = ROOT / "apps/web/public/brand/dosco-crest.png"
TARGET = ROOT / "apps/desktop-electron/build/icon.ico"
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]


def frame(img: Image.Image, size: int) -> Image.Image:
    margin = max(1, round(size / 16))
    inner = size - 2 * margin
    resized = img.resize((inner, inner), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, (margin, margin), resized)
    return canvas


crest = Image.open(SOURCE).convert("RGBA")
frames = [frame(crest, s) for s in SIZES]
largest = frames[-1]
largest.save(TARGET, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
print(f"wrote {TARGET.relative_to(ROOT)}: {', '.join(map(str, SIZES))} px")
