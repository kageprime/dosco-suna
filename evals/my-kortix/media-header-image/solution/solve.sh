#!/bin/bash
set -e
python3 - <<'PY'
import struct, zlib
w, h = 1536, 512
rows = b''.join(b'\x00' + bytes((min(255, 120 + y // 3), min(255, 60 + y // 4), 40) * w) for y in range(h))
chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open('/tmp/header.png', 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
PY
kortix drive put /tmp/header.png "~/From sessions/Newsletter header/header.png"
mkdir -p /logs/agent; echo "✅ Saved to Drive › My files › From sessions › Newsletter header › header.png" > /logs/agent/response.md
