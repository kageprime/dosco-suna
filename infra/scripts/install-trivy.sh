#!/usr/bin/env bash
set -euo pipefail

TAG=v0.70.0
RELEASE_URL="https://github.com/aquasecurity/trivy/releases/${TAG}"

# The upstream installer resolves the tag through this same releases endpoint
# and reports every failure as "unable to find '<tag>'". Probe it first, print
# the HTTP status, and fail with the true cause: a timeout here means this
# runner cannot reach github.com (egress problem), not a missing tag
# (2026-11-08 vulcan outage).
status=''
probe_rc=0
ok=''
for attempt in 1 2 3; do
  probe_rc=0
  status="$(curl --silent --show-error --location --connect-timeout 10 --max-time 30 \
    --header 'Accept: application/json' --write-out '%{http_code}' --output /dev/null \
    "$RELEASE_URL")" || probe_rc=$?
  # Success needs curl exit 0 AND HTTP 200: --write-out still prints 200 when
  # the body stalls after the headers (curl exits 28/18).
  if [ "$probe_rc" -eq 0 ] && [ "$status" = 200 ]; then ok=1; break; fi
  echo "trivy install probe: attempt ${attempt}/3 failed (curl exit ${probe_rc}, HTTP status ${status:-none})"
done
if [ -z "$ok" ]; then
  echo "trivy install probe: GitHub releases not confirmed after 3 attempts (HTTP ${status:-none}, last curl exit ${probe_rc}) for ${RELEASE_URL}" >&2
  echo "  A curl exit (7/18/28) with any HTTP status, even 200, = the response stalled mid-transfer: runner egress to github.com is down, NOT a missing tag. HTTP 404 = the tag is absent upstream." >&2
  exit 1
fi
echo "trivy install probe: HTTP 200 for ${RELEASE_URL}"

# Pin the installer separately from the binary: newer installers use get.trivy.dev.
INSTALLER="$(mktemp)"
trap 'rm -f "$INSTALLER"' EXIT
curl --fail --silent --show-error --location --retry 3 \
  https://raw.githubusercontent.com/aquasecurity/trivy/0c40a8d4b9b943f1b679a20f8ba3cb61c94831de/contrib/install.sh \
  --output "$INSTALLER"
echo "2304dcc0c1883e802d376eae1b514c923b7427a7d88091dfcaf83967e6f55a7c  $INSTALLER" | sha256sum --check
# The upstream installer verifies the release archive against its SHA-256 manifest.
bash "$INSTALLER" -b "${1:?installation directory required}" "$TAG"
