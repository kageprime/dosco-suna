import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlTestProvider } from '../../test-utils/intl';
import { TooltipProvider } from '../../primitives/tooltip';
import { ModelSelector } from './model-selector';
import { accountStateKeys } from '../../internal/billing/use-account-state';

function render(modelsLoading: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(accountStateKeys.state(), {});
  return renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ModelSelector models={[]} selectedModel={null} onSelect={() => {}} modelsLoading={modelsLoading} />
        </TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>,
  );
}

test('the model trigger distinguishes a pending catalog from an empty catalog', () => {
  const pending = render(true);
  expect(pending).not.toContain('No model');
  expect(pending).toContain('aria-label="Loading models"');
  expect(render(false)).toContain('No model');
});
