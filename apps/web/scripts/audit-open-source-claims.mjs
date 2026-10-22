#!/usr/bin/env node
// Lists every catalog value that still claims the product is open source.
//
// The rename to Dosco left the old framing in the non-English catalogs:
// "Dosco ist Open Source", "Suna is open source, MIT licensed",
// "Von Natur aus Open Source" and the trust bullets built on them. Those
// are sentences, not phrases, so they need a translator rather than a
// substitution - this script is the worklist for that pass.
//
// Usage: node scripts/audit-open-source-claims.mjs [locale ...]
//        node scripts/audit-open-source-claims.mjs            (all locales)
//        node scripts/audit-open-source-claims.mjs --paths    (paths only)

import fs from 'node:fs';
import path from 'node:path';

const webRoot = path.resolve(process.cwd());
const translations = path.join(webRoot, 'translations');

/** How the "open source" claim is spelled in each locale. */
const CLAIM = {
  en: /open[- ]source/i,
  de: /open[- ]source|quelloffen/i,
  es: /c[oó]digo abierto/i,
  fr: /open[- ]source/i,
  it: /open[- ]source/i,
  pt: /c[oó]digo aberto|open[- ]source/i,
  sr: /отвореног кода|open[- ]source/i,
  zh: /开源/i,
  ja: /オープンソース/i,
};

function collect(node, keyPath = [], out = []) {
  if (typeof node === 'string') {
    out.push([keyPath.join('.'), node]);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) collect(v, [...keyPath, k], out);
  return out;
}

const args = process.argv.slice(2);
const pathsOnly = args.includes('--paths');
const locales = args.filter((a) => !a.startsWith('--'));
const targets = locales.length ? locales : Object.keys(CLAIM);

let total = 0;

for (const locale of targets) {
  const file = path.join(translations, `${locale}.json`);
  if (!fs.existsSync(file)) {
    console.log(`no catalog for ${locale}`);
    continue;
  }
  const values = collect(JSON.parse(fs.readFileSync(file, 'utf8')));
  const hits = values.filter(([, v]) => CLAIM[locale]?.test(v));
  total += hits.length;

  console.log(`\n=== ${locale}: ${hits.length} values claim open source`);
  for (const [keyPath, value] of hits) {
    if (pathsOnly) {
      console.log(`  ${keyPath}`);
      continue;
    }
    console.log(`  ${keyPath}`);
    console.log(`     ${value.slice(0, 200)}`);
  }
}

console.log(`\ntotal: ${total}`);
