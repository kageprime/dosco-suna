/**
 * Mechanical rebrand sweep over apps/mobile source + test files:
 *   kortix://   → dosco://     (the app's deep-link scheme, now `dosco` in app.json)
 *   kortix.com  → dosco.live   (the deployed web root, case-insensitive)
 * Internal identifiers (@/components/kortix imports, Kortix* classes,
 * `kortix-*` storage keys, env var names) are intentionally untouched.
 * Run: bun scripts/rebrand-urls.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SKIP = /\\node_modules\\|\\.expo\\|\\build\\|\\android\\|\\ios\\/;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.test(full + '\\')) yield* walk(full);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

const RULES = [
  [/kortix:\/\//g, 'dosco://'],
  [/kortix\.com/gi, 'dosco.live'],
];

const changed = [];
for (const file of walk(root)) {
  const rel = path.relative(root, file);
  if (rel.startsWith('scripts\\rebrand-')) continue; // don't rewrite ourselves
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const [re, to] of RULES) after = after.replace(re, to);
  if (after !== before) {
    fs.writeFileSync(file, after);
    const counts = RULES.map(([re], i) => (i === 0 ? 'scheme' : 'domain'));
    changed.push(rel);
  }
}
console.log(`${changed.length} files changed:`);
for (const rel of changed.sort()) console.log('  ' + rel);
