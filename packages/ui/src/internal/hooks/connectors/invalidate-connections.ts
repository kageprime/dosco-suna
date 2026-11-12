import { qk } from '@kortix/sdk/react';
import type { QueryClient } from '@tanstack/react-query';

/**
 * The query keys every connection read uses (`sections/connector-connection-form`
 * read them here before the form's own need was the only one). The SDK's `qk`
 * plus the ad-hoc keys the panels hand to their queries.
 */
export function connectorConnectionQueryKeys(projectId: string) {
  return [
    qk.project.connectors(projectId),
    ['connections', projectId],
    ['connections-all', projectId],
    ['session-scope-catalog', projectId],
  ] as const;
}

/** Invalidate every connection read: an account row changed somewhere else. */
export function invalidateConnections(client: QueryClient, projectId: string) {
  return Promise.all(
    connectorConnectionQueryKeys(projectId).map((queryKey) =>
      client.invalidateQueries({ queryKey }).catch(() => undefined),
    ),
  );
}
