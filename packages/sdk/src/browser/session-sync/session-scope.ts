/**
 * `${projectId}/${sessionId}` — the scope string `useSessionSync` already
 * carries for cache ownership. Parsed rather than threaded through as two more
 * options so the hook's published signature does not change.
 */
export function parseKortixSessionScope(
	scope: string | undefined,
): { projectId: string; sessionId: string } | null {
	if (!scope) return null;
	const slash = scope.indexOf("/");
	if (slash <= 0 || slash === scope.length - 1) return null;
	const projectId = scope.slice(0, slash);
	const sessionId = scope.slice(slash + 1);
	if (!projectId || !sessionId || sessionId.includes("/")) return null;
	return { projectId, sessionId };
}
