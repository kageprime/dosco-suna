import type React from 'react';

import { INLINE_CODE } from './code/inline-chip';

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
