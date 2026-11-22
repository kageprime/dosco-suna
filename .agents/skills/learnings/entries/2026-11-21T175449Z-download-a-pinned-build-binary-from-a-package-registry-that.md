---
recorded: 2026-11-21T17:54:49Z
incident_date: 2026-11-17
---
# Download a pinned build binary from a package registry that keeps every published version

**Rule:** Download a third-party binary that a build pins by SHA-256 from a package registry that keeps
every published version (NuGet, npm, PyPI, crates.io), not from a GitHub release of the
upstream repository. A repository can disappear; a pin then only fails the build.

**Trigger surface:** Adding or changing a build or app step that downloads a prebuilt library or tool
(`urlopen`, `curl`, `reqwest` on a `github.com/<org>/<repo>/releases/download` URL).

**Incident:** 2026-11-17: github.com/microsoft/onnxruntime started to answer 404. Every Kortix Capture
installer build downloads ONNX Runtime 1.23.2 (`apps/capture/scripts/install_privacy_runtime.py`)
and failed from v0.16.0 on. The latest GitHub Release then had no Capture assets, so the
`releases/latest/download/KortixCapture-*` install commands in the docs answered 404, and the
failed builds held back the mobile release (see the Deploy Prod follower entry). The fix takes
Microsoft's NuGet package Microsoft.ML.OnnxRuntime 1.23.2 under a new SHA-256 pin, in the
build script and in the app's own fallback download.

**Enforcement:** none yet: a CI check that lists `releases/download` URLs in build scripts and fails on a host
other than a registry. Today the SHA-256 pin only turns a vanished or changed file into a
build failure; it does not prevent one.
