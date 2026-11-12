/**
 * Where a Card's badges go in a card list (`layout.tsx` `CardText`): beside the title, top right, as on web, or on
 * their own line above it. A phone row is narrow (a 96pt thumbnail leaves about 200pt for the text on a 375pt
 * phone), and a badge beside the title squeezed it into a column one word wide ("Khuri village / and the / Barna
 * side") and pushed the badge past the card's edge. Pure: unit-tested under Bun.
 */

export type BadgePlacement = 'beside' | 'above';

export interface CardBadge {
  label: string;
  /** A `good` badge leads with the star. */
  star: boolean;
}

/** Roobert's average advance at text-xs (12pt) and at the medium title (16pt), in pt at font scale 1. */
const BADGE_CHAR = 6.4;
const TITLE_CHAR = 8.6;
/** A pill's horizontal padding (px-2), the star with its gap, the gap between pills, the gap to the title. */
const PILL_PAD = 16;
const STAR = 18;
const PILL_GAP = 6;
const TITLE_GAP = 12;
/** Beside the title the badges take at most this share of the row. */
const BADGE_SHARE = 0.4;
/** The title keeps at least this much room beside the badges (a short title needs only its own width). */
const TITLE_MIN = 140;

/** One pill's width in pt, an estimate from the label length: the layout only needs to know when it will not fit. */
export function badgeWidth(badge: CardBadge, fontScale = 1): number {
  return PILL_PAD + (badge.label.length * BADGE_CHAR + (badge.star ? STAR : 0)) * fontScale;
}

/**
 * `beside` when the badges, in one row, take at most 40% of the text column and the title keeps room for its own
 * width (at most 140pt, scaled); otherwise `above`. A column not measured yet (`width` 0) is `above`: a wrong
 * `above` costs one line, a wrong `beside` overlaps. Large Dynamic Type (`fontScale`) widens both estimates.
 */
export function cardBadgePlacement({
  width,
  title,
  badges,
  fontScale = 1,
}: {
  width: number;
  title: string;
  badges: readonly CardBadge[];
  fontScale?: number;
}): BadgePlacement {
  if (badges.length === 0) return 'beside';
  if (width <= 0) return 'above';
  const group = badges.reduce((sum, badge) => sum + badgeWidth(badge, fontScale), 0) + PILL_GAP * (badges.length - 1);
  const titleNeeds = Math.min(title.length * TITLE_CHAR, TITLE_MIN) * fontScale;
  return group <= width * BADGE_SHARE && width - group - TITLE_GAP >= titleNeeds ? 'beside' : 'above';
}
