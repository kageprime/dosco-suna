import { describe, expect, test } from 'bun:test';
import { runWithContext, setContextField } from '../../lib/request-context';
import { configCommitMessage } from './config-commit-message';

describe('config commit attribution', () => {
  test('uses the authenticated session, not a route target or body identity', () => {
    runWithContext('PATCH', '/projects/example/agents/helper', () => {
      setContextField('userId', 'synthetic-actor');
      setContextField('authSessionId', 'synthetic-token-session');
      setContextField('sessionId', 'synthetic-route-target');
      const body = { actor: 'forged-actor', session: 'forged-session', prompt: 'new prompt' };
      expect(configCommitMessage(`chore: update prompt (${body.prompt})`)).toBe(
        'chore: update prompt (new prompt)\n\nKortix-Actor: synthetic-actor\nKortix-Session: synthetic-token-session',
      );
    });
  });

  test('a service account without a session has no invented session', () => {
    runWithContext('POST', '/projects/example/skills', () => {
      setContextField('userId', 'synthetic-service-account');
      setContextField('sessionId', 'synthetic-target');
      expect(configCommitMessage('feat: add skill')).toBe(
        'feat: add skill\n\nKortix-Actor: synthetic-service-account\nKortix-Session: none',
      );
    });
  });

  test('background calls invent no identity', () => {
    expect(configCommitMessage('chore: update config')).toBe('chore: update config\n\nKortix-Actor: none\nKortix-Session: none');
  });

  test('parallel requests keep their own identities', async () => {
    const messages = await Promise.all(['one', 'two'].map((id) => runWithContext('PATCH', '/config', async () => {
      setContextField('userId', `actor-${id}`);
      setContextField('authSessionId', `session-${id}`);
      await Promise.resolve();
      return configCommitMessage('chore: edit');
    })));
    expect(messages).toEqual(['one', 'two'].map((id) => `chore: edit\n\nKortix-Actor: actor-${id}\nKortix-Session: session-${id}`));
  });
});
