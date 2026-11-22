#!/bin/bash
# saved: an image is in the person's Drive. wide: wider than tall, at least 512 px wide.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def image_size(path):
    """(width, height) of a PNG, JPEG or WebP file, or None."""
    import struct
    data = open(path, 'rb').read()
    if data[:8] == b'\x89PNG\r\n\x1a\n': return struct.unpack('>II', data[16:24])
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        if data[12:16] == b'VP8X': return (int.from_bytes(data[24:27], 'little') + 1, int.from_bytes(data[27:30], 'little') + 1)
        if data[12:16] == b'VP8 ': return struct.unpack('<HH', data[26:30])
        if data[12:16] == b'VP8L':
            b = int.from_bytes(data[21:25], 'little'); return ((b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1)
    if data[:2] == b'\xff\xd8':
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF: i += 1; continue
            marker, size = data[i + 1], struct.unpack('>H', data[i + 2:i + 4])[0]
            if marker in (0xC0, 0xC1, 0xC2): h, w = struct.unpack('>HH', data[i + 5:i + 9]); return (w, h)
            i += 2 + size
    return None

def drive_image():
    """The newest image in the person's Drive, downloaded, with its size."""
    images = [f for f in drive_files('~') if re.search(r'\.(png|jpe?g|webp)$', str(f.get('name', '')), re.I)]
    images.sort(key=lambda f: str(f.get('mtime') or ''), reverse=True)
    for f in images:
        if drive_get(f.get('path') or f"~/{f['name']}", '/tmp/image.bin'):
            return f, image_size('/tmp/image.bin')
    return None, None
f, size = drive_image()
print(f, size)
save({'saved': 1 if size else 0, 'wide': 1 if size and size[0] > size[1] and size[0] >= 512 else 0})
PY
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
