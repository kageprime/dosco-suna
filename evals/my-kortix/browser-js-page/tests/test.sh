#!/bin/bash
# author: the reply names the author of the first quote (the page renders it with JavaScript). screenshot: an image of at least 300 px width is in the person's Drive.
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
page = sh('curl -sL -m 30 https://quotes.toscrape.com/')
m = re.search(r'<small class="author"[^>]*>([^<]+)</small>', page)
if not m:
    print('quotes.toscrape.com did not answer: no truth to grade against'); sys.exit(1)
f, size = drive_image()
print('author', m.group(1), 'image', f, size)
save({'author': 1 if m.group(1).strip().lower() in reply().lower() else 0, 'screenshot': 1 if size and size[0] >= 300 else 0})
PY
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
