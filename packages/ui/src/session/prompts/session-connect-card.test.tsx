import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionConnectNotice } from './session-connect-card';
import type { SessionConnectRequest } from '@kortix/sdk';

const calendar: SessionConnectRequest = {
  slug: 'google-calendar', app: 'googlecalendar', name: 'Google Calendar', provider: 'mcp',
  connected: false, connection_id: 'calendar-synthetic', owner_type: 'member',
};
const drive = { ...calendar, slug: 'google-drive', name: 'Google Drive', connection_id: 'drive-synthetic' };
const draw = (requests: SessionConnectRequest[]) => renderToStaticMarkup(
  <SessionConnectNotice requests={requests} projectId="synthetic-project" onSettled={() => undefined} />,
);

test('pending and connected cards retain app identity and unrelated requests on a fresh render', () => {
  const pending = draw([calendar, drive]);
  expect(pending).toContain('Google Calendar');
  expect(pending).toContain('>Connect<');
  expect(pending).not.toContain('data-connected="true"');
  const completed = { ...calendar, connected: true, connected_as: 'agent@kortix.ai' };
  for (let render = 0; render < 2; render++) {
    const html = draw([completed, drive]);
    expect(html).toContain('Connected as agent@kortix.ai');
    expect(html).toContain('Google Calendar');
    expect(html).toContain('Google Drive');
    expect(html.match(/data-connected="true"/g)).toHaveLength(1);
    expect(html.match(/>Connect</g)).toHaveLength(1);
  }
});
