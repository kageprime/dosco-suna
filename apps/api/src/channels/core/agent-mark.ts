import sharp from 'sharp';
import { pixelMark } from '@kortix/shared/pixel-mark';
import { config } from '../../config';

/**
 * An agent's face as a PNG: the same pixel mark and tile tone the web app
 * paints (`@kortix/shared/pixel-mark`), for a chat platform that shows a
 * picture beside each message (Slack's `icon_url`). Slack copies the image
 * into its own storage, so the URL is read once per agent, not per message.
 */

/** A slug the route serves: an agent manifest key. */
const AGENT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isAgentMarkSlug(slug: string): boolean {
  return AGENT_SLUG.test(slug);
}

/** The edge of the PNG in px. Slack shows 36–48 px and keeps up to 512. */
const EDGE = 128;
/** The 7 × 7 mark fills this much of the tile, as on the web (28 px mark in a 40 px tile). */
const MARK = 84;

/** The mark on its tile as SVG, whole pixels only (`crispEdges`). */
export function agentMarkSvg(slug: string): string {
  const mark = pixelMark(slug);
  const cell = mark.width === 7 ? MARK / 7 : Math.floor(MARK / 12);
  const w = mark.width * cell;
  const h = mark.height * cell;
  const x = Math.round((EDGE - w) / 2);
  const y = Math.round((EDGE - h) / 2);
  const glyph = (path: string, opacity = 1) =>
    path ? `<path d="${path}" fill="${mark.tone.ink}"${opacity < 1 ? ` opacity="${opacity}"` : ''}/>` : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${EDGE}" height="${EDGE}" viewBox="0 0 ${EDGE} ${EDGE}" shape-rendering="crispEdges">`,
    `<rect width="${EDGE}" height="${EDGE}" fill="${mark.tone.tile}"/>`,
    `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${mark.width} ${mark.height}">`,
    glyph(mark.path),
    glyph(mark.ditherPath, 0.5),
    '</svg></svg>',
  ].join('');
}

// replica-local: a render cache, at most CACHE_MAX slugs; every replica fills its own.
const cache = new Map<string, Buffer>();
const CACHE_MAX = 256;

export async function agentMarkPng(slug: string): Promise<Buffer> {
  const hit = cache.get(slug);
  if (hit) return hit;
  const png = await sharp(Buffer.from(agentMarkSvg(slug))).png().toBuffer();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(slug, png);
  return png;
}

/**
 * Bump when the picture changes: Slack keeps its copy per URL, so a new
 * drawing needs a new URL to show.
 */
const MARK_VERSION = 1;

/**
 * The public URL of an agent's face, or null when the slug is not one or the
 * API has no URL Slack can fetch (a laptop's `localhost`).
 */
export function agentMarkUrl(slug: string | null | undefined): string | null {
  const base = config.KORTIX_URL?.replace(/\/+$/, '');
  if (!slug || !base || !isAgentMarkSlug(slug)) return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) return null;
  return `${base}/v1/agent-marks/${slug}.png?v=${MARK_VERSION}`;
}
