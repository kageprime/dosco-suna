import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

import { AboutDescription } from './agent-overview';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const raw = 'Curates `.kortix/memory/` and `a` b.';

describe('AboutDescription', () => {
  test('read-only view draws code spans as code, without backticks', () => {
    const html = renderToStaticMarkup(createElement(AboutDescription, { value: raw, subagent: false }));
    expect(html).toMatch(/<code[^>]*>\.kortix\/memory\/<\/code>/);
    expect(html).toMatch(/<code[^>]*>a<\/code> b\./);
    expect(html).not.toContain('`');
  });

  test('editable view draws code spans as code, without backticks', () => {
    const html = renderToStaticMarkup(
      createElement(AboutDescription, { value: raw, onChange: () => {}, subagent: false }),
    );
    expect(html).toMatch(/<button[^>]*>[\s\S]*<code[^>]*>a<\/code> b\./);
    expect(html).not.toContain('`');
  });

  test('edit mode shows the raw markdown, and Escape writes it back unchanged', () => {
    const writes: string[] = [];
    let value = raw;
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        createElement(AboutDescription, {
          value,
          onChange: (next: string) => {
            writes.push(next);
            value = next;
          },
          subagent: false,
        }),
      );
    });
    act(() => {
      renderer.root.findByType('button').props.onClick();
    });
    const field = renderer.root.findByType('textarea');
    expect(field.props.value).toBe(raw);
    act(() => {
      field.props.onKeyDown({ key: 'Escape', preventDefault: () => {} });
    });
    expect(writes).toEqual([raw]);
    act(() => renderer.unmount());
  });
});
