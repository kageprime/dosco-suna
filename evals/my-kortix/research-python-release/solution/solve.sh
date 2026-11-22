#!/bin/bash
set -e
v=$(curl -sL -m 30 https://www.python.org/downloads/ | grep -oE 'Download Python [0-9]+\.[0-9]+\.[0-9]+' | head -1 | awk '{print $3}')
mkdir -p /logs/agent; echo "The latest stable release is Python ${v}. Source: https://www.python.org/downloads/" > /logs/agent/response.md
