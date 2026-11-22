import { describe, expect, test } from 'bun:test';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import { defaultUiMessages } from '../../i18n';
import { SessionIdsProvider } from '../../providers/session-ids';
import { type UiHostComponents, UiProvider } from '../../providers/ui-provider';
import { ModelConnectionBar } from '../../session/models/model-connection-gate';
import { FirstChat } from './first-chat';

const PROJECT = 'p-synthetic';
const ROWS_LABEL = defaultUiMessages.sessionUi.modelGate.offerTitle;
// The ✕ only the dismissible offer carries.
const HIDE_CHATGPT = defaultUiMessages.sessionUi.modelGate.hidePlan.replace('{name}', 'ChatGPT');
// The host's provider dialog slot: with it, the gate may offer Connect.
const COMPONENTS: UiHostComponents = { ProjectProviderModal: () => null };
const CONFIG = { accountApiEnabled: false };

/**
 * First-chat home with `/model-picker` serving one runnable Kortix model and
 * no ChatGPT or Claude plan: the input that makes `SubscriptionOffer` want to
 * show. `composerNoModel` is what the composer decided from its own selection;
 * the composer hands that decision to `ModelConnectionBar`.
 */
function renderFirstChat(composerNoModel: boolean): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(qk.project.modelPicker(PROJECT), {
    models: {
      'kortix/synthetic-model': { name: 'Synthetic model', enabled: true },
    },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <UiProvider config={CONFIG} components={COMPONENTS}>
        <SessionIdsProvider projectId={PROJECT}>
          <FirstChat projectId={PROJECT} composer={<ModelConnectionBar show={composerNoModel} />} />
        </SessionIdsProvider>
      </UiProvider>
    </QueryClientProvider>,
  );
}

const rowSets = (html: string) => html.split(`aria-label="${ROWS_LABEL}"`).length - 1;

describe('first-chat connect rows', () => {
  test('one set of rows when the composer has no usable model, though /model-picker lists one', () => {
    const html = renderFirstChat(true);
    expect(rowSets(html)).toBe(1);
    // The composer's no-model rows: the reason line, and no dismiss control.
    expect(html).toContain('data-testid="no-model-reason"');
    expect(html).not.toContain(`aria-label="${HIDE_CHATGPT}"`);
  });

  test('one set of rows, the dismissible offer, when the composer has a model', () => {
    const html = renderFirstChat(false);
    expect(rowSets(html)).toBe(1);
    expect(html).not.toContain('data-testid="no-model-reason"');
    expect(html).toContain(`aria-label="${HIDE_CHATGPT}"`);
  });
});
