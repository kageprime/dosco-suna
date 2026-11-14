import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { testUiTranslator } from '../../test-utils/intl';
import {
  pendingSessionPromptForRecovery,
  pendingSessionPromptFromMetadata,
  provisioningFailurePresentation,
  inboxPromptToRequeue,
  recoveryPromptToSendOnRetry,
} from './provisioning-failure';
import type { SessionPrompt } from '@kortix/sdk';
import { clearStartStash, writeStartStash } from '@kortix/sdk/react';

describe('provisioningFailurePresentation', () => {
  test('shows a specific capacity title and the API-owned message', () => {
    expect(
      provisioningFailurePresentation(
        {
          failureCategory: 'provider-capacity',
          provisioningError: 'provider SDK text that must stay diagnostic-only',
          errorMessage: 'The sandbox provider is at capacity right now. Try again in a minute.',
        },
        undefined,
        testUiTranslator,
      ),
    ).toEqual({
      title: 'Sandbox capacity is full',
      message: 'The sandbox provider is at capacity right now. Try again in a minute.',
      retryable: true,
    });
  });

  test('shows Git failures as Git failures', () => {
    const result = provisioningFailurePresentation(
      {
        failureCategory: 'git-auth',
        errorMessage: 'Check the Git credentials.',
      },
      undefined,
      testUiTranslator,
    );

    expect(result.title).toBe('Git access failed');
    expect(result.message).toBe('Check the Git credentials.');
    expect(result.retryable).toBe(true);
  });

  test('uses provider-neutral fallback copy', () => {
    expect(provisioningFailurePresentation({}, 'SampleCo runtime', testUiTranslator)).toEqual({
      title: "Couldn't start SampleCo runtime",
      message: 'The sandbox provider could not start this session. Try again.',
      retryable: true,
    });
  });
});

describe('the retry path queues the durable row itself', () => {
  test('no stash builder survives — a legacy hand-off is POSTed, never re-stashed', () => {
    // `startStashFromPendingSessionPrompt` re-created the browser hand-off on
    // Retry, which kept the prompt losable for one more boot. The session page
    // now POSTs a legacy `pending_prompt.text` straight to the inbox
    // (`startSessionWithPrompt`) and strips the metadata copy; a session
    // created by the current API never enters this path at all — its first
    // prompt has been a durable row since the create transaction.
    const source = readFileSync(resolve(import.meta.dir, './provisioning-failure.ts'), 'utf8');
    expect(source).not.toContain('startStashFromPendingSessionPrompt');
  });
});

describe('pendingSessionPromptFromMetadata', () => {
  test('reads a durable prompt and its delivery options', () => {
    expect(
      pendingSessionPromptFromMetadata({
        pending_prompt: {
          text: 'Map this parcel.',
          agent: 'gis',
          model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
          variant: 'high',
          attachment_names: ['parcel.geojson'],
        },
      }),
    ).toEqual({
      text: 'Map this parcel.',
      agent: 'gis',
      model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
      variant: 'high',
      attachment_names: ['parcel.geojson'],
    });
  });

  test('reads a file-only recovery copy with empty text', () => {
    expect(
      pendingSessionPromptFromMetadata({
        pending_prompt: { text: '', attachment_names: ['parcel.geojson'] },
      }),
    ).toEqual({
      text: '',
      agent: null,
      model: null,
      variant: null,
      attachment_names: ['parcel.geojson'],
    });
  });

  test('rejects missing, cleared, content-free, and malformed recovery copies', () => {
    expect(pendingSessionPromptFromMetadata(undefined)).toBeNull();
    expect(pendingSessionPromptFromMetadata({ pending_prompt: null })).toBeNull();
    expect(pendingSessionPromptFromMetadata({ pending_prompt: [] })).toBeNull();
    expect(pendingSessionPromptFromMetadata({ pending_prompt: { text: '   ' } })).toBeNull();
    expect(
      pendingSessionPromptFromMetadata({
        pending_prompt: { text: 'Map this parcel.', model: { providerID: 'kortix' } },
      }),
    ).toBeNull();
    expect(
      pendingSessionPromptFromMetadata({
        pending_prompt: { text: 'Map this parcel.', attachment_names: [42] },
      }),
    ).toBeNull();
  });
});

describe('pendingSessionPromptForRecovery', () => {
  const SESSION_ID = '00000000-0000-4000-8000-000000000001';
  const AGENT_PROMPT = 'Summarize the open pull requests and post the summary.';

  test('shows the initial_prompt of a session an agent, trigger or channel created', () => {
    // Spawned, trigger, channel, MCP and marketplace sessions store their
    // first prompt as `metadata.initial_prompt`, never as `pending_prompt`.
    expect(
      pendingSessionPromptForRecovery(SESSION_ID, { source: 'agent', initial_prompt: AGENT_PROMPT }),
    ).toEqual({
      text: AGENT_PROMPT,
      agent: null,
      model: null,
      variant: null,
      attachment_names: [],
      redeliveredOnRestart: true,
    });
  });

  test('hides the initial_prompt once the runtime ran it', () => {
    // The restart re-delivers `initial_prompt` only while the session has no
    // runtime session id. After that it is history, not a saved prompt.
    expect(
      pendingSessionPromptForRecovery(SESSION_ID, { initial_prompt: AGENT_PROMPT }, 'ses_runtime'),
    ).toBeNull();
  });

  test('ignores a blank initial_prompt', () => {
    expect(pendingSessionPromptForRecovery(SESSION_ID, { initial_prompt: '  ' })).toBeNull();
    expect(pendingSessionPromptForRecovery(SESSION_ID, { initial_prompt: 42 })).toBeNull();
  });

  test('a legacy pending_prompt.text wins and stays client-delivered', () => {
    expect(
      pendingSessionPromptForRecovery(SESSION_ID, {
        pending_prompt: { text: 'legacy hand-off' },
        initial_prompt: AGENT_PROMPT,
      }),
    ).toMatchObject({ text: 'legacy hand-off', redeliveredOnRestart: false });
  });
});

