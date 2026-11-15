import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentCoverCard } from './agent-cover-card';

describe('AgentCoverCard accessible name', () => {
  const description = 'Curates `.kortix/memory/` — runs on the `memory-reflector` trigger.';

  test('the link is named by the title and described by the summary', () => {
    const markup = renderToStaticMarkup(
      <AgentCoverCard slug="memory-reflector" href="/x" title="Memory reflector" description={description} coverLabel="Default" />,
    );
    const labelledby = markup.match(/<a[^>]*aria-labelledby="([^"]+)"/)?.[1];
    const describedby = markup.match(/<a[^>]*aria-describedby="([^"]+)"/)?.[1];
    expect(markup).toContain(`id="${labelledby}" class="text-foreground truncate text-sm font-medium">Memory reflector<`);
    expect(markup).toContain(`id="${describedby}"`);
  });

  test('the summary shows plain words, without backticks', () => {
    const markup = renderToStaticMarkup(
      <AgentCoverCard slug="memory-reflector" href="/x" title="Memory reflector" description={description} />,
    );
    expect(markup).toContain('Curates .kortix/memory/ — runs on the memory-reflector trigger.');
    expect(markup).not.toContain('`');
  });
});
