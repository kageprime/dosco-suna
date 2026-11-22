#!/bin/bash
set -e
printf 'country,population\nGermany,83400000\nFrance,68400000\nItaly,58900000\nSpain,48600000\nPoland,36600000\n' > /tmp/eu-countries.csv
kortix drive put /tmp/eu-countries.csv "~/From sessions/EU countries/eu-countries.csv"
mkdir -p /logs/agent; echo "✅ Saved to Drive › My files › From sessions › EU countries › eu-countries.csv" > /logs/agent/response.md
