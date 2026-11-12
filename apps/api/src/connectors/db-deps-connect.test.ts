import { describe, expect, test } from 'bun:test';

import { connectLinkNeedsManagedProvider } from './db-deps-connect';

/**
 * KRTX-4640: `mintConnectorConnectLink` refused to mint a hosted connect link
 * unless Composio or Pipedream was configured on the deployment — even for an
 * `mcp` connector, whose hosted page is Kortix's own OAuth sign-in and needs
 * neither. The `/connect-requests` route already carries that exception; the
 * shared gate says the same thing in one place.
 */
describe('connectLinkNeedsManagedProvider', () => {
  test('a one-click MCP connector needs no managed provider', () => {
    expect(connectLinkNeedsManagedProvider('mcp')).toBe(false);
  });

  test('Composio and Pipedream connectors need their provider configured', () => {
    expect(connectLinkNeedsManagedProvider('composio')).toBe(true);
    expect(connectLinkNeedsManagedProvider('pipedream')).toBe(true);
  });
});
