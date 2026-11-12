import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ComposerCall } from '../voice/composer-call';
import { offersComposerCall, SendStopControl, type SendStopControlProps } from './send-stop-control';

const idle: SendStopControlProps = {
  isSending: false,
  isBusy: false,
  stopDisabled: false,
  escCount: 0,
  lockForQuestion: false,
  questionCanAct: false,
  hasText: true,
  canSubmit: true,
  submitDisabled: false,
  disabled: false,
  modelUnavailable: false,
  onSubmit: () => {},
};

const REASON = 'Retry or remove the failed attachment.';

describe('the Send control states why it refuses', () => {
  test('a failed attachment disables Send and names the reason in its tooltip', () => {
    const markup = renderToStaticMarkup(
      <SendStopControl {...idle} submitDisabled attachmentFailed />,
    );
    expect(markup).toContain(`title="${REASON}"`);
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).toMatch(/<button[^>]*\sdisabled=""/);
  });

  test('an attachment the selected model cannot read disables Send and names the reason', () => {
    const reason = 'DeepSeek V4 Flash can’t read images — remove them or pick another model';
    const markup = renderToStaticMarkup(
      <SendStopControl {...idle} submitDisabled attachmentUnsupported={reason} />,
    );
    expect(markup).toContain('title="DeepSeek V4 Flash can’t read images — remove them or pick another model"');
    expect(markup).toMatch(/<button[^>]*\sdisabled=""/);
  });

  test('without a failed attachment Send stays enabled and gives no refusal', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...idle} />);
    expect(markup).not.toContain(REASON);
    expect(markup).not.toMatch(/<button[^>]*\sdisabled=""/);
  });
});

describe('editing a queued message shows Submit, never Stop', () => {
  test('a busy session with a submit label renders the labeled Submit button, not Stop', () => {
    const markup = renderToStaticMarkup(
      <SendStopControl {...idle} isBusy onStop={() => {}} submitLabel="Submit" />,
    );
    expect(markup).toContain('>Submit</button>');
    expect(markup).not.toContain('aria-label="Stop');
    expect(markup).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  test('Submit is disabled while the edited draft is empty', () => {
    const markup = renderToStaticMarkup(
      <SendStopControl {...idle} isBusy canSubmit={false} hasText={false} submitLabel="Submit" />,
    );
    expect(markup).toContain('>Submit</button>');
    expect(markup).toMatch(/<button[^>]*\sdisabled=""/);
  });

  test('without a submit label a busy session still shows Stop', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...idle} isBusy onStop={() => {}} />);
    expect(markup).not.toContain('>Submit</button>');
  });
});

describe('a viewer who may not stop the running turn gets Send, never Stop', () => {
  test('busy with canStop false renders Send, so a message queues', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...idle} isBusy onStop={() => {}} canStop={false} />);
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).not.toContain('aria-label="Stop');
  });

  test('busy with canStop true (or unset) and nothing typed renders Stop only', () => {
    const empty = { ...idle, hasText: false, canSubmit: false };
    for (const markup of [
      renderToStaticMarkup(<SendStopControl {...empty} isBusy onStop={() => {}} canStop />),
      renderToStaticMarkup(<SendStopControl {...empty} isBusy onStop={() => {}} />),
    ]) {
      expect(markup).toContain('aria-label="Stop');
      expect(markup).not.toContain('aria-label="Send message"');
    }
  });
});

// KRTX-2556: with a follow-up typed during a turn, mouse users saw only Stop.
// One click ended the run and the follow-up stayed unsent. Enter sends it.
describe('a follow-up typed during a turn', () => {
  test('gets Send, with Stop still beside it', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...idle} isBusy onStop={() => {}} />);
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).toContain('aria-label="Stop');
    // Send is the last control, where the eye and the pointer already are.
    expect(markup.lastIndexOf('aria-label="Send message"')).toBeGreaterThan(markup.indexOf('aria-label="Stop'));
    expect(markup).not.toMatch(/aria-label="Send message"[^>]*\sdisabled=""/);
  });

  test('a follow-up that cannot be sent yet keeps Send disabled and Stop enabled', () => {
    const markup = renderToStaticMarkup(
      <SendStopControl {...idle} isBusy onStop={() => {}} submitDisabled attachmentFailed />,
    );
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Send message"|<button[^>]*aria-label="Send message"[^>]*disabled=""/);
    expect(markup).toMatch(/<button(?![^>]*disabled="")[^>]*aria-label="Stop/);
  });
});

// The voice call in Send's place (flag `voice_call`): an empty composer calls,
// a draft sends, and every other state of the control is unchanged.
describe('a host call on an empty composer', () => {
  const call: ComposerCall = { onCall: () => {}, inCall: false };
  const empty = { ...idle, hasText: false, canSubmit: false };
  const named = (markup: string, name: string) =>
    new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`).exec(markup)?.[0];

  test('takes the Send slot, enabled, and Send is gone', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...empty} call={call} />);
    expect(named(markup, 'Start a voice call')).not.toMatch(/\sdisabled=""/);
    expect(markup).not.toContain('aria-label="Send message"');
  });

  test('a draft turns it back into Send', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...idle} call={call} />);
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).not.toContain('aria-label="Start a voice call"');
  });

  test('a call already in progress keeps the button, disabled', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...empty} call={{ ...call, inCall: true }} />);
    expect(named(markup, 'Start a voice call')).toMatch(/\sdisabled=""/);
  });

  test('without a call the empty composer keeps its disabled Send', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...empty} />);
    expect(named(markup, 'Send message')).toMatch(/\sdisabled=""/);
    expect(markup).not.toContain('aria-label="Start a voice call"');
  });

  test('a running turn shows Stop, not the call', () => {
    const markup = renderToStaticMarkup(<SendStopControl {...empty} call={call} isBusy onStop={() => {}} />);
    expect(markup).toContain('aria-label="Stop');
    expect(markup).not.toContain('aria-label="Start a voice call"');
  });

  test('with no agent, Send says why and no call is offered', () => {
    const markup = renderToStaticMarkup(
      <SendStopControl {...empty} call={call} agentUnavailable submitDisabled />,
    );
    expect(named(markup, 'Send message')).toContain('No agents available to you');
    expect(markup).not.toContain('aria-label="Start a voice call"');
  });
});

describe('offersComposerCall', () => {
  const offer: Parameters<typeof offersComposerCall>[0] = {
    call: { onCall: () => {}, inCall: false },
    canSubmit: false,
    lockForQuestion: false,
    disabled: false,
    modelUnavailable: false,
  };

  test('an empty, ready composer with a call offers it', () => {
    expect(offersComposerCall(offer)).toBe(true);
  });

  const refusals: [string, Partial<Parameters<typeof offersComposerCall>[0]>][] = [
    ['no call', { call: undefined }],
    ['something to send', { canSubmit: true }],
    ['a question holds the composer', { lockForQuestion: true }],
    ['the composer is disabled', { disabled: true }],
    ['no agent to run it', { agentUnavailable: true }],
    ['no model to run it', { modelUnavailable: true }],
  ];
  for (const [why, change] of refusals) {
    test(`${why}: no call`, () => {
      expect(offersComposerCall({ ...offer, ...change })).toBe(false);
    });
  }
});
