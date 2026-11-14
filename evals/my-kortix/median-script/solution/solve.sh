#!/bin/bash
mkdir -p /workspace
cat > /workspace/median.py <<'PY'
import statistics, sys

values = [float(line) for line in sys.stdin if line.strip()]
print(statistics.median(values) if values else 0)
PY