describe('recoveryPromptToSendOnRetry', () => {
  test('sends nothing for an initial_prompt: the restart re-delivers it', () => {
    const prompt = pendingSessionPromptForRecovery('00000000-0000-4000-8000-000000000002', {
      initial_prompt: 'Run the nightly report.',
    });
    expect(prompt?.text).toBe('Run the nightly report.');
    expect(recoveryPromptToSendOnRetry(prompt)).toBeNull();
  });

  test('sends a legacy pending_prompt.text once, as before', () => {
    const prompt = pendingSessionPromptForRecovery('00000000-0000-4000-8000-000000000003', {
      pending_prompt: { text: 'legacy hand-off', agent: 'builder' },
    });
    expect(recoveryPromptToSendOnRetry(prompt)).toEqual({
      text: 'legacy hand-off',
      agent: 'builder',
      model: null,
      variant: null,
      attachment_names: [],
    });
  });

  test('sends nothing when there is no prompt', () => {
    expect(recoveryPromptToSendOnRetry(null)).toBeNull();
  });
});

describe('the durable inbox row is the saved prompt (F1)', () => {
  const SESSION_ID = '00000000-0000-4000-8000-000000000004';
  const FULL_TEXT = 'Draft the quarterly plan from the notes in /workspace/notes and list open risks.';
  const inboxRow = (overrides: Partial<SessionPrompt> = {}): SessionPrompt => ({
    prompt_id: '00000000-0000-4000-8000-0000000000aa',
    client_message_id: `pending:${SESSION_ID}`,
    message_id: 'msg_first',
    state: 'queued',
    reason: null,
    text: FULL_TEXT.slice(0, 20),
    full_text: FULL_TEXT,
    attempts: 0,
    last_error: null,
    created_at: '2026-11-12T00:00:00.000Z',
    available_at: '2026-11-12T00:00:00.000Z',
    ...overrides,
  });

  test('a provisioning failure shows the first prompt the create stored as an inbox row', () => {
    // The API strips `text` from `metadata.pending_prompt` (pending-prompt.ts):
    // only the picks remain, so metadata alone has no saved prompt.
    const prompt = pendingSessionPromptForRecovery(
      SESSION_ID,
      { pending_prompt: { agent: 'builder' } },
      null,
      [inboxRow()],
    );
    expect(prompt).toMatchObject({ text: FULL_TEXT, redeliveredOnRestart: true });
    // The server delivers the row: Retry must never POST a second copy.
    expect(recoveryPromptToSendOnRetry(prompt)).toBeNull();
  });

  test('a queued row is delivered by the restart: Retry re-queues nothing', () => {
    const rows = [inboxRow()];
    const prompt = pendingSessionPromptForRecovery(SESSION_ID, null, null, rows);
    expect(inboxPromptToRequeue(prompt?.inboxPrompt?.promptId ?? null, rows)).toBeNull();
  });

  test('a dead-lettered row (state failed) is re-queued once by Retry', () => {
    const rows = [inboxRow({ state: 'failed', last_error: 'could not be reached' })];
    const prompt = pendingSessionPromptForRecovery(SESSION_ID, null, null, rows);
    expect(prompt?.text).toBe(FULL_TEXT);
    expect(inboxPromptToRequeue(prompt?.inboxPrompt?.promptId ?? null, rows)).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(recoveryPromptToSendOnRetry(prompt)).toBeNull();
  });

  test('a row queued at the click and dead-lettered before the box is ready is re-queued', () => {
    const atClick = pendingSessionPromptForRecovery(SESSION_ID, null, null, [inboxRow()]);
    const armed = atClick?.inboxPrompt?.promptId ?? null;
    expect(inboxPromptToRequeue(armed, [inboxRow()])).toBeNull();
    expect(inboxPromptToRequeue(armed, [inboxRow({ state: 'failed' })])).toBe(
      '00000000-0000-4000-8000-0000000000aa',
    );
  });

  test('the inbox row wins over a start stash, so Retry cannot send the prompt twice', () => {
    const hadStorage = 'sessionStorage' in globalThis;
    const previousStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    const memory = new Map<string, string>();
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => void memory.set(key, value),
        removeItem: (key: string) => void memory.delete(key),
      },
    });
    writeStartStash(SESSION_ID, { prompt: FULL_TEXT, agent: null, model: null });
    try {
      // Precondition: the stash alone is a client-delivered prompt.
      expect(recoveryPromptToSendOnRetry(pendingSessionPromptForRecovery(SESSION_ID, null))).not.toBeNull();
      const prompt = pendingSessionPromptForRecovery(SESSION_ID, null, null, [inboxRow()]);
      expect(recoveryPromptToSendOnRetry(prompt)).toBeNull();
    } finally {
      clearStartStash(SESSION_ID);
      if (hadStorage) {
        Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: previousStorage });
      } else {
        delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
      }
    }
  });

  test('without an inbox row the old sources still answer', () => {
    expect(pendingSessionPromptForRecovery(SESSION_ID, null, null, [])).toBeNull();
  });
});
