/**
 * One-shot brand sweep of the locale JSON files. Replaces Dosco for Kortix in
 * string VALUES only — keys (e.g. `kortixComputer`) are untouched because
 * app code reads them by name. Domain variants first, then the wordmark,
 * then the scheme. Run: bun scripts/rebrand-locales.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '..', 'locales');
const RULES = [
  [/kortix\.com/gi, 'dosco.live'],
  [/kortix:\/\//g, 'dosco://'],
  [/Kortix/g, 'Dosco'],
  [/kortix/g, 'dosco'],
];

function walk(node, file) {
  if (typeof node === 'string') return RULES.reduce((s, [re, to]) => s.replace(re, to), node);
  if (Array.isArray(node)) return node.map((v) => walk(v, file));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') node[k] = RULES.reduce((s, [re, to]) => s.replace(re, to), v);
      else node[k] = walk(v, file);
    }
    return node;
  }
  return node;
}

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const full = path.join(dir, file);
  const before = fs.readFileSync(full, 'utf8');
  const hit = /kortix/i.test(before);
  if (!hit) continue;
  const data = walk(JSON.parse(before), file);
  // Guard: keys must never change.
  if (JSON.stringify(Object.keys(data)) !== JSON.stringify(Object.keys(JSON.parse(before)))) {
    throw new Error(`top-level keys changed in ${file}`);
  }
  fs.writeFileSync(full, JSON.stringify(data, null, 2) + '\n');
  const after = fs.readFileSync(full, 'utf8');
  console.log(`${file}: kortix hits ${/kortix/i.test(after) ? 'REMAIN' : '0'}`);
}
