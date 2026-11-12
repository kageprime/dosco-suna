import type { AdminConnector } from '@kortix/sdk';

/** The connector states and their rules live in `@kortix/sdk`. */
export {
  connectorDerivedState,
  connectorStatusTone,
  connectorUsable,
  type ConnectorDerivedState,
  type ConnectorStatusTone,
} from '@kortix/sdk';

import { connectorStatusTone, type ConnectorStatusTone } from '@kortix/sdk';

import { providerLabel } from '../provider-label';

/**
 * The tone a connector shows. `no_tools`: an HTTP connector that works but has
 * no routes, so agents have nothing to call. It reads "No tools", not
 * "Connected" with a 0 beside it.
 */
export type ConnectorTone = ConnectorStatusTone | 'no_tools';

/** An HTTP connector with no routes: it gives agents no tools. */
export function connectorHasNoTools(connector: Pick<AdminConnector, 'provider' | 'actions'>): boolean {
  return connector.provider === 'http' && (connector.actions?.length ?? 0) === 0;
}

export function connectorTone(
  connector: Parameters<typeof connectorStatusTone>[0] & Pick<AdminConnector, 'provider' | 'actions'>,
  accountCount?: number,
): ConnectorTone {
  const tone = connectorStatusTone(connector, accountCount);
  return tone === 'connected' && connectorHasNoTools(connector) ? 'no_tools' : tone;
}

export const STATUS_DOT: Record<ConnectorTone, string> = {
  connected: 'bg-kortix-green',
  account: 'bg-kortix-orange',
  error: 'bg-kortix-red',
  no_tools: 'bg-kortix-orange',
};

/** The `connectorPages` key of each state's word. */
export const STATUS_WORD = {
  connected: 'statusConnected',
  account: 'statusNeedsAccount',
  error: 'statusError',
  no_tools: 'statusNoTools',
} as const;

/** What the connector runs over: its provider, named the way a person says it. */
export function connectorRunsOver(provider: AdminConnector['provider']): string {
  if (provider === 'composio') return 'Composio';
  if (provider === 'pipedream') return 'Pipedream';
  if (provider === 'openapi') return 'OpenAPI';
  if (provider === 'graphql') return 'GraphQL';
  return providerLabel(provider);
}
