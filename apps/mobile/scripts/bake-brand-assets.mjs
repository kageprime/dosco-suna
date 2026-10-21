/**
 * Bake the Dosco brand assets for the mobile app.
 *
 * Sources (dosco-brand — transparent-alpha only; doscologo-dark.png is an
 * opaque badge and deliberately not used, same rule the web brand pass had):
 *   doscologo-light.png  wordmark (chrome lockup, alpha)  -> in-app logo PNGs
 *   doscologoIcon.png    crest (red diamond + fire glyph) -> icons + splash
 *
 * Writes:
 *   assets/brand/    dosco-wordmark-dark/-light.png, dosco-crest.png,
 *                    dosco-crest-square.png, dosco-crest-silhouette.png,
 *                    dosco-crest-loader.png
 *   assets/images/   AppIcon-Light.png, adaptive-icon.png, notification-icon.png,
 *                    splash.png, favicon.png   (replaces the Kortix artwork)
 *   android res     ic_launcher(+_round+_foreground).webp per density,
 *                    drawable-<dpi>/notification_icon.png + splashscreen_logo.png,
 *                    values/colors.xml iconBackground -> #ffffff
 *
 * Run:  bun scripts/bake-brand-assets.mjs
 */
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';

const BRAND = 'C:/Users/kage/Desktop/dosco-brand/assets';
const ROOT = path.resolve(import.meta.dirname, '..');
const IMG = path.join(ROOT, 'assets', 'images');
const BRAND_OUT = path.join(ROOT, 'assets', 'brand');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

const WORDMARK_SRC = path.join(BRAND, 'doscologo-light.png');
const CREST_SRC = path.join(BRAND, 'doscologoIcon.png');

const INK_ON_LIGHT = { r: 2, g: 2, b: 2 }; // #020202 wordmark on light surfaces
const INK_ON_DARK = { r: 253, g: 252, b: 253 }; // #fdfcfd wordmark on dark surfaces
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/** Load an RGBA raw buffer. */
async function raw(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  info.channels = 4;
  return { data, info };
}

