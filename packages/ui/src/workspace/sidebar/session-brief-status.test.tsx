import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlTestProvider } from '../../test-utils/intl';
import { sessionDisplayStatus } from '../../session/actions/session-label';
import { SessionBriefDescription } from './session-brief-hover-card';
import type { ProjectSession } from '@kortix/sdk';

// Synthetic values only. Audit finding 04: the sidebar said "Ready" for a
// finished session and "Asleep" for a stopped one, the words of the computer,
// not of the work. The row's status sentence (read by a screen reader and by
// the hover brief) now says "Done" and "Stopped".

const idle = { state: 'idle' as const, since: null, turn_token: null, pending_delivery: false };
const busy = { state: 'working' as const, since: null, turn_token: 't', pending_delivery: false };
const row = (fields: Partial<ProjectSession>) => ({ session_id: 's1', project_id: 'p1', metadata: {}, ...fields }) as ProjectSession;

function sentence(session: ProjectSession): string {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlTestProvider>
        <SessionBriefDescription
          projectId="p1"
          sessionId="s1"
          id="d1"
          status={sessionDisplayStatus(session)}
          createdAt="2026-11-15T10:00:00.000Z"
          source={{ kind: 'chat', label: 'Chat' } as never}
          changeRequests={[]}
          waitingOn="review"
        />
      </IntlTestProvider>
    </QueryClientProvider>,
  );
}

describe('sidebar row status words (audit finding 04)', () => {
  test('a session whose turn ended reads Done, not Ready', () => {
    const html = sentence(row({ status: 'running', working: idle }));
    expect(html).toContain('Status: Done.');
    expect(html).not.toContain('Ready');
  });

  test('a stopped session reads Stopped, not Asleep', () => {
    const html = sentence(row({ status: 'stopped' }));
    expect(html).toContain('Status: Stopped.');
    expect(html).not.toContain('Asleep');
  });

  test('a working session still reads Working', () => {
    expect(sentence(row({ status: 'running', working: busy }))).toContain('Status: Working.');
  });
});
