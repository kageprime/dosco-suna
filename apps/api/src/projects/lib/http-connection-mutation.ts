import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../../iam';
import { loadProjectForUser, projectCapabilityAllowed } from './access';
import { loadConnectionForMutation, mayMutateConnection } from './connection-mutation';
import { requestAgentPrincipalReach } from './personal-resources';

/**
 * The project and the connection the caller may mutate, or `null`. The
 * project load needs only `read`: `mayMutateConnection` is the gate. Callers
 * answer `null` with 404, so a caller cannot probe for connections they cannot
 * reach. An agent session acting for a person gets the person's answer:
 * the same capability decides for both.
 */
export async function loadMutableConnection(c: Context, projectId: string, connectionId: string) {
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return null;
  const connection = await loadConnectionForMutation(projectId, connectionId, loaded.row.accountId);
  if (!connection) return null;
  const [mayManageSystemConnections, agentPrincipal] = await Promise.all([
    projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
    ),
    requestAgentPrincipalReach(c, loaded.actor),
  ]);
  const actor = {
    userId: loaded.userId,
    isServiceAccount: c.get('authType') === 'service_account',
    mayManageSystemConnections,
    agentPrincipal,
  };
  if (!mayMutateConnection(connection, actor)) return null;
  return { loaded, connection, mayManageSystemConnections };
}
