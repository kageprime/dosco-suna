import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { InlineMeta } from './inline-meta';

/**
 * At phone width a trigger row's meta line wrapped: the target text ran under
 * the switch (its `truncate` sat on an inline box, which never clips), and a
 * wrapped line started with a separator dot. Static markup pins the structure
 * that prevents both.
 */
const ITEM = '<span data-inline-meta-item="" class="inline-flex max-w-full min-w-0 items-center gap-2">';
const DOT = '<span aria-hidden="true" class="bg-muted-foreground size-1 shrink-0 rounded-full"></span>';

describe('InlineMeta', () => {
  test('a child with `truncate` sits in an inline-flex item capped at the row width', () => {
    const html = renderToStaticMarkup(
      <InlineMeta>
        <span>Schedule</span>
        <span className="min-w-0 truncate">Wakes a very long session name</span>
      </InlineMeta>,
    );
    expect(html).toContain(`${ITEM}<span class="min-w-0 truncate">Wakes a very long session name</span></span>`);
  });

  test('each dot ends the item before it, so a wrapped line never starts with one', () => {
    const html = renderToStaticMarkup(
      <InlineMeta>
        <span>A</span>
        {null}
        <span>B</span>
        <span>C</span>
      </InlineMeta>,
    );
    // Three items, two dots: after A and after B, none after C or before A.
    expect(html.split(ITEM).length - 1).toBe(3);
    expect(html.split(DOT).length - 1).toBe(2);
    expect(html).toContain(`${ITEM}<span>A</span>${DOT}</span>`);
    expect(html).toContain(`${ITEM}<span>B</span>${DOT}</span>`);
    expect(html).toContain(`${ITEM}<span>C</span></span>`);
  });

  test('a plain string item renders without a dot when it is alone', () => {
    const html = renderToStaticMarkup(<InlineMeta>{'Only'}</InlineMeta>);
    expect(html).toContain(`${ITEM}Only</span>`);
    expect(html).not.toContain(DOT);
  });
});
