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
  test('renders compact single-column model list with filter tabs and inline effort options', () => {
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
            effort={{
              choices: ['low', 'medium', 'high'],
              selectedVariant: 'high',
              onChange: () => {},
            }}
          />
        </Command>
      </IntlTestProvider>,
    );

    expect(html).toContain('Claude');
    expect(html).toContain('Sonnet 4.6');
    expect(html).toContain('modelSelector.all');
    expect(html).toContain('High');
    expect(html).toContain('Auto');
    expect(html).toContain('scrollbar-hide');
  });

  test('switches provider tabs and picks effort options cleanly', async () => {
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

    // Provider filter tabs exist (All, Favorites, Dosco, etc.)
    const tabs = renderer.root.findAll((node) => node.type === 'button' && node.props.role === 'tab');
    expect(tabs.length).toBeGreaterThanOrEqual(2);

    // Effort buttons exist inline (Auto, Low, Medium, High)
    const effortButtons = renderer.root.findAll(
      (node) => node.type === 'button' && ['Auto', 'Low', 'Medium', 'High'].includes(textOf(node).trim()),
    );
    expect(effortButtons.length).toBe(4);

    // Clicking high effort calls onVariantChange
    await act(async () => {
      effortButtons[3]!.props.onClick();
    });
    expect(onVariantChange).toHaveBeenCalledWith('high');

    renderer.unmount();
  });
});
