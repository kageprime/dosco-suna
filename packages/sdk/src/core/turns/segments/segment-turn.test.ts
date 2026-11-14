import type { Part, ToolPart } from '../../runtime/client';
import { describe, expect, test } from 'bun:test';
import { segmentTurn } from './segment-turn';

function tool(id: string, name: string, input?: Record<string, unknown>, output?: string): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'completed', ...(input ? { input } : {}), ...(output === undefined ? {} : { output }) },
  } as unknown as ToolPart;
}

/** A `show` that actually handed something over. `show` is the one tool whose
 *  input decides whether it renders at all — see `isEmptyShowPart`. */
function shown(id: string, name = 'show'): ToolPart {
  return tool(id, name, { type: 'image', path: '/workspace/logo.png' });
}

function text(id: string, body: string): Part {
  return { id, type: 'text', text: body } as unknown as Part;
}

function reasoning(id: string, body: string): Part {
  return { id, type: 'reasoning', text: body } as unknown as Part;
}

describe('segmentTurn', () => {
  test('folds interleaved tools into ONE burst', () => {
    const segments = segmentTurn([tool('1', 'read'), tool('2', 'web_search'), tool('3', 'read')]);

    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('burst');
    expect((segments[0] as { parts: Part[] }).parts).toHaveLength(3);
  });

  test('a text part closes a burst and opens a new one', () => {
    const segments = segmentTurn([
      tool('1', 'read'),
      text('2', 'Here is what I found.'),
      tool('3', 'bash'),
    ]);

    expect(segments.map((s) => s.kind)).toEqual(['burst', 'text', 'burst']);
  });

  test('reasoning folds into the burst rather than splitting it', () => {
    const segments = segmentTurn([
      tool('1', 'read'),
      reasoning('2', 'Checking the registration path'),
      tool('3', 'bash'),
    ]);

    expect(segments).toHaveLength(1);
    expect((segments[0] as { parts: Part[] }).parts).toHaveLength(3);
  });

  test('blank text does not split a burst', () => {
    const segments = segmentTurn([tool('1', 'bash'), text('2', '   '), tool('3', 'bash')]);

    expect(segments).toHaveLength(1);
    expect((segments[0] as { parts: Part[] }).parts).toHaveLength(2);
  });

  test('snapshot and patch parts are dropped without splitting', () => {
    const snapshot = { id: '2', type: 'snapshot' } as unknown as Part;
    const patch = { id: '4', type: 'patch' } as unknown as Part;
    const segments = segmentTurn([
      tool('1', 'bash'),
      snapshot,
      tool('3', 'bash'),
      patch,
      tool('5', 'bash'),
    ]);

    expect(segments).toHaveLength(1);
    expect((segments[0] as { parts: Part[] }).parts).toHaveLength(3);
  });

  test('step-start and step-finish parts are dropped without splitting', () => {
    const stepStart = { id: '2', type: 'step-start' } as unknown as Part;
    const stepFinish = { id: '4', type: 'step-finish' } as unknown as Part;
    const segments = segmentTurn([
      tool('1', 'bash'),
      stepStart,
      tool('3', 'bash'),
      stepFinish,
      tool('5', 'bash'),
    ]);

    expect(segments).toHaveLength(1);
    expect((segments[0] as { parts: Part[] }).parts).toHaveLength(3);
  });

  test('show breaks out as standalone and splits the burst', () => {
    const segments = segmentTurn([tool('1', 'read'), shown('2'), tool('3', 'read')]);

    expect(segments.map((s) => s.kind)).toEqual(['burst', 'standalone', 'burst']);
  });

  // A `show` whose arguments carry no path, url, content or items renders a
  // header over an empty box. It is dropped here rather than in the renderer:
  // a `null` child still leaves the step's row and the chain's rail behind, so
  // the reader gets a blank gap where a deliverable should be.
  test('an empty show is dropped and does NOT split the burst', () => {
    const segments = segmentTurn([tool('1', 'read'), tool('2', 'show'), tool('3', 'read')]);

    expect(segments.map((s) => s.kind)).toEqual(['burst']);
    expect((segments[0] as { parts: Part[] }).parts).toHaveLength(2);
  });

  test('an empty show_user is dropped too, whatever the wire spelling', () => {
    expect(segmentTurn([tool('1', 'oc-show-user')])).toEqual([]);
    expect(segmentTurn([tool('1', 'show_user')])).toEqual([]);
  });

  test('a still-running show stays — its input has not arrived yet', () => {
    const running = {
      id: '1',
      type: 'tool',
      tool: 'show',
      callID: 'call_1',
      state: { status: 'running' },
    } as unknown as ToolPart;

    expect(segmentTurn([running]).map((s) => s.kind)).toEqual(['standalone']);
  });

  test('a show whose STATE errored stays — a failure is real content', () => {
    const failed = {
      id: '1',
      type: 'tool',
      tool: 'show',
      callID: 'call_1',
      state: { status: 'error', error: 'boom' },
    } as unknown as ToolPart;

    expect(segmentTurn([failed]).map((s) => s.kind)).toEqual(['standalone']);
  });

  test('a show that handed over only a title is empty', () => {
    expect(segmentTurn([tool('1', 'show', { type: 'text', title: 'Done' })])).toEqual([]);
  });

  test('a carousel show keeps its row when one item carries a file', () => {
    const segments = segmentTurn([
      tool('1', 'show', { items: '[{"type":"file","path":"/workspace/q3.pdf"}]' }),
    ]);

    expect(segments.map((s) => s.kind)).toEqual(['standalone']);
  });

  test('agent_spawn breaks out as standalone', () => {
    const segments = segmentTurn([tool('1', 'read'), tool('2', 'agent_spawn')]);

    expect(segments.map((s) => s.kind)).toEqual(['burst', 'standalone']);
  });

  test('oc- prefix and hyphens normalize before the standalone check', () => {
    const segments = segmentTurn([shown('1', 'oc-show-user')]);

    expect(segments.map((s) => s.kind)).toEqual(['standalone']);
  });

  test('a part with a pending permission breaks out as standalone', () => {
    const segments = segmentTurn([tool('1', 'read'), tool('2', 'bash')], {
      standaloneCallIds: new Set(['call_2']),
    });

    expect(segments.map((s) => s.kind)).toEqual(['burst', 'standalone']);
  });

  test('a connector sign-in the agent started stands alone, so its Connect card is not folded into a burst', () => {
    const segments = segmentTurn([
      tool('1', 'read'),
      tool('2', 'bash', { command: 'kortix connectors connect gmail --owner workspace' }),
      tool('3', 'bash', { command: 'kortix connectors ls' }),
    ]);

    expect(segments.map((segment) => segment.kind)).toEqual(['burst', 'standalone', 'burst']);
  });

  test('a sign-in call that errored stays in its burst: no sign-in waits on the person', () => {
    const command = 'kortix connectors connect gmail';
    const failed = {
      ...tool('2', 'bash'),
      state: { status: 'error', input: { command }, error: 'exit 1' },
    } as unknown as ToolPart;

    expect(segmentTurn([tool('1', 'read'), failed]).map((segment) => segment.kind)).toEqual(['burst']);
  });

  test('a shell sign-in that exited non-zero stays in its burst: the command failed and started nothing', () => {
    const command = 'kortix connectors connect notion --owner workspace';
    const exited = {
      ...tool('2', 'bash'),
      state: { status: 'completed', input: { command }, output: 'connector not found', metadata: { exit: 1 } },
    } as unknown as ToolPart;

    expect(segmentTurn([tool('1', 'read'), exited]).map((segment) => segment.kind)).toEqual(['burst']);
  });

  test('returns an empty array for no parts', () => {
    expect(segmentTurn([])).toEqual([]);
  });
});

