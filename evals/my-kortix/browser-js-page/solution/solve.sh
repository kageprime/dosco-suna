#!/bin/bash
set -e
agent-browser open https://quotes.toscrape.com/js/ >/dev/null
agent-browser wait 2000 >/dev/null 2>&1 || sleep 2
agent-browser screenshot /tmp/quotes.png >/dev/null
author=$(agent-browser eval "document.querySelector('.quote .author').textContent" 2>/dev/null | tr -d '"' | tail -1)
agent-browser close >/dev/null 2>&1 || true
kortix drive put /tmp/quotes.png "~/From sessions/Quotes page/quotes.png"
mkdir -p /logs/agent; echo "The first quote is by ${author}. Screenshot saved to Drive › My files › From sessions › Quotes page › quotes.png" > /logs/agent/response.md
