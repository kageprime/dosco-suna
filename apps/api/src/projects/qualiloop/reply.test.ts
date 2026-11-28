import { describe, expect, test } from 'bun:test';
import type { LogMessage } from './spans';
import { turnReply } from './reply';

const message = (over: Partial<LogMessage>): LogMessage => ({
  schema: 'kortix.session/2', v: 1, message_id: 'm', thread_id: 't', seq: 1, role: 'assistant', kind: 'turn',
  status: 'complete', in_context: true, model: null, usage: null, finish: null, error: null,
  created_at: '2026-11-25T10:00:01.000Z', completed_at: '2026-11-25T10:00:03.000Z',
  producer: { harness: 'pi', version: '1' }, blocks: [],
  ...over,
} as LogMessage);

let n = 0;
const call = (name: string, input: unknown, output: string, over: Record<string, unknown> = {}) => ({
  id: `b${++n}`, type: 'tool_call', call_id: `c${n}`, name, kind: 'other', input, status: 'complete',
  result: { content: [{ type: 'text', text: output }], is_error: false }, ...over,
});
const text = (value: string) => ({ id: `b${++n}`, type: 'text', text: value });

describe('turnReply', () => {
  test('the agent text alone when no call asks the person to act', () => {
    const reply = turnReply([
      message({ role: 'user', blocks: [text('Hi') as never] }),
      message({ blocks: [call('bash', { command: 'kortix connectors ls' }, 'gmail  needs account') as never] }),
      message({ blocks: [text('Nothing is connected yet.') as never] }),
    ]);
    expect(reply).toBe('Nothing is connected yet.');
  });

  // QualiLoop reads text only: "click Connect on the card" pointed at nothing, and the
  // simulated person asked four turns in a row what to do (39 of 229 conversations on dev).
  test('a connector sign-in, by the tool or the shell, is the Connect card the web chat draws', () => {
    const connect = JSON.stringify({ ok: true, tool: 'kortix_connectors', action: 'connect', card: { status: 'needs_you', title: 'Sign in to gmail', links: [{ label: 'Sign in', href: 'https://auth.example.com/x' }] } });
    const reply = turnReply([
      message({ blocks: [
        call('kortix_connectors', { action: 'connect', slug: 'gmail' }, connect) as never,
        call('bash', { command: 'kortix connectors connect slack --owner workspace' }, 'Open https://auth.example.com/y') as never,
      ] }),
      message({ blocks: [text('Click Connect on the cards.') as never] }),
    ]);
    expect(reply).toBe([
      'Click Connect on the cards.',
      '[Card in the chat: Connect gmail. Only you will use this sign-in. Button: Connect]',
      '[Card in the chat: Connect slack. Everyone in the workspace will use this sign-in. Button: Connect]',
    ].join('\n\n'));
    expect(reply).not.toContain('https://');
  });

  test('a refused or failed sign-in draws no card', () => {
    const refused = JSON.stringify({ ok: false, tool: 'kortix_connectors', action: 'connect', card: { status: 'error', title: 'gmail is not added yet' }, error: { kind: 'not_found', message: 'No connector' } });
    const reply = turnReply([message({ blocks: [
      call('kortix_connectors', { action: 'connect', slug: 'gmail' }, refused) as never,
      call('bash', { command: 'kortix connectors connect gmail' }, 'not found', { result: { content: [{ type: 'text', text: 'not found' }], is_error: false, exit_code: 1 } }) as never,
      text('Gmail is not added yet.') as never,
    ] })]);
    expect(reply).toBe('Gmail is not added yet.');
  });

  test('another card that needs the person shows its title, subtitle and buttons; a done card does not', () => {
    const approve = JSON.stringify({ ok: true, tool: 'kortix_change_requests', action: 'get', card: { status: 'needs_you', title: 'Review #3', subtitle: 'Adds the researcher agent.', links: [{ label: 'Review', href: '/workspaces/p/review/3' }] } });
    const listed = JSON.stringify({ ok: true, tool: 'kortix_agents', action: 'list', card: { status: 'done', title: '2 agents' } });
    const reply = turnReply([message({ blocks: [
      call('kortix_change_requests', { action: 'get', id: '3' }, approve) as never,
      call('kortix_agents', { action: 'list' }, listed) as never,
      text('Review it when you can.') as never,
    ] })]);
    expect(reply).toBe('Review it when you can.\n\n[Card in the chat: Review #3. Adds the researcher agent. Button: Review]');
  });
});
