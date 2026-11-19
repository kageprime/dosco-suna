import { describe, expect, mock, test } from 'bun:test';
import type { FlatModel } from '@kortix/sdk/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { Command } from '../../primitives/command';
import { IntlTestProvider } from '../../test-utils/intl';
import { ModelPickerPanel } from './model-picker-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'children' in node) {
    return textOf((node as { children?: unknown[] }).children);
  }
  return '';
}

function model(partial: Partial<FlatModel> & Pick<FlatModel, 'providerID' | 'modelID'>): FlatModel {
  return {
    providerName: 'Dosco',
    modelName: partial.modelID,
    ...partial,
  };
}

const CATALOG: FlatModel[] = [
  model({ providerID: 'kortix', modelID: 'claude-opus-4-6', modelName: 'Claude Opus 4.6', capabilities: { reasoning: true } }),
  model({ providerID: 'kortix', modelID: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6', capabilities: { reasoning: true } }),
  model({ providerID: 'kortix', modelID: 'claude-haiku-4-5', modelName: 'Claude Haiku 4.5' }),
  model({ providerID: 'kortix', modelID: 'gpt-5-4', modelName: 'GPT-5.4', capabilities: { reasoning: true } }),
  model({ providerID: 'kortix', modelID: 'openrouter/free', modelName: 'Free Router', free: true }),
  model({
    providerID: 'antigravity',
    modelID: 'gemini-4-argon',
    modelName: 'Gemini 4 Argon',
    defaultEffort: 'medium',
    badge: 'new',
    variants: { low: {}, medium: {}, high: {}, extra: {} },
  }),
  model({
    providerID: 'antigravity',
    modelID: 'gemini-4-hydrogen',
    modelName: 'Gemini 4 Hydrogen',
    defaultEffort: 'medium',
    badge: 'new',
    variants: { low: {}, medium: {}, high: {}, extra: {} },
  }),
  model({
    providerID: 'antigravity',
    modelID: 'orchestrator-argon',
    modelName: 'Orchestrator (Argon)',
    badge: 'new',
  }),
  model({
    providerID: 'antigravity',
    modelID: 'gpt-oss-120b',
    modelName: 'GPT-OSS 120B (Medium)',
    badge: 'notice',
  }),
  model({
    providerID: 'antigravity',
    modelID: 'gemini-4-carbon',
    modelName: 'Gemini 4 Carbon',
    badge: 'unavailable',
    unavailable: true,
  }),
];

describe('ModelPickerPanel', () => {
  test('renders Antigravity-style Model header, effort labels, pill badges, View Usage, and inline effort fallback', () => {
    const html = renderToStaticMarkup(
      <IntlTestProvider locale="en" onError={() => {}}>
        <Command shouldFilter={false}>
          <ModelPickerPanel
            browseModels={CATALOG}
            pickableModels={CATALOG}
            searchModels={CATALOG}
            search=""
            onSearchChange={() => {}}
            selected={{ providerID: 'antigravity', modelID: 'gemini-4-argon' }}
            onPick={() => {}}
            isFavorite={() => false}
            setFavorite={() => {}}
            loading={false}
            emptyState={<div>Empty</div>}
            searchEmpty={<div>No match</div>}
            connectLabel="Connect"
            onViewUsage={() => {}}
            effort={{
              choices: ['low', 'medium', 'high', 'extra'],
              selectedVariant: 'high',
              onChange: () => {},
            }}
          />
        </Command>
      </IntlTestProvider>,
    );

    expect(html).toContain('Model');
    expect(html).toContain('Gemini 4 Argon');
    expect(html).toContain('Orchestrator (Argon)');
    expect(html).toContain('GPT-OSS 120B (Medium)');
    expect(html).toContain('Gemini 4 Carbon');
    expect(html).toContain('New');
    expect(html).toContain('Notice');
    expect(html).toContain('Unavailable');
    expect(html).toContain('View Usage');
    expect(html).toContain('High');
    expect(html).toContain('Auto');
    expect(html).toContain('scrollbar-hide');
  });

  test('groups providers inline without top tabs, opens the right-hand effort submenu, and picks an effort cleanly', async () => {
    const onVariantChange = mock(() => {});
    const onPick = mock(() => {});
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <IntlTestProvider locale="en" onError={() => {}}>
          <Command shouldFilter={false}>
            <ModelPickerPanel
              browseModels={CATALOG}
              pickableModels={CATALOG}
              searchModels={CATALOG}
              search=""
              onSearchChange={() => {}}
              selected={{ providerID: 'antigravity', modelID: 'gemini-4-hydrogen' }}
              onPick={onPick}
              isFavorite={() => false}
              setFavorite={() => {}}
              loading={false}
              emptyState={<div>Empty</div>}
              searchEmpty={<div>No match</div>}
              connectLabel="Connect"
              effort={{
                choices: ['low', 'medium', 'high', 'extra'],
                selectedVariant: 'medium',
                onChange: onVariantChange,
              }}
            />
          </Command>
        </IntlTestProvider>,
      );
    });

    // No top horizontal provider tablist
    const tabs = renderer.root.findAll((node) => node.type === 'button' && node.props.role === 'tab');
    expect(tabs).toHaveLength(0);

    // Provider groups appear inline cleanly
    const renderedText = textOf(renderer.toJSON());
    expect(renderedText).toContain('Dosco');
    expect(renderedText).toContain('Google Antigravity');
    expect(renderedText).not.toContain('modelSelector.all');

    // Open the Antigravity-style right-hand effort submenu for Gemini 4 Hydrogen
    const hydrogenChevron = renderer.root.find(
      (node) => node.type === 'button' && node.props['aria-label'] === 'Select effort for Gemini 4 Hydrogen',
    );
    await act(async () => {
      hydrogenChevron.props.onClick({ stopPropagation: () => {} });
    });

    const submenuRadios = renderer.root.findAll(
      (node) => node.type === 'button' && node.props.role === 'menuitemradio',
    );
    expect(submenuRadios.map((n) => textOf(n).trim())).toEqual(['Low', 'Medium', 'High', 'Extra']);

    // Clicking Extra inside the submenu sets the effort variant
    await act(async () => {
      submenuRadios[3]!.props.onClick({ stopPropagation: () => {} });
    });
    expect(onVariantChange).toHaveBeenCalledWith('extra');

    renderer.unmount();
  });

  test('minimizes non-selected provider groups and shows only the active group models on initial open', () => {
    const html = renderToStaticMarkup(
      <IntlTestProvider locale="en" onError={() => {}}>
        <Command shouldFilter={false}>
          <ModelPickerPanel
            browseModels={CATALOG}
            pickableModels={CATALOG}
            searchModels={CATALOG}
            search=""
            onSearchChange={() => {}}
            selected={{ providerID: 'antigravity', modelID: 'gemini-4-hydrogen' }}
            onPick={() => {}}
            isFavorite={() => false}
            setFavorite={() => {}}
            loading={false}
            emptyState={<div>Empty</div>}
            searchEmpty={<div>No match</div>}
            connectLabel="Connect"
          />
        </Command>
      </IntlTestProvider>,
    );

    // Dosco (5 models in fixture) stays minimized while Google Antigravity (selected) is expanded.
    expect(html).toContain('Dosco');
    expect(html).not.toContain('Claude Opus 4.6');
    expect(html).toContain('Google Antigravity');
    expect(html).toContain('Gemini 4 Hydrogen');
  });
});
