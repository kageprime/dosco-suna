import { getRequestContext } from '../../lib/request-context';

/** Attribute config writes to authentication, never the edited session or request body. */
export function configCommitMessage(message: string): string {
  const context = getRequestContext();
  return `${message}\n\nKortix-Actor: ${context?.userId ?? 'none'}\nKortix-Session: ${context?.authSessionId || 'none'}`;
}
