import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UiProvider } from '../../providers/ui-provider';
import { SessionConnectNotice } from '../../session/prompts/session-connect-card';

// A task-specific request is not the workspace's optional setup checklist.
test('a task-requested connector stays actionable even when optional setup was skipped', () => {
  localStorage.setItem(
    'kortix.setup.skippedConnectors.synthetic-workspace',
    JSON.stringify(['synthetic-calendar']),
  );
  const html = renderToStaticMarkup(
    <UiProvider>
      <SessionConnectNotice
        projectId='synthetic-workspace'
        requests={[
          {
            slug: 'synthetic-calendar',
            app: 'calendar',
            provider: 'mcp',
            connected: false,
            connection_id: 'synthetic-account',
          },
        ]}
        onSettled={() => {}}
      />
    </UiProvider>,
  );
  expect(html).toContain('data-testid="session-connect-row"');
  expect(html).toContain('Connect');
  expect(html).not.toContain('disabled=""');
  localStorage.clear();
});
