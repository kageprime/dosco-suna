// Internal: the App calls' two route builders, shared by `apps.ts` and
// `apps-fleet.ts`. Not re-exported from index.ts: no public name (the
// assignments-at.ts pattern). Every App route composes these, so ids are
// encoded once and the route cannot drift per call site. Literal path bases,
// so route-contract.test.ts resolves them.
export const appsPath = (projectId: string) => `/workspaces/${encodeURIComponent(projectId)}/apps`;
export const appPath = (projectId: string, appId: string) =>
  `/workspaces/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appId)}`;
