/**
 * Point mark-math.ts at the Dosco vector mark: replaces the region from
 * `export const KORTIX_SYMBOL_PATH` through `SYMBOL_ASPECT` with the crest
 * path data extracted from assets/brand/dosco-mark.svg (+ its outline), then
 * updates the width/height constants to the viewBox.
 * Identifier names stay — only what they contain changes.
 * Run: bun scripts/patch-mark-math.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const brand = path.join(root, 'assets', 'brand');
const target = path.join(root, 'lib', 'effects', 'mark-math.ts');

const markSvg = fs.readFileSync(path.join(brand, 'dosco-mark.svg'), 'utf8');
const outlineSvg = fs.readFileSync(path.join(brand, 'dosco-mark-outline.svg'), 'utf8');
const dOf = (svg) => svg.match(/ d="([^"]+)"/)[1];
const markD = dOf(markSvg);
const outlineD = dOf(outlineSvg);

const viewBox = markSvg.match(/viewBox="([^"/]+) ([^"/]+) ([^"/]+) ([^"]+)"/);
const W = Math.round(Number(viewBox[3]));
const H = Math.round(Number(viewBox[4]));

const source = fs.readFileSync(target, 'utf8');
const start = source.indexOf('export const KORTIX_SYMBOL_PATH');
const endMarker = 'export const SYMBOL_ASPECT = SYMBOL_WIDTH / SYMBOL_HEIGHT;';
const end = source.indexOf(endMarker);
if (start === -1 || end === -1) throw new Error('mark-math constants block not found');

const replacement = `export const KORTIX_SYMBOL_PATH =
  '${markD}';

/** The bare rim contour the currents component walks for edge particles. */
export const KORTIX_MARK_OUTLINE_PATH = '${outlineD}';

// The Dosco crest's viewBox, rounded to whole ArtKit units.
export const SYMBOL_WIDTH = ${W};
export const SYMBOL_HEIGHT = ${H};
export const SYMBOL_ASPECT = SYMBOL_WIDTH / SYMBOL_HEIGHT;`;

const updated = source.slice(0, start) + replacement + source.slice(end + endMarker.length).trimEnd();
fs.writeFileSync(target, updated);
console.log(`patched ${path.relative(root, target)}: path ${markD.length} chars, box ${W}x${H} (aspect ${(W / H).toFixed(3)})`);
