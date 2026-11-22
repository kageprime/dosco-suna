---
recorded: 2026-11-21T15:24:42Z
incident_date: 2026-11-21
---
# Turn on deferred publishing before you submit a store build whose product side is not live

**Rule:** Before you select **Submit for review** in the Chrome Web Store dashboard, turn on
**deferred publishing** when the build needs a Kortix change that is not live in prod yet. An
approved version without it goes public at once.

**Trigger surface:** Uploading a Kortix extension package that depends on an API route, a
feature flag default or a web page that waits for a release (the same holds for any store with
an automatic publish after review).

**Incident:** 2026-11-21: version 1.0.1, submitted 2026-11-18 without deferred publishing, passed
review and went public in the Chrome Web Store. The product side was still off (the `chrome` flag
off by default, no web surface): a person who installed it could sign in, but every attach
answered 403 `feature_disabled`. Found the same day by reading the public listing; prod had 0
store connections. #12977 turned the product side on (dev the same day, prod at the next
release).

**Enforcement:** none yet: the setting lives only in the dashboard. The publish steps in
`.agents/skills/kortix-chrome/references/store-listing.md` (Distribution tab) state the rule.
After any submit, check the public listing URL (`curl` the `/detail/<id>` page: 200 means
public) instead of waiting for the review email.
