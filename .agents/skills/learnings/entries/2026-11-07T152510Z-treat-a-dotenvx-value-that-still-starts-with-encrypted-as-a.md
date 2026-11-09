---
recorded: 2026-11-07T15:25:10Z
incident_date: 2026-11-07
---
# Treat a dotenvx value that still starts with encrypted: as a failed decrypt, and keep the repo dotenvx on the same major as the Armor login

**Rule:** A dotenvx read succeeded only when the value no longer starts with `encrypted:`. dotenvx 1.x exits 0 and prints the ciphertext when it has no key, and `dotenvx run` exits 0 on both majors. Check the value, never the exit code. Keep the repo's `@dotenvx/dotenvx` on a major that reads the Armor login the dotenvx-secrets skill requires (2.7.1+ keeps the token in the OS keychain; 1.x reads only the settings file).

**Trigger surface:** Any script, hook or launcher that decrypts an `.env` profile (`dotenvx get`, `dotenvx run`); bumping or pinning `@dotenvx/dotenvx`; changing the Armor login instructions.

**Incident:** 2026-11-07. The repo pinned dotenvx 1.75.1 while the skill required a 2.x login, so on a machine with no `.env.keys`, `pnpm dev` and `pnpm worktree start` decrypted nothing; the API failed with "PLATINUM_INFERENCE_URL Must be a valid HTTP(S) URL". The same machine with no global 2.x CLI also disabled the customer-name commit guard without its warning: the guard took the ciphertext as its term list. PR #12037 pins 2.38.2, rejects `encrypted:` output in the guard, and makes the API name undecrypted values.

**Enforcement:** `scripts/check-blocked-terms.test.mjs` "ciphertext from dotenvx with exit 0: warns and allows, never a silent pass" (packages lane, `tests/bin/package-quality.ts`). The API config prints a `dotenvx` warning that lists still-encrypted variables. None yet for the version split itself: a check that the repo dotenvx major matches the login the skill documents.
