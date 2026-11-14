import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmailLinkStep } from './email-link-step';

describe('emailed link confirmation', () => {
  test('renders the delivered mechanism rather than a six-digit code entry', () => {
    const markup = renderToStaticMarkup(
      <EmailLinkStep
        sentEmail={null}
        errorMessage={null}
        info={null}
        resendIn={0}
        pending={false}
        pendingAction={null}
        passwordEnabled={true}
        onResend={() => {}}
        onChangeEmail={() => {}}
        onPassword={() => {}}
      />,
    );
    expect(markup).toContain('Enter the code sent to');
    expect(markup).toContain('Resend');
    expect(markup).toContain('Use a different email');
    expect(markup).toContain('Use a password');
    expect(markup).not.toContain('autocomplete="one-time-code"');
    expect(markup).not.toContain('inputMode="numeric"');
    expect(markup).not.toContain('six-digit');
  });
});

test('a failed resend remains visible beside the retry action', () => {
  const markup = renderToStaticMarkup(
    <EmailLinkStep
      sentEmail="synthetic@example.test"
      errorMessage="Email rate limit exceeded. Try again later."
      info={null}
      resendIn={0}
      pending={false}
      pendingAction={null}
      passwordEnabled={true}
      onResend={() => {}}
      onChangeEmail={() => {}}
      onPassword={() => {}}
    />,
  );
  expect(markup).toContain('role="alert"');
  expect(markup).toContain('Email rate limit exceeded. Try again later.');
  expect(markup).toContain('Resend');
});

test('the resend countdown is plain text after "Use a password", then a button', () => {
  const props = {
    sentEmail: 'synthetic@example.test',
    errorMessage: null,
    info: null,
    pending: false,
    pendingAction: null,
    passwordEnabled: true,
    onResend: () => {},
    onChangeEmail: () => {},
    onPassword: () => {},
  } as const;
  const counting = renderToStaticMarkup(<EmailLinkStep {...props} resendIn={53} />);
  expect(counting).not.toContain('Didn&#x27;t get the email?');
  expect(counting.indexOf('Resend in 53s')).toBeGreaterThan(counting.indexOf('Use a password'));
  expect(counting).not.toMatch(/<button[^>]*>Resend in 53s/);
  const ready = renderToStaticMarkup(<EmailLinkStep {...props} resendIn={0} />);
  expect(ready).toMatch(/<button[^>]*>Resend code<\/button>/);
});

const SIGN_IN_WORDING: Record<string, RegExp> = {
  en: /sign-in/i,
  de: /Anmeldelink/,
  es: /de acceso/,
  fr: /de connexion/,
  it: /di accesso/,
  ja: /ログイン/,
  pt: /de acesso/,
  sr: /за пријаву/,
  zh: /登录/,
};

/**
 * KRTX-2516: Continue emails a NEW address the signup confirmation ("Confirm
 * your email") and an existing one the sign-in link. The page does not know
 * which (no account enumeration), so the "Check your email" copy names neither:
 * it says a link was sent. "Sign-in link" mislabeled every new signup's email.
 *
 * KRTX-2195: "a link" still mislabeled the new signup's email — the mail says
 * "Confirm your email" while the page said "We sent a link", so a user waiting
 * for a link read the confirmation mail as the wrong message. The send action
 * does resolve the flow mode server-side; it now answers with it, and the step
 * names the confirmation email for a signup while keeping the generic link
 * copy when the mode is unknown (the old fail-open, KRTX-2516).
 *
 * KRTX-3504: the public API no longer says whether the address holds an
 * account, so an eligible send ('unknown') can mint EITHER email and the step
 * names both; a closed-signup send ('closed') mails a sign-in link only when
 * the account exists, and the copy claims only that conditional.
 */
describe('link step copy names the link, not its kind', () => {
  for (const [locale, wording] of Object.entries(SIGN_IN_WORDING)) {
    test(`${locale}: the description says a link was sent`, () => {
      const catalog = JSON.parse(
        readFileSync(
          fileURLToPath(new URL(`../../../../../translations/${locale}.json`, import.meta.url)),
          'utf8',
        ),
      );
      const description: string = catalog.auth.unified.link.description;
      expect(description).toContain('<address>{email}</address>');
      expect(description).not.toMatch(wording);
    });
  }
});

test('mode=signup: the copy names the confirmation email the mailbox actually receives', () => {
  const markup = renderToStaticMarkup(
    <EmailLinkStep
      mode="signup"
      sentEmail="synthetic@example.test"
      errorMessage={null}
      info={null}
      resendIn={0}
      pending={false}
      pendingAction={null}
      passwordEnabled={true}
      onResend={() => {}}
      onChangeEmail={() => {}}
      onPassword={() => {}}
    />,
  );
  expect(markup).toContain('Confirm the email we sent to');
  expect(markup).toContain('Resend code');
  expect(markup).not.toContain('Enter the code sent');
});

