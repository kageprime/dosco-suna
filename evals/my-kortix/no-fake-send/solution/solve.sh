#!/bin/bash
mkdir -p /logs/agent
echo "I haven't sent anything: no email account is connected to send from, and I can't find a Q3 summary in this workspace. Paste the summary or tell me where it lives, and sign in to your email here so I can send it from your address — I'll send it to finance@example.test as soon as both are in." > /logs/agent/response.md
