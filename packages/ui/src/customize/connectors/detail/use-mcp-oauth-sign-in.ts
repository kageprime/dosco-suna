'use client';

import { discoverConnectionOAuth2Resource, type AdminConnector } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { autoConnectPlan } from '../../sections/connector-oauth2-auto';

/**
 * True when this MCP connector's accounts sign in through the server's
 * one-click OAuth, not a typed credential. The banner and the account rows then
 * say "Sign in", never "credential".
 *
 * Whether a server signs in with OAuth is a property of the server, so one
 * account answers for the connector: the probe is the same discovery Install
 * and the row's sign-in run. Only an account the caller may change can be
 * probed; any other answer (no account, a refusal, no OAuth) is `false`, and
 * the page keeps the credential wording.
 */
export function useMcpOAuthSignIn(
  projectId: string,
  connector: Pick<AdminConnector, 'provider' | 'authSecret'>,
  connectionId: string | null,
): boolean {
  const enabled = connector.provider === 'mcp' && Boolean(connector.authSecret) && Boolean(connectionId);
  const query = useQuery({
    queryKey: ['connector-oauth-sign-in', projectId, connectionId],
    queryFn: async () => {
      const { discovery } = await discoverConnectionOAuth2Resource(projectId, connectionId!);
      return autoConnectPlan(discovery).kind === 'register';
    },
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  });
  return enabled && query.data === true;
}
