// bake-web-brand-assets.mjs — regenerate the web brand/icon set, monochrome.
//
// Favicon policy (user decision, 2026-10-21): the favicon/icon set is the
// crest SILHOUETTE in black & white — never the colored crest or a wordmark.
// Black mark (negated silhouette) on transparent/white; white mark on dark
// surfaces; maskable = white mark on near-black.
//
// Run: node scripts\bake-web-brand-assets.mjs
//
// Sources (mobile kit): dosco-crest-silhouette.png (white fill on transparency).
// Targets under apps/web/public: favicon.{ico,png,svg}, icon-{192,512}.png,
// icon-{light,dark}-32.png, icon-maskable-512.png, logomark-white.svg,
// blume-public/favicon.svg.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE_BRAND = path.resolve(__dirname, '../../mobile/assets/brand');
const WEB_PUBLIC = path.resolve(__dirname, '../public');

const SILHOUETTE = path.join(MOBILE_BRAND, 'dosco-crest-silhouette.png');

async function main() {
  let sharp;
  try {
    sharp = (await import('sharp')).default ?? (await import('sharp'));
  } catch {
    // Workspace hoist: pnpm puts transitive deps in node_modules/.pnpm/node_modules,
    // not on apps/web/scripts' normal resolution path. Anchor a CJS resolver there.
    try {
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const hoist = path.resolve(__dirname, '../../../node_modules/.pnpm/node_modules');
      const require = createRequire(pathToFileURL(path.join(hoist, 'index.js')));
      sharp = require('sharp');
    } catch (e) {
      console.error('sharp not resolvable (bare or hoisted):', e.message);
      process.exit(1);
    }
  }

  if (!fs.existsSync(SILHOUETTE)) {
    console.error('missing source:', SILHOUETTE);
    process.exit(1);
  }
  const meta = await sharp(SILHOUETTE).metadata();
  console.log('silhouette:', meta.width, 'x', meta.height, 'alpha:', meta.hasAlpha);

  // The silhouette is WHITE on transparency. Every dark mark derives from
  // negating it (alpha kept), every white one from the source as-is.
  const mark = (size, color) =>
    color === 'white'
      ? sharp(SILHOUETTE).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      : sharp(SILHOUETTE).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).negate({ alpha: false });

  const writePng = async (name, size, color, flatten) => {
    let pipeline = mark(size, color);
    if (flatten) pipeline = pipeline.flatten({ background: flatten });
    await pipeline.png().toFile(path.join(WEB_PUBLIC, name));
    console.log('wrote', name, `${size}x${size}`);
  };

  // --- PNG set -------------------------------------------------------------
  await writePng('icon-512.png', 512, 'black');
  await writePng('icon-192.png', 192, 'black');
  await writePng('favicon.png', 64, 'black');
  await writePng('icon-light-32.png', 32, 'black', '#ffffff');
  await writePng('icon-dark-32.png', 32, 'white', '#0c0c0c');

  // Maskable: white mark centered at 80% safe zone on near-black bleeds to the edge.
  const maskInner = await mark(410, 'white').png().toBuffer();
  await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 12, g: 12, b: 12, alpha: 1 } } })
    .composite([{ input: maskInner, blend: 'over' }])
    .png()
    .toFile(path.join(WEB_PUBLIC, 'icon-maskable-512.png'));
  console.log('wrote icon-maskable-512.png 512x512 (white mark on #0c0c0c)');

  // --- favicon.ico (PNG-compressed entries: 16/32/48/64/128/256) -----------
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) {
    const buf = await mark(s, 'black').png().toBuffer();
    pngs.push({ s, buf });
  }
  let offset = 6 + sizes.length * 16;
  const dirSize = pngs.reduce((a, b) => a + b.buf.length, 0);
  const ico = Buffer.alloc(offset + dirSize);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(sizes.length, 4);
  let entryOffset = 6;
  for (let i = 0; i < sizes.length; i++) {
    const { s, buf } = pngs[i];
    ico.writeUInt8(s === 256 ? 0 : s, entryOffset + 0);
    ico.writeUInt8(s === 256 ? 0 : s, entryOffset + 1);
    ico.writeUInt8(0, entryOffset + 2);
    ico.writeUInt8(0, entryOffset + 3);
    ico.writeUInt16LE(1, entryOffset + 4);
    ico.writeUInt16LE(32, entryOffset + 6);
    ico.writeUInt32LE(buf.length, entryOffset + 8);
    ico.writeUInt32LE(offset, entryOffset + 12);
    buf.copy(ico, offset);
    offset += buf.length;
    entryOffset += 16;
  }
  await fs.promises.writeFile(path.join(WEB_PUBLIC, 'favicon.ico'), ico);
  console.log('wrote favicon.ico', ico.length, 'bytes');

  // --- favicon.svg (transparent PNG embedded inline, crisp at any size) ----
  const png256 = await mark(256, 'black').png().toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><image width="256" height="256" href="data:image/png;base64,${png256.toString('base64')}"/></svg>`;
  await fs.promises.writeFile(path.join(WEB_PUBLIC, 'favicon.svg'), svg);
  console.log('wrote favicon.svg');

  // --- logomark-white.svg: the white crest silhouette (og slots) -----------
  const white512 = await mark(512, 'white').png().toBuffer();
  const svgWhite = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><image width="512" height="512" href="data:image/png;base64,${white512.toString('base64')}"/></svg>`;
  await fs.promises.writeFile(path.join(WEB_PUBLIC, 'logomark-white.svg'), svgWhite);
  console.log('wrote logomark-white.svg');

  // --- blume docs favicon --------------------------------------------------
  const blumePub = path.resolve(WEB_PUBLIC, '../blume-public');
  if (fs.existsSync(blumePub)) {
    await fs.promises.writeFile(path.join(blumePub, 'favicon.svg'), svg);
    console.log('wrote blume-public/favicon.svg');
  }
  // --- footer dithered wordmark mask ---------------------------------------
  // The footer paints its wordmark with bg-foreground through a CSS alpha mask
  // (/marketing/dither-wordmark.png). It used to spell the old brand. Rebuild
  // it from Dosco's wordmark: coverage = alpha, dithered to a Bayer-dot grid,
  // so the ink stays in the mask's alpha and follows the theme.
  const WORDMARK = path.join(MOBILE_BRAND, 'dosco-wordmark-dark.png');
  if (fs.existsSync(WORDMARK)) {
    const trimmedMeta = await sharp(WORDMARK).trim().metadata();
    const W = 1440; // author 1:1 with the old mask so max-w-7xl rendering keeps the same grain
    const H = Math.max(1, Math.round(W * (trimmedMeta.height ?? 1) / (trimmedMeta.width ?? 1)));
    const srcMark = await sharp(WORDMARK)
      .trim()
      .resize(W, H, { fit: 'fill' })
      .ensureAlpha() // art bounds only; alpha = shape
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { data, info } = srcMark;
    const out = Buffer.alloc(data.length);
    // True halftone: a dot grid whose pitch matches the old mask's grain
    // (~6px pitch at the 1440-era asset, i.e. chunky, visible cells); each
    // cell draws a dot whose radius scales with the wordmark's coverage.
    const CELL = 6;
    const cellsX = Math.ceil(info.width / CELL);
    const cellsY = Math.ceil(info.height / CELL);
    for (let cy = 0; cy < cellsY; cy++) {
      for (let cx = 0; cx < cellsX; cx++) {
        let sum = 0;
        for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
          for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
            sum += data[(y * info.width + x) * 4 + 3];
          }
        }
        const coverage = sum / (CELL * CELL * 255); // 0..1
        const maxR = CELL * 0.3; // full-coverage dot ≈ 3.5px of the 6px cell, like the old mask
        const r = maxR * Math.sqrt(coverage);
        for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
          for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
            const dx = x - (cx * CELL + (CELL - 1) / 2);
            const dy = y - (cy * CELL + (CELL - 1) / 2);
            const on = Math.sqrt(dx * dx + dy * dy) <= r;
            const i = y * info.width + x;
            out[i * 4 + 0] = 255;
            out[i * 4 + 1] = 255;
            out[i * 4 + 2] = 255;
            out[i * 4 + 3] = on ? 255 : 0;
          }
        }
      }
    }
    await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toFile(path.join(WEB_PUBLIC, 'marketing', 'dither-wordmark.png'));
    console.log('wrote marketing/dither-wordmark.png', `${info.width}x${info.height}`);
  } else {
    console.log('wordmark source missing; dither mask not rebuilt');
  }

  console.log('DONE');
}

main().catch((e) => { console.error(e); process.exit(1); });
