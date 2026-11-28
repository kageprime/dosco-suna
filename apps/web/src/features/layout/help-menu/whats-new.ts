/** One changelog week, as the help menu lists it. */
export interface WhatsNewWeek {
  /** The week's Monday, `2026-10-19`. */
  slug: string;
  /** The headline of the week's lead release. */
  title: string;
  /** The week's Monday, 00:00Z, ISO. Absent in a body cached before it was added. */
  date?: string;
  /** `/changelog/<slug>`. */
  href: string;
}

/** The body of `GET /whats-new.json`. */
export interface WhatsNew {
  /** False when the deployment serves no changelog (self-host with the landing page off). */
  enabled: boolean;
  /** Newest first, at most three. Empty when GitHub was unreachable. */
  weeks: WhatsNewWeek[];
}

export const WHATS_NEW_PATH = '/whats-new.json';

export const CHANGELOG_PATH = '/changelog';

/** Reads the route's body. Anything else is treated as "no changelog". */
export function parseWhatsNew(value: unknown): WhatsNew {
  if (!value || typeof value !== 'object') return { enabled: false, weeks: [] };
  const { enabled, weeks } = value as Partial<WhatsNew>;
  return {
    enabled: enabled === true,
    weeks: Array.isArray(weeks)
      ? weeks.filter(
          (week): week is WhatsNewWeek =>
            !!week &&
            typeof week.slug === 'string' &&
            typeof week.title === 'string' &&
            (week.date === undefined ||
              (typeof week.date === 'string' && !Number.isNaN(Date.parse(week.date)))) &&
            typeof week.href === 'string' &&
            week.href.startsWith(`${CHANGELOG_PATH}/`),
        )
      : [],
  };
}
