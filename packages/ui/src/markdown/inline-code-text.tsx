import type React from 'react';

import { INLINE_CODE } from './inline-chip';

export type InlineCodeSegment = { kind: 'text' | 'code'; value: string };

/**
 * Splits a one-line string on backtick code spans: 'a `b` c' →
 * text 'a ', code 'b', text ' c'. An unmatched backtick stays as text.
 * A double-backtick span (`` a`b ``) is read the way CommonMark reads it.
 */
export function splitInlineCode(input: string): InlineCodeSegment[] {
  const segments: InlineCodeSegment[] = [];
  // A run opens only at its first backtick and closes only on a run of the same length.
  const pattern = /(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
  let last = 0;
  for (const match of input.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: 'text', value: input.slice(last, start) });
    const raw = match[2];
    const body = raw.length > 2 && raw.startsWith(' ') && raw.endsWith(' ') ? raw.slice(1, -1) : raw;
    segments.push({ kind: 'code', value: body });
    last = start + match[0].length;
  }
  if (last < input.length) segments.push({ kind: 'text', value: input.slice(last) });
  return segments;
}

/**
 * A markdown string as the plain words it shows, for one-line text that
 * cannot hold markup: a card's summary, an accessible description, a link
 * name. Code spans lose their backticks, links and images keep their text,
 * emphasis markers go, and line breaks collapse to single spaces.
 * `memory_reflector`-style identifiers keep their underscores.
 */
export function plainTextFromMarkdown(input: string): string {
  return splitInlineCode(input)
    .map((segment) =>
      segment.kind === 'code'
        ? segment.value
        : segment.value
            .replace(/!?\[([^[\]]*)\]\([^()\s]*\)/g, '$1')
            .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
            .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1$2')
            .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2'),
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first sentence of `plainTextFromMarkdown(input)`, capped at `max`
 * characters with an ellipsis: what a card's `aria-describedby` reads, so a
 * Tab stop announces a summary instead of a whole SKILL.md description.
 */
export function shortSummary(input: string, max = 160): string {
  const text = plainTextFromMarkdown(input);
  const sentence = /^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  if (sentence.length <= max) return sentence;
  return `${sentence.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A short string an agent wrote (a goal criterion, an agent description) with
 * its `code spans` drawn as the chat's inline-code chip instead of literal
 * backticks. Inline only: no block elements and no links, so it is safe inside
 * a menu row or a `line-clamp` paragraph.
 */
export function InlineCodeText({ text }: { text: string }): React.ReactElement {
  return (
    <>
      {splitInlineCode(text).map((segment, index) =>
        segment.kind === 'code' ? (
          // The chat's chip as is: 0.8rem sits level with the xs/sm text around it.
          <code key={index} className={INLINE_CODE}>
            {segment.value}
          </code>
        ) : (
          segment.value
        ),
      )}
    </>
  );
}
