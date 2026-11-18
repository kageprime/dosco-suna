#!/usr/bin/env node
// Keep the Vercel build inside the container.
//
// The web build runs on an 8 GB Vercel machine. `next build` runs a parent
// process plus a prerender worker, and each of them loads the full module
// graph and the public catalog output for all nine locales. A cold build
// (the Turbopack cache does not survive the Hobby cache cap) keeps the
// Turbopack program resident through the collect/generate phases and runs
// about 1 GB above the warm baseline, which is what tips the container into
// a SIGKILL of the build process.
//
// The heap cap in vercel.json's buildCommand is the lever that decides who
// runs out of memory first:
//   - a cap that is too high lets V8 grow until the container is killed
//     (a SIGKILL with no stack, nothing to act on);
//   - a cap that is too low makes V8 abort the build on its own with a
//     heap-limit stack trace, which says exactly which page needed the
//     memory.
//
// So the cap is set for the COLD envelope: the parent plus the single
// worker stay under 6 GB of heap, leaving room for the Turbopack program
// and the native allocations that live outside the V8 heap.
//
// Usage: node scripts/check-build-memory.mjs
// Prints the caps in play and the headroom the cold envelope needs.

import fs from 'node:fs';
import path from 'node:path';

const webRoot = path.resolve(process.cwd());
const vercelJson = JSON.parse(fs.readFileSync(path.join(webRoot, 'vercel.json'), 'utf8'));

const buildCommand = vercelJson.buildCommand ?? '';
const match = /--max-old-space-size=(\d+)/.exec(buildCommand);
const heapMb = match ? Number(match[1]) : null;

const isWebpack = buildCommand.includes('--webpack');
const CONTAINER_GB = 8;
const COLD_BASELINE_GB = 1;

if (heapMb === null) {
  console.log('No --max-old-space-size in the build command.');
  process.exit(0);
}

const heapGb = heapMb / 1024;
// In Turbopack (Next.js 16 default), compile runs in native Rust (~2.5 GB peak).
// Node parent stays light (~500 MB). Prerender runs with 1 worker capped at heapMb.
const compilePhase = isWebpack ? heapGb + 0.5 : 3.0;
const generatePhase = isWebpack ? heapGb + 1.0 : heapGb + 0.8;
const peakPhase = Math.max(compilePhase, generatePhase);
const worstCase = peakPhase + COLD_BASELINE_GB;

console.log(`build command:      ${buildCommand}`);
console.log(`compiler:           ${isWebpack ? 'webpack' : 'turbopack (Next 16 default)'}`);
console.log(`heap cap:           ${heapMb} MB (${heapGb.toFixed(2)} GB)`);
console.log(`container:          ${CONTAINER_GB} GB`);
console.log(`compile phase:      ${compilePhase.toFixed(2)} GB`);
console.log(`generate phase:     ${generatePhase.toFixed(2)} GB`);
console.log(`cold baseline:      +${COLD_BASELINE_GB} GB (native allocations outside V8)`);
console.log(`worst case:         ${worstCase.toFixed(2)} GB of ${CONTAINER_GB} GB`);

if (worstCase > CONTAINER_GB) {
  console.log(
    `\nOVER: the cold envelope does not fit. Lower the cap so the heaviest phase + cold\n` +
      `baseline stays under ${CONTAINER_GB} GB, or the container SIGKILLs the build.`,
  );
  process.exit(1);
}

console.log('\nFits.');
