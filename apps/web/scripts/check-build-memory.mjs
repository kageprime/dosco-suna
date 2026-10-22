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

const CONTAINER_GB = 8;
const COLD_BASELINE_GB = 1;

if (heapMb === null) {
  console.log('No --max-old-space-size in the build command.');
  process.exit(0);
}

const heapGb = heapMb / 1024;
const parentPlusWorker = heapGb * 2; // parent + one prerender worker
const worstCase = parentPlusWorker + COLD_BASELINE_GB;

console.log(`build command:      ${buildCommand}`);
console.log(`heap cap:           ${heapMb} MB (${heapGb.toFixed(2)} GB)`);
console.log(`container:          ${CONTAINER_GB} GB`);
console.log(`parent + worker:    ${parentPlusWorker.toFixed(2)} GB of heap`);
console.log(`cold baseline:      +${COLD_BASELINE_GB} GB (turbopack program resident)`);
console.log(`worst case:         ${worstCase.toFixed(2)} GB of ${CONTAINER_GB} GB`);

if (worstCase > CONTAINER_GB) {
  console.log(
    `\nOVER: the cold envelope does not fit. Lower the cap so parent + worker + cold\n` +
      `baseline stays under ${CONTAINER_GB} GB, or the container SIGKILLs the build.`,
  );
  process.exit(1);
}

console.log('\nFits.');
