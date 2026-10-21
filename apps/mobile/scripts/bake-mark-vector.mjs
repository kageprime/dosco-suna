/**
 * Extract the Dosco vector mark from the brand's doscologo-light.svg
 * (subpaths 0, 1, 3, 7 of the artwork path — rim, inner plate, fire glyph,
 * glyph hook — combined with fill-rule evenodd) and bake:
 *   assets/brand/dosco-mark.svg          — the full crest (for the shader bakes)
 *   assets/brand/dosco-mark-outline.svg  — rim contour only (particle edges)
 * Run: bun scripts/bake-mark-vector.mjs
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/kage/Desktop/dosco-brand/doscologo-light.svg';
const OUT = path.resolve(import.meta.dirname, '..', 'assets', 'brand');

const svgText = fs.readFileSync(SRC, 'utf8');
const paths = [...svgText.matchAll(/<path\b[^>]*d="([^"]+)"[^>]*>/g)].map((m) => m[1]);
if (paths.length !== 2) throw new Error(`expected 2 paths (bg + artwork), found ${paths.length}`);
const subpaths = paths[1].split(/(?=[Mm])/).map((s) => s.trim()).filter(Boolean);
if (subpaths.length !== 9) throw new Error(`expected 9 artwork subpaths, found ${subpaths.length}`);

const crestIndices = [0, 1, 3, 7];
const crestD = crestIndices.map((i) => subpaths[i]).join(' ');
const outlineD = subpaths[0];

const NUMBERS = /-?(?:\d*\.\d+|\d+\.?)(?:[eE]-?\d+)?/g;

function dBBox(d) {
  const nums = (d.match(NUMBERS) || []).map(Number);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i]); maxX = Math.max(maxX, nums[i]);
    minY = Math.min(minY, nums[i + 1]); maxY = Math.max(maxY, nums[i + 1]);
  }
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

const box = dBBox(crestD);
console.log(`crest viewBox: ${box.minX} ${box.minY} ${box.w} ${box.h} (aspect ${(box.w / box.h).toFixed(3)})`);

function writeMark(name, d, { evenodd }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.minX} ${box.minY} ${box.w} ${box.h}"><path d="${d}" fill="#020202"${evenodd ? ' fill-rule="evenodd"' : ''}/></svg>`;
  fs.writeFileSync(path.join(OUT, name), svg);
  return svg;
}

const crestSvg = writeMark('dosco-mark.svg', crestD, { evenodd: true });
writeMark('dosco-mark-outline.svg', outlineD, { evenodd: false });

// sanity render
fs.writeFileSync(
  path.join('C:/Users/kage/AppData/Local/Temp/opencode', 'mark-final.png'),
  await sharp(Buffer.from(crestSvg)).png().toBuffer()
);
console.log('wrote dosco-mark.svg + dosco-mark-outline.svg into', OUT);
