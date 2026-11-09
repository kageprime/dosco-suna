import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '../../primitives/tooltip';
import { IntlTestProvider } from '../../test-utils/intl';
import { stripTags } from '../../test-utils/strip-tags';

/**
 * Static render under the full provider stack the tool views read — the
 * package i18n catalog (`IntlTestProvider`), a fresh react-query client and
 * tooltips. Returns the markup and its visible text (`stripTags` of the
 * markup), so an assertion picks the one it means.
 */
export function renderStatic(node: ReactNode): { html: string; text: string } {
  const html = renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>,
  );
  return { html, text: stripTags(html) };
}