// A codemode script's own calls carry `<script callID>/<n>` (pi's nested id). Its row
// already lists each of them, so they draw once, inside it (KRTX-4877).
describe('a script\'s own calls', () => {
  const script = tool('s', 'codemode', { code: 'await tools.kortix_usage({ action: "summary" })' });
  const child = (n: number, name: string, input?: Record<string, unknown>, output?: string): ToolPart => ({ ...tool(`s${n}`, name, input, output), callID: `call_s/${n}` });
  const ids = (segments: ReturnType<typeof segmentTurn>) =>
    segments.map((s) => (s.kind === 'burst' ? s.parts.map((p) => p.id) : [s.part.id]));

  test('a platform or messaging call the script made draws only in the script row; its text and a direct call stay', () => {
    const segments = segmentTurn([
      script,
      child(1, 'kortix_schedules'),
      child(2, 'kortix_usage'),
      child(3, 'send_message'),
      text('t', 'Paused two schedules.'),
      tool('direct', 'kortix_usage'),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(['burst', 'text', 'standalone']);
    expect(ids(segments)).toEqual([['s'], ['t'], ['direct']]);
  });

  test('a deliverable, a sub-agent and a call waiting on a permission keep their own card', () => {
    const segments = segmentTurn(
      [script, child(1, 'image_gen'), child(2, 'show', { type: 'image', path: '/workspace/a.png' }), child(3, 'agent'), child(4, 'kortix_sessions'), child(5, 'kortix_usage')],
      { standaloneCallIds: new Set(['call_s/4']) },
    );
    expect(ids(segments)).toEqual([['s'], ['s1'], ['s2'], ['s3'], ['s4']]);
  });

  test('a connector sign-in the script started keeps its own row: its Connect card draws there', () => {
    const connect = child(1, 'kortix_connectors', { action: 'connect', slug: 'linear' });
    const refused = child(2, 'kortix_connectors', { action: 'connect', slug: 'nope' }, JSON.stringify({ ok: false, tool: 'kortix_connectors', action: 'connect', card: { title: 'Could not start the sign-in for nope', status: 'error' }, error: { kind: 'not_found', message: 'Connector not found' } }));
    const segments = segmentTurn([script, connect, refused]);
    expect(segments.map((s) => s.kind)).toEqual(['burst', 'standalone']);
    expect(ids(segments)).toEqual([['s'], ['s1']]);
  });

  test('a call whose script is not in the turn is kept, and a slash alone is no script child', () => {
    const orphan = { ...tool('o', 'kortix_usage'), callID: 'call_gone/1' };
    const underBash = { ...tool('b1', 'kortix_usage'), callID: 'call_b/1' };
    expect(ids(segmentTurn([orphan, tool('b', 'bash'), underBash]))).toEqual([['o'], ['b'], ['b1']]);
  });
});
