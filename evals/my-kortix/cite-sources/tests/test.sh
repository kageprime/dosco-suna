#!/bin/bash
# cites: a python.org URL. grounded: judged (the version is not checked: it changes over time).
mkdir -p /logs/verifier
f=/workspace/brief.md
cites=0; grep -qE 'https?://([a-z0-9-]+\.)*python\.org' "$f" 2>/dev/null && cites=1
echo "cites python.org: $cites"
echo "{\"cites\": $cites}" > /logs/verifier/reward.json
kortix evals judge \
  --criterion answers="The brief names one Python version as the latest stable release, with a release date. Do not judge whether that version is current: releases after your training data exist, and the cited page is the authority." \
  --criterion concise="The brief is two or three sentences plus the URL, without filler." \
  --input "$f" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
