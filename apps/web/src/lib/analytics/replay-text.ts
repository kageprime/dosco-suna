/**
 * Our own interface text: the one kind of text a masked session replay and a
 * masked click event may keep (rule 4 in `posthog-config.ts`).
 *
 * The index holds every string of the translation catalog the page renders,
 * plus the provider names, with each placeholder reduced to a number:
 * `{count} models` keeps "14 models" and hides "Acme models". Text that is not
 * in the index is hidden, so a new screen that shows customer content is
 * hidden without anyone marking it. Text with no letter is never kept: a lone
 * number or amount can be a customer's figure.
 *
 * What it gives away: customer text that equals one of our strings, such as a
 * workspace named "Settings", or is only our strings joined by commas, shows.
 * That reveals nothing the catalog does not already say.
 */

import { PROVIDER_LABELS } from '@kortix/llm-catalog/lite';
import { IntlMessageFormat } from 'intl-messageformat';

/** What every placeholder and every run of digits becomes. */
const NUMBER = '#';
/** Digits with the grouping and decimal separators locales use (1,234 · 1.5 · 1 234). */
const NUMBER_RUN = /\d+(?:[.,'  ]\d+)*/g;
const LETTER = /\p{L}/u;
/** Where a rich-text tag splits a message into separate text nodes. */
const BREAK = '\u0000';
/** A message with several plural or select arguments expands to at most this many variants. */
const MAX_VARIANTS = 32;
/**
 * The separators our interface joins strings with ("API key · 14 models",
 * "In use · 3"). Each part is judged alone, so a customer name beside a label
 * hides and the label stays. Not `|`: a shell pipe or a table row in an
 * agent's output would split into parts.
 */
const SEGMENT_BREAK = /(\s+[·•—–]\s+)/;
/** Joins the clauses of one sentence of ours; numbers keep their commas (`NUMBER_RUN`). */
const CLAUSE_BREAK = ', ';

const RELATIVE_UNITS = ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'] as const;

/** Element kinds of a parsed ICU message (`TYPE` in @formatjs/icu-messageformat-parser). */
const ICU = {
  literal: 0,
  argument: 1,
  number: 2,
  date: 3,
  time: 4,
  select: 5,
  plural: 6,
  pound: 7,
  tag: 8,
} as const;

interface IcuNode {
  type: number;
  value?: unknown;
  options?: Record<string, { value: IcuNode[] }>;
  children?: IcuNode[];
}

/** The form text is compared in: one space between words, every number `#`. */
export function normalizeUiText(text: string): string {
  // Numbers first: a locale's grouping space (1\u202f234) belongs to the number.
  return text.replace(NUMBER_RUN, NUMBER).replace(/\s+/g, ' ').trim();
}

function variants(nodes: IcuNode[]): string[] {
  let out = [''];
  for (const node of nodes) {
    let parts: string[];
    switch (node.type) {
      case ICU.literal:
        parts = [String(node.value ?? '')];
        break;
      case ICU.select:
      case ICU.plural:
        parts = Object.values(node.options ?? {}).flatMap((option) => variants(option.value));
        break;
      case ICU.tag:
        parts = variants(node.children ?? []).map((inner) => `${BREAK}${inner}${BREAK}`);
        break;
      default:
        // An argument, a number, a date, a time or `#`: only digits may stand there.
        parts = [NUMBER];
    }
    out = out.flatMap((prefix) => parts.map((part) => prefix + part)).slice(0, MAX_VARIANTS);
  }
  return out;
}

/**
 * The normalized texts one catalog message can render as. A rich-text tag
 * renders its own text node, so a tagged message adds each piece.
 */
export function messageTexts(message: string, locale: string): string[] {
  let rendered: string[];
  if (!/[{<]|''/.test(message)) {
    rendered = [message];
  } else {
    try {
      rendered = variants(new IntlMessageFormat(message, locale).getAst() as IcuNode[]);
    } catch {
      return [];
    }
  }
  return rendered
    .flatMap((text) => text.split(BREAK))
    .map(normalizeUiText)
    .filter((text) => LETTER.test(text));
}

/** The interface strings of the catalogs and locales added so far. */
export class UiTextIndex {
  private readonly texts = new Set<string>();

  constructor(extra: Iterable<string> = Object.values(PROVIDER_LABELS)) {
    for (const text of extra) this.addText(text);
  }

  /** Every string of one locale's catalog tree. */
  addCatalog(tree: unknown, locale: string): void {
    const pending: unknown[] = [tree];
    while (pending.length > 0) {
      const node = pending.pop();
      if (typeof node === 'string') {
        for (const text of messageTexts(node, locale)) this.texts.add(text);
      } else if (node && typeof node === 'object') {
        pending.push(...Object.values(node));
      }
    }
  }

  /**
   * Every relative time the browser formats for this locale ("6 minutes ago",
   * "in 2 hr.", "yesterday"): the session list and message stamps use
   * `Intl.RelativeTimeFormat`, not the catalog.
   */
  addRelativeTimes(locale: string): void {
    // Serbian renders in Latin script (`relative-time.ts`, `image-gen-tool.tsx`).
    const tags = locale === 'sr' ? [locale, 'sr-Latn'] : [locale];
    for (const tag of tags) {
      for (const numeric of ['always', 'auto'] as const) {
        for (const style of ['long', 'short', 'narrow'] as const) {
          let format: Intl.RelativeTimeFormat;
          try {
            format = new Intl.RelativeTimeFormat(tag, { numeric, style });
          } catch {
            continue;
          }
          for (const unit of RELATIVE_UNITS) {
            // 1, 2 and 5 reach every plural form our locales have.
            for (const value of [-5, -2, -1, 0, 1, 2, 5]) this.addText(format.format(value, unit));
          }
        }
      }
    }
  }

  private addText(text: string): void {
    const normalized = normalizeUiText(text);
    if (LETTER.test(normalized)) this.texts.add(normalized);
  }

  get size(): number {
    return this.texts.size;
  }

  /** Whether the whole text, or each part between our separators, is interface text. */
  has(text: string): boolean {
    if (this.hasWhole(text)) return true;
    const parts = text.split(SEGMENT_BREAK);
    if (parts.length === 1) return false;
    return parts.every((part, index) => index % 2 === 1 || this.hasWhole(part));
  }

  /**
   * The text as a masked recording shows it: interface text unchanged, every
   * other part through `mask`. Separators stay.
   */
  reveal(text: string, mask: (text: string) => string): string {
    if (!text.trim() || this.hasWhole(text)) return text;
    const parts = text.split(SEGMENT_BREAK);
    if (parts.length === 1) return mask(text);
    return parts
      .map((part, index) => (index % 2 === 1 || this.hasWhole(part) ? part : mask(part)))
      .join('');
  }

  private hasWhole(text: string): boolean {
    const normalized = normalizeUiText(text);
    if (!LETTER.test(normalized)) return false;
    if (this.texts.has(normalized)) return true;
    // Our step sentences joined into one line, each after the first in lower
    // case: "Read 2 files, ran 7 commands" (`burstWorkLabel` in @kortix/sdk).
    // Every clause must be ours, or the whole text hides.
    const clauses = normalized.split(CLAUSE_BREAK);
    return (
      clauses.length > 1 &&
      clauses.every(
        (clause) =>
          LETTER.test(clause) &&
          (this.texts.has(clause) || this.texts.has(clause[0]!.toUpperCase() + clause.slice(1))),
      )
    );
  }
}
