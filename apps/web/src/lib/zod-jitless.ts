/**
 * zod compiles object parsers with `new Function` when eval is allowed, and
 * tests that once with a caught `Function("")`. Our CSP blocks eval, so zod
 * always uses its interpreted parsers, but the test itself still fired a CSP
 * report on every page load (53 % of `[csp-report]` warnings, 2026-11-12).
 * `jitless` skips the test; parsing is unchanged.
 *
 * Import this module first in `instrumentation-client.ts`: imports run before
 * the importing module's body, and a module imported earlier can parse a zod
 * schema at load time, which runs the test.
 */
import { config } from 'zod';

config({ jitless: true });
