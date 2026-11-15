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
  model({ providerID: 'antigravity', modelID: 'gemini-3-5-flash-low', modelName: 'Gemini 3.5 Flash Lite', defaultEffort: 'low' }),
  model({ providerID: 'antigravity', modelID: 'gemini-3-5-flash-high', modelName: 'Gemini 3.5 Flash Lite', defaultEffort: 'high' }),
];

describe('ModelPickerPanel', () => {
  test('renders compact curated primary list with descriptions, footer rows, upgrade bar, and no keycap pills', () => {
    const html = renderToStaticMarkup(
      <IntlTestProvider locale="en" onError={() => {}}>
        <Command shouldFilter={false}>
          <ModelPickerPanel
            browseModels={CATALOG}
            pickableModels={CATALOG}
            searchModels={CATALOG}
            search=""
            onSearchChange={() => {}}
            selected={{ providerID: 'kortix', modelID: 'claude-sonnet-4-6' }}
            onPick={() => {}}
            isFavorite={() => false}
            setFavorite={() => {}}
            loading={false}
            emptyState={<div>Empty</div>}
            searchEmpty={<div>No match</div>}
            connectLabel="Connect"
            onUpgrade={() => {}}
            effort={{
              choices: ['low', 'medium', 'high'],
              selectedVariant: 'high',
              onChange: () => {},
            }}
          />
        </Command>
      </IntlTestProvider>,
    );

    expect(html).toContain('Claude Sonnet 4.6');
    expect(html).toContain('For complex work and everyday tasks');
    expect(html).toContain('Effort');
    expect(html).toContain('High');
    expect(html).toContain('More models');
    expect(html).toContain('Learn more');
    expect(html).not.toContain('Ctrl1');
    expect(html).not.toContain('⌘1');
  });

  test('drills into Effort and More models views cleanly', async () => {
    const onVariantChange = mock(() => {});
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
              selected={{ providerID: 'kortix', modelID: 'claude-sonnet-4-6' }}
              onPick={() => {}}
              isFavorite={() => false}
              setFavorite={() => {}}
              loading={false}
              emptyState={<div>Empty</div>}
              searchEmpty={<div>No match</div>}
              connectLabel="Connect"
              effort={{
                choices: ['low', 'medium', 'high'],
                selectedVariant: 'medium',
                onChange: onVariantChange,
              }}
            />
          </Command>
        </IntlTestProvider>,
      );
    });

    const effortBtn = renderer.root.find(
      (node) => node.type === 'button' && textOf(node).includes('Effort'),
    );
    await act(async () => {
      effortBtn.props.onClick();
    });

    const radios = renderer.root.findAll((node) => node.type === 'button' && node.props.role === 'radio');
    expect(radios.length).toBe(4); // Auto + low + medium + high
    await act(async () => {
      radios[3]!.props.onClick();
    });
    expect(onVariantChange).toHaveBeenCalledWith('high');

    // Selecting an effort returns smoothly to primary view
    const moreBtn = renderer.root.find(
      (node) => node.type === 'button' && textOf(node).includes('More models'),
    );
    await act(async () => {
      moreBtn.props.onClick();
    });

    const tabs = renderer.root.findAll((node) => node.type === 'button' && node.props.role === 'tab');
    expect(tabs.length).toBeGreaterThanOrEqual(3); // All, Favorites, Dosco, Google Antigravity

    renderer.unmount();
  });
});
