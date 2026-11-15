import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ActionBar, type ActionBarAction, ActionBarDock, keyLabel, toAriaKeyshortcuts } from './action-bar';

const noop = () => {};
const actions: ActionBarAction[] = [
  { id: 'discard', label: 'Discard', onSelect: noop },
  { id: 'save', label: 'Save', kbd: ['mod', 'S'], emphasis: 'primary', onSelect: noop },
  { id: 'delete', label: 'Delete', tone: 'destructive', onSelect: noop },
];
const bar = (props: Partial<Parameters<typeof ActionBar>[0]> = {}) =>
  renderToStaticMarkup(
    <ActionBar
      title="Unsaved changes."
      description="Overview and Access"
      actions={actions}
      close={{ label: 'Exit selection', onSelect: noop }}
      {...props}
    />,
  );
const button = (out: string, label: string) =>
  out.match(
    new RegExp(`<button(?:(?!<button).)*?(?:aria-label="${label}"[^>]*>|>${label}</span>(?:(?!<button).)*?</button>)`),
  )?.[0] ?? '';

describe('ActionBar', () => {
  test('announces the title and description; actions sit in one group before the close ×', () => {
    const out = bar();
    expect(out).toContain('data-slot="action-bar"');
    expect(out).toMatch(/aria-live="polite"[^>]*>.*Unsaved changes\..*Overview and Access/);
    expect(out).toContain('data-slot="button-group"');
    const order = ['Discard', 'Save', 'Delete', 'Exit selection'].map((l) => out.indexOf(button(out, l)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('kbd draws one Kbd per key in a KbdGroup and names the shortcut for assistive tech', () => {
    const save = button(bar(), 'Save');
    // The server renders the Mac glyph; the client corrects after hydration.
    expect(save).toContain('aria-keyshortcuts="Meta+S"');
    expect(save).toMatch(/<kbd data-slot="kbd-group"[^>]*><kbd data-slot="kbd"[^>]*>⌘<\/kbd><kbd data-slot="kbd"[^>]*>S<\/kbd><\/kbd>/);
    expect(button(bar(), 'Discard')).not.toContain('<kbd');
  });

  test('primary emphasis fills the button; tones colour the label', () => {
    const out = bar();
    expect(button(out, 'Save')).toContain('bg-action');
    expect(button(out, 'Discard')).not.toContain('bg-action');
    expect(button(out, 'Delete')).toContain('text-destructive');
  });

  test('no close prop, no ×', () => {
    expect(button(bar({ close: undefined }), 'Exit selection')).toBe('');
  });

  test('busy leads with the dot matrix and disables every control', () => {
    const out = bar({ busy: true });
    for (const l of ['Discard', 'Save', 'Delete', 'Exit selection']) {
      expect(button(out, l)).toContain('disabled=""');
    }
  });

  test('a loading action spins and disables alone', () => {
    const out = bar({ actions: [{ id: 'paste', label: 'Paste here', loading: true, onSelect: noop }, actions[0]!] });
    expect(button(out, 'Paste here')).toContain('disabled=""');
    expect(button(out, 'Paste here')).toContain('aria-busy="true"');
    expect(button(out, 'Discard')).not.toContain('disabled=""');
  });

  test('enters from a faded 8px rise; animateIn=false paints at rest', () => {
    const root = (out: string) => out.match(/^<div[^>]*>/)?.[0] ?? '';
    expect(root(bar())).toContain('opacity:0;transform:translateY(8px)');
    expect(root(bar({ animateIn: false }))).toContain('opacity:1;transform:translateY(0px)');
  });

  test('ActionBarDock pins to the bottom centre and lets clicks through its gutter', () => {
    const out = renderToStaticMarkup(<ActionBarDock>x</ActionBarDock>);
    expect(out).toContain('pointer-events-none absolute inset-x-0 bottom-4');
    expect(out).toContain('pointer-events-auto w-full max-w-xl');
  });

  test('a long title truncates instead of pushing the actions', () => {
    const out = bar({ title: 'Moving a-very-long-file-name.md' });
    expect(out).toMatch(/<span class="min-w-0 truncate">Moving/);
  });

  test('mod is ⌘ on a Mac and Ctrl elsewhere, in the label and the aria name', () => {
    expect(keyLabel('mod', true)).toBe('⌘');
    expect(keyLabel('mod', false)).toBe('Ctrl');
    expect(keyLabel('s', false)).toBe('S');
    expect(toAriaKeyshortcuts(['mod', 'shift', 'p'], true)).toBe('Meta+Shift+P');
    expect(toAriaKeyshortcuts(['mod', 'S'], false)).toBe('Control+S');
  });
});