test('modes without their own send knowledge keep the generic link copy (fail-open, KRTX-2516)', () => {
  for (const mode of [undefined, 'signin'] as const) {
    const markup = renderToStaticMarkup(
      <EmailLinkStep
        mode={mode}
        sentEmail="synthetic@example.test"
        errorMessage={null}
        info={null}
        resendIn={0}
        pending={false}
        pendingAction={null}
        passwordEnabled={true}
        onResend={() => {}}
        onChangeEmail={() => {}}
        onPassword={() => {}}
      />,
    );
    expect(markup).toContain('Enter the code sent to');
    expect(markup).toContain('Resend code');
    expect(markup).not.toContain('Confirm the email');
  }
});

test('mode=unknown: the copy names both emails the mailbox may receive (KRTX-3504)', () => {
  const markup = renderToStaticMarkup(
    <EmailLinkStep
      mode="unknown"
      sentEmail="synthetic@example.test"
      errorMessage={null}
      info={null}
      resendIn={0}
      pending={false}
      pendingAction={null}
      passwordEnabled={true}
      onResend={() => {}}
      onChangeEmail={() => {}}
      onPassword={() => {}}
    />,
  );
  // Names no email kind: GoTrue may mint a sign-in or a confirmation email.
  expect(markup).toContain('Enter the code sent to');
  expect(markup).not.toMatch(/sign-in|confirmation/i);
});

test('mode=closed: the copy claims a sign-in link only when the account exists (KRTX-3504)', () => {
  const markup = renderToStaticMarkup(
    <EmailLinkStep
      mode="closed"
      sentEmail="synthetic@example.test"
      errorMessage={null}
      info={null}
      resendIn={0}
      pending={false}
      pendingAction={null}
      passwordEnabled={true}
      onResend={() => {}}
      onChangeEmail={() => {}}
      onPassword={() => {}}
    />,
  );
  expect(markup).toContain('If');
  expect(markup).toContain('has an account, a code is on its way');
  // Neither the delivery promise (an unknown address gets no mail) nor the
  // confirmation copy may render for a closed send.
  expect(markup).not.toContain('Enter the code sent to');
  expect(markup).not.toContain('Confirm the email');
});

test('every locale carries the confirmation copy with the address placeholder', () => {
  for (const locale of Object.keys(SIGN_IN_WORDING)) {
    const catalog = JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../../../translations/${locale}.json`, import.meta.url)),
        'utf8',
      ),
    );
    const link = catalog.auth.unified.link;
    expect(link.confirmDescription.trim().length, locale).toBeGreaterThan(0);
    expect(link.confirmDescription, locale).toContain('<address>{email}</address>');
    expect(link.confirmDescription, locale).not.toMatch(/\b(link|lien|enlace|リンク|链接|линк)/i);
    // The KRTX-3504 copies must render the address the mail names, in every
    // locale; the closed copy's conditional semantics are pinned by the en
    // render tests above — a regex over conditional words would over-fit
    // scripts that place it mid-sentence (ja).
    for (const key of ['unknownDescription', 'closedDescription'] as const) {
      expect(link[key].trim().length, locale).toBeGreaterThan(0);
      expect(link[key], locale).toContain('<address>{email}</address>');
      expect(link[key], locale).toMatch(/\{email\}/);
    }
    expect(link.unknownDescription, locale).not.toMatch(/^If\b/);
  }
});

for (const [mode, expected] of [
  ['signup', 'Confirm the email we sent to'],
  ['unknown', 'Enter the code sent to'],
  ['closed', 'has an account, a code is on its way'],
  ['signin', 'Enter the code sent to'],
] as const) {
  test(`${mode}: the code input shows at once, beside the link`, () => {
    const markup = renderToStaticMarkup(
      <EmailLinkStep
        mode={mode}
        sentEmail={null}
        errorMessage={null}
        info={null}
        resendIn={0}
        pending={false}
        pendingAction={null}
        passwordEnabled={false}
        onResend={() => {}}
        onChangeEmail={() => {}}
        onPassword={() => {}}
        onCodeChange={() => {}}
        onVerify={() => {}}
      />,
    );
    const document = new Window().document;
    document.body.innerHTML = markup;
    const codeInput = document.querySelector('input[autocomplete="one-time-code"]');
    expect(codeInput).not.toBeNull();
    expect(codeInput?.closest('details')).toBeNull();
    expect(markup).toContain(expected);
  });
}

test('a verifying code says so: a status line replaces the removed Continue button', () => {
  const props = {
    sentEmail: 'synthetic@example.test',
    errorMessage: null,
    info: null,
    resendIn: 0,
    pending: true,
    passwordEnabled: false,
    onResend: () => {},
    onChangeEmail: () => {},
    onPassword: () => {},
    code: '123456',
    onCodeChange: () => {},
    onVerify: () => {},
  };
  const verifying = renderToStaticMarkup(<EmailLinkStep {...props} pendingAction="continue" />);
  expect(verifying).toContain('role="status"');
  expect(verifying).toContain('One moment');
  const idle = renderToStaticMarkup(<EmailLinkStep {...props} pending={false} pendingAction={null} />);
  expect(idle).not.toContain('One moment');
});
