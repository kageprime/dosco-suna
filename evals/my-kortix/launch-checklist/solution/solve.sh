#!/bin/bash
mkdir -p /workspace
cat > /workspace/newsletter-launch.md <<'MD'
# Newsletter launch checklist

- [ ] Pick the sending platform and verify the sending domain (SPF, DKIM, DMARC)
- [ ] Write the welcome email new subscribers get
- [ ] Put the signup form on the website and test it end to end
- [ ] Import the existing contacts who agreed to receive email
- [ ] Draft and proofread the first issue
- [ ] Send a test issue to three people on different email clients
- [ ] Schedule the first issue and announce it on social channels
- [ ] Decide which numbers to watch: opens, clicks, unsubscribes
MD
