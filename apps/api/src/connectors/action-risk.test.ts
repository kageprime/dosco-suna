import { describe, expect, test } from 'bun:test';
import { unannotatedActionRisk } from './action-risk';
import { normalizeComposio, normalizeMcp, normalizePipedream } from './normalize';
import { resolveEffectiveAction } from './policy';

const tool = (name: string, description: string) => ({ type: 'function' as const, function: { name, description } });

describe('Composio and Pipedream actions are gated on the reviewed classifier', () => {
  const gmail = normalizeComposio(
    [
      tool('GMAIL_LIST_LABELS', "Retrieves a list of all system and user-created labels for the user's account."),
      tool('GMAIL_FETCH_EMAILS', 'Fetches a list of email messages, with filtering and pagination.'),
      tool('GMAIL_SEND_EMAIL', 'Sends an email.'),
      tool('GMAIL_BATCH_MODIFY_MESSAGES', 'Modifies labels on many messages at once.'),
      tool('GMAIL_PROCESS_MAILBOX', 'Works on the mailbox.'),
    ],
    'gmail',
  );
  const x = normalizeComposio(
    [
      tool('TWITTER_GET_USERS_ME', 'Returns profile information for the authenticated user.'),
      tool('TWITTER_CREATE_POST', 'Creates a post.'),
    ],
    'twitter',
  );
  const risk = (actions: typeof gmail, path: string) => actions.find((a) => a.path === path)?.risk;

  test('a read is read, a write is write, an ambiguous action is write', () => {
    expect(risk(gmail, 'list_labels')).toBe('read');
    expect(risk(gmail, 'fetch_emails')).toBe('read');
    expect(risk(x, 'get_users_me')).toBe('read');
    expect(risk(gmail, 'send_email')).toBe('write');
    expect(risk(x, 'create_post')).toBe('write');
    expect(risk(gmail, 'batch_modify_messages')).toBe('write');
    expect(risk(gmail, 'process_mailbox')).toBe('write');
  });

  test('under the risk default, a read runs and a write waits for approval', () => {
    const action = (r: string | undefined) =>
      resolveEffectiveAction({
        fullPath: 'gmail.a',
        relPath: 'a',
        projectPolicies: [],
        connectorPolicies: [],
        risk: r as 'read' | 'write',
        defaultMode: 'risk',
      }).action;
    expect(action(risk(gmail, 'list_labels'))).toBe('always_run');
    expect(action(risk(gmail, 'send_email'))).toBe('require_approval');
  });

  test('a row stored before the rule is gated the same way', () => {
    expect(unannotatedActionRisk('composio', { path: 'list_labels', description: 'Lists labels.', risk: 'write' })).toBe('read');
    expect(unannotatedActionRisk('pipedream', { path: 'find_email', description: 'Finds an email.', risk: 'write' })).toBe('read');
    expect(unannotatedActionRisk('composio', { path: 'send_email', description: 'Sends an email.', risk: 'write' })).toBe('write');
  });

  test('the Pipedream Connect Proxy stays write', () => {
    const pd = normalizePipedream([{ key: 'gmail-list-labels', name: 'List Labels', description: 'Lists labels.' }], 'gmail');
    expect(pd.find((a) => a.path === 'list_labels')?.risk).toBe('read');
    expect(pd.find((a) => a.path === 'request')?.risk).toBe('write');
    expect(unannotatedActionRisk('pipedream', { path: 'list', risk: 'write', bindingKind: 'pipedream_proxy' })).toBe('write');
  });

  test('every other source keeps its own risk', () => {
    // MCP: no annotation is the protocol's "not read-only".
    expect(normalizeMcp([{ name: 'list_labels', description: 'Lists labels.' }])[0]?.risk).toBe('write');
    expect(unannotatedActionRisk('mcp', { path: 'list_labels', description: 'Lists labels.', risk: 'write' })).toBe('write');
    expect(unannotatedActionRisk('openapi', { path: 'list_labels', risk: 'write' })).toBe('write');
    expect(unannotatedActionRisk('composio', { path: 'delete_all', risk: 'destructive' })).toBe('destructive');
  });
});