/** Bounding box of alpha > threshold. */
function alphaBBox({ data, info }, threshold = 8) {
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Solid-fill silhouette of an RGBA buffer (keeps the alpha shape). */
function recolor({ data, info }, rgb) {
  const out = Buffer.alloc(info.width * info.height * 4, 0);
  for (let i = 0; i < info.width * info.height; i++) {
    out[i * 4] = rgb.r;
    out[i * 4 + 1] = rgb.g;
    out[i * 4 + 2] = rgb.b;
    out[i * 4 + 3] = data[i * 4 + 3];
  }
  return { data: out, info };
}

/** Weld an RGBA raw buffer into a sharp pipeline. */
function fromRaw({ data, info }) {
  return sharp(Buffer.from(data), { raw: { width: info.width, height: info.height, channels: 4 } });
}

/** Crest or silhouette fitted and centred on a square canvas → PNG buffer. */
async function onSquare(sourceFile, size, opts = {}) {
  const { scale = 1, bg = null } = opts;
  const artWidth = Math.round(size * scale);
  const art = await sharp(sourceFile).resize(artWidth, null, { fit: 'inside', kernel: 'lanczos3' })
    .png().toBuffer();
  const canvas = bg
    ? sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    : sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  return canvas.composite([{ input: art, gravity: 'centre' }]).png().toBuffer();
}

/** Circle-crop a square sharp pipeline. */
async function circled(sharpPipeline, size) {
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`
  );
  return sharpPipeline.composite([{ input: mask, blend: 'dest-in' }]).webp({ lossless: true }).toBuffer();
}

async function main() {
  fs.mkdirSync(BRAND_OUT, { recursive: true });

  // ── wordmark ────────────────────────────────────────────────────────────
  const mark = await raw(WORDMARK_SRC);
  const markBox = alphaBBox(mark);
  const ratio = markBox.width / markBox.height;
  console.log(`wordmark bbox ${markBox.width}x${markBox.height} ratio ${ratio.toFixed(3)}`);

  for (const [name, rgb] of [['dosco-wordmark-dark', INK_ON_LIGHT], ['dosco-wordmark-light', INK_ON_DARK]]) {
    const sil = recolor(mark, rgb);
    await fromRaw(sil).extract(markBox).resize(1600, null, { fit: 'inside', kernel: 'lanczos3' })
      .png().toFile(path.join(BRAND_OUT, `${name}.png`));
  }
  fs.writeFileSync(path.join(BRAND_OUT, 'dosco-wordmark-ratio.txt'), ratio.toFixed(4));

  // ── crest ───────────────────────────────────────────────────────────────
  const crest = await raw(CREST_SRC);
  const crestBox = alphaBBox(crest);
  console.log(`crest bbox ${crestBox.width}x${crestBox.height} ratio ${(crestBox.width / crestBox.height).toFixed(3)}`);

  // full-colour crest, trimmed (the in-app mark)
  await fromRaw(crest).extract(crestBox).png().toFile(path.join(BRAND_OUT, 'dosco-crest.png'));
  fs.writeFileSync(path.join(BRAND_OUT, 'dosco-crest-ratio.txt'), (crestBox.width / crestBox.height).toFixed(4));

  // crest in a square transparent canvas (symbol-variant source): canvas = bbox width
  await sharp({ create: { width: crestBox.width, height: crestBox.width, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([await sharp(path.join(BRAND_OUT, 'dosco-crest.png')).png().toBuffer().then((b) => ({ input: b, gravity: 'centre' }))])
    .png().toFile(path.join(BRAND_OUT, 'dosco-crest-square.png'));

  // white silhouette (alpha-only glyph for the notification tray)
  const sil = recolor(crest, WHITE);
  await fromRaw(sil).extract(crestBox).png().toFile(path.join(BRAND_OUT, 'dosco-crest-silhouette.png'));

  // loader crest: the full-resolution crest (~1.5 MB) bundled only because it
  // feeds the underwater app-icon step below; the loader renders at ≤80 pt, so
  // ship it a dedicated 480 px-downscale (`assets/brand/dosco-crest-loader.png`)
  // at the same trimmed aspect (read back from dosco-crest-ratio.txt).
  await sharp(path.join(BRAND_OUT, 'dosco-crest.png'))
    .resize(480, null, { fit: 'inside', kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toFile(path.join(BRAND_OUT, 'dosco-crest-loader.png'));

  // ── assets/images ───────────────────────────────────────────────────────
  const crestFile = path.join(BRAND_OUT, 'dosco-crest.png');
  const crestSilhouetteFile = path.join(BRAND_OUT, 'dosco-crest-silhouette.png');

  // App icon: white background + crest at 92% of the canvas.
  fs.writeFileSync(path.join(IMG, 'AppIcon-Light.png'),
    await onSquare(crestFile, 1024, { scale: 0.92, bg: WHITE }));

  // Adaptive foreground: crest on transparent, slightly smaller for the safe zone.
  fs.writeFileSync(path.join(IMG, 'adaptive-icon.png'),
    await onSquare(crestFile, 1024, { scale: 0.86 }));

  // Splash: white, crest at 78% of the canvas (app.json imageWidth renders it ~200dp wide).
  fs.writeFileSync(path.join(IMG, 'splash.png'),
    await onSquare(crestFile, 2048, { scale: 0.78, bg: WHITE }));

  // Notification glyph (96): white crest silhouette on transparent.
  fs.writeFileSync(path.join(IMG, 'notification-icon.png'),
    await onSquare(crestSilhouetteFile, 96, { scale: 0.8 }));

  // Favicon for the web build.
  fs.writeFileSync(path.join(IMG, 'favicon.png'),
    await onSquare(crestFile, 48, { scale: 0.88, bg: WHITE }));

  // ── android res ─────────────────────────────────────────────────────────
  const launcherSize = { 'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192 };
  const fgSize = { 'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432 };
  const notifSize = { 'mdpi': 24, 'hdpi': 36, 'xhdpi': 48, 'xxhdpi': 72, 'xxxhdpi': 96 };
  const splashSize = { 'mdpi': 240, 'hdpi': 360, 'xhdpi': 480, 'xxhdpi': 720, 'xxxhdpi': 960 };

  for (const [dpi, size] of Object.entries(launcherSize)) {
    const dir = path.join(RES, 'mipmap-' + dpi);
    // square + round + adaptive foreground (108dp * density)
    fs.writeFileSync(path.join(dir, 'ic_launcher.webp'),
      await onSquare(crestFile, size, { scale: 0.92, bg: WHITE }));
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.webp'),
      await circled(sharp(await onSquare(crestFile, size, { scale: 0.92, bg: WHITE })), size));
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.webp'),
      await onSquare(crestFile, fgSize[dpi], { scale: 0.82 }));
  }

  for (const [dpi, size] of Object.entries(notifSize)) {
    fs.writeFileSync(path.join(RES, 'drawable-' + dpi, 'notification_icon.png'),
      await onSquare(crestSilhouetteFile, size, { scale: 0.8 }));
  }
  for (const [dpi, size] of Object.entries(splashSize)) {
    fs.writeFileSync(path.join(RES, 'drawable-' + dpi, 'splashscreen_logo.png'),
      await onSquare(crestFile, size, { scale: 0.7 }));
  }

  // adaptive background colour: the iconBackground the crest sits on (prod)/orange (dev)
  const colors = path.join(RES, 'values', 'colors.xml');
  const colorsOut = fs.readFileSync(colors, 'utf8')
    .replace('<color name="iconBackground">#F0F0E9</color>', '<color name="iconBackground">#ffffff</color>');
  fs.writeFileSync(colors, colorsOut);

  console.log('baked brand assets into:', BRAND_OUT, IMG, RES);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
