import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('../../internal/lib/use-project-can', () => ({
  useProjectCan: () => ({ allowed: false }),
  useProjectPageCans: () => ({}),
}));
mock.module('../use-configure-thread', () => ({
  useConfigureThread: () => ({ pending: false }),
  newConfigPrompt: () => '',
}));

const { AgentsPage } = await import('./agents-page');

// KRTX-3025: the card shows what the configuration grants, not the agent's prose.
describe('AgentsPage access line', () => {
  test('each grant reads All, None or its count', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(qk.project.detail('synthetic-project'), {
      account_id: 'synthetic-account',
      config: {
        default_agent: 'kortix',
        agents: [
          {
            name: 'kortix',
            path: 'agents/kortix.md',
            mode: 'primary',
            description: 'General knowledge worker.',
            scope: { env: 'all', connectors: 'all', kortix_permissions: 'all', kortix_cli: 'all' },
          },
          {
            name: 'store-builder',
            path: 'agents/store-builder.md',
            mode: 'primary',
            scope: { env: [], connectors: ['notion', 'gmail'], kortix_permissions: 'all', kortix_cli: 'all' },
          },
          {
            name: 'reflector',
            path: 'agents/reflector.md',
            mode: 'primary',
            scope: { env: [], connectors: [], kortix_permissions: 'all', kortix_cli: 'all' },
          },
        ],
      },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AgentsPage projectId="synthetic-project" />
      </QueryClientProvider>,
    );
    // One grant vocabulary on every surface: All, None, or a count.
    expect(markup).toContain('title="Connectors: All"');
    expect(markup).toContain('title="Connectors: 2"');
    expect(markup).toContain('title="Secrets: None"');
    expect(markup).toContain('title="Permissions: All"');
    expect(markup).toContain('@kortix');
    expect(markup).toContain('@store-builder');
    for (const absent of ['Full access', 'all permissions', 'No connectors', 'All Kortix actions', 'Default model']) {
      expect(markup).not.toContain(absent);
    }
  });

  test('renders mode filter pills when both primary agents and subagents exist', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(qk.project.detail('synthetic-project-mixed'), {
      account_id: 'synthetic-account',
      config: {
        default_agent: 'xera',
        agents: [
          {
            name: 'xera',
            path: 'agents/xera.md',
            mode: 'primary',
            description: 'Primary worker.',
            scope: { env: 'all', connectors: 'all', kortix_permissions: 'all', kortix_cli: 'all' },
          },
          {
            name: 'research-helper',
            path: 'agents/research-helper.md',
            mode: 'subagent',
            description: 'Dedicated research subagent.',
            scope: { env: [], connectors: [], kortix_permissions: 'all', kortix_cli: 'all' },
          },
        ],
      },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AgentsPage projectId="synthetic-project-mixed" />
      </QueryClientProvider>,
    );
    expect(markup).toContain('subagents-heading');
    expect(markup).toContain('Subagents');
    expect(markup).toContain('@xera');
    expect(markup).toContain('@research-helper');
  });

  test('AgentsPage accepts onSelectAgent callback prop without crashing', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(qk.project.detail('synthetic-project-mixed'), {
      account_id: 'synthetic-account',
      config: {
        default_agent: 'xera',
        agents: [
          {
            name: 'xera',
            path: 'agents/xera.md',
            mode: 'primary',
            description: 'Primary worker.',
            scope: { env: 'all', connectors: 'all', kortix_permissions: 'all', kortix_cli: 'all' },
          },
        ],
      },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AgentsPage
          projectId="synthetic-project-mixed"
          onSelectAgent={(_name) => {}}
        />
      </QueryClientProvider>,
    );
    expect(markup).toContain('@xera');
  });
});

// KRTX-4810: the list shows each agent's role, so a helper My Kortix created
// reads as a subagent at a glance and a promoted one shows as primary.
describe('AgentsPage role badge', () => {
  const agentWithMode = (name: string, mode?: string) => ({
    name,
    path: `agents/${name}.md`,
    ...(mode ? { mode } : {}),
    description: `${name} does its job.`,
    scope: { env: [], connectors: [], kortix_permissions: [], kortix_cli: [] },
  });

  const render = (agents: ReturnType<typeof agentWithMode>[]) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(qk.project.detail('synthetic-project'), {
      account_id: 'synthetic-account',
      config: { default_agent: 'lead', agents },
    });
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AgentsPage projectId="synthetic-project" />
      </QueryClientProvider>,
    );
  };

  test('each card names its role: primary, subagent, all', () => {
    const markup = render([
      agentWithMode('lead', 'primary'),
      agentWithMode('helper', 'subagent'),
      agentWithMode('both-ways', 'all'),
    ]);
    expect(markup).toContain('>Primary</span>');
    expect(markup).toContain('>Subagent</span>');
    expect(markup).toContain('>All</span>');
  });

  test('an undeclared mode reads as primary — the runtime\'s own assumption', () => {
    const markup = render([agentWithMode('undeclared')]);
    expect(markup).toContain('>Primary</span>');
    expect(markup).not.toContain('>Subagent</span>');
  });
});

// Settings audit 2026-11-14, finding 08: the name a person typed survives.
describe('AgentsPage agent names', () => {
  test('a titled agent shows its title; an untitled one keeps the derived name', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(qk.project.detail('synthetic-project'), {
      account_id: 'synthetic-account',
      config: {
        default_agent: 'github-pr-reviewer',
        agents: [
          { name: 'github-pr-reviewer', title: 'GitHub PR Reviewer', path: '', mode: 'primary', description: null },
          { name: 'memory-reflector', path: '', mode: 'primary', description: null },
        ],
      },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AgentsPage projectId="synthetic-project" />
      </QueryClientProvider>,
    );
    expect(markup).toContain('GitHub PR Reviewer');
    expect(markup).not.toContain('Github pr reviewer');
    expect(markup).toContain('Memory reflector');
  });
});
