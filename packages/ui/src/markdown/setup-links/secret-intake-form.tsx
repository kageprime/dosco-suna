'use client';

import { Button } from '../../primitives/button';
import { Field, FieldGroup, FieldLabel } from '../../primitives/field';
import { Input } from '../../primitives/input';
import { RadioGroup, RadioGroupItem } from '../../primitives/radio-group';
import Loading from '../../primitives/loading';
import type { OutcomeTone } from '../../internal/outcomes/outcome-types';
import { outcomeTint } from '../../internal/outcomes/outcome-vocabulary';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import {
  getSecretSetupLink,
  submitBrowserLoginSetupLink,
  submitSecretSetupLink,
  type SecretSetupLinkInfo,
  type SecretSetupLinkLogin,
} from '@kortix/sdk';
import {
  ArrowUpRightIcon,
  CheckIcon,
  ClockCountdownIcon,
  LinkBreakIcon,
  WarningCircleIcon,
  type Icon,
} from '@phosphor-icons/react';
import { Fragment, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  classifySetupLinkError,
  describeLinkExpiry,
  describeWithheldSecrets,
  splitTextLinks,
} from './util';
import { setupLinkApiBase } from './api-base';

type Phase = 'loading' | 'error' | 'expired' | 'invalid' | 'ready' | 'submitting' | 'done';

/** Every phase that is not the form: tinted tile, title, one muted line. */
function StatusNotice({
  icon: Glyph,
  tone,
  title,
  description,
}: {
  icon: Icon;
  tone: OutcomeTone;
  title: string;
  description?: string;
}): ReactElement {
  const tint = outcomeTint(tone);
  return (
    <div role="status" className="flex flex-col items-center gap-3 py-8 text-center">
      <span
        className={cn(
          'flex size-9 items-center justify-center rounded-sm ring-1',
          tint.ring,
          tint.bg,
        )}
      >
        <Glyph weight="fill" className={cn('size-5', tint.fg)} />
      </span>
      <div className="max-w-xs space-y-1">
        <p className="text-foreground text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-muted-foreground text-xs text-pretty">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Agent-written hint text with its URLs as real links: brand blue, underlined,
 * an up-right arrow for "opens elsewhere". A long URL truncates; `title` keeps
 * the full address.
 */
function LinkedText({ text }: { text: string }): ReactElement {
  return (
    <>
      {splitTextLinks(text).map((part, index) =>
        part.type === 'text' ? (
          <Fragment key={index}>{part.value}</Fragment>
        ) : (
          <a
            key={index}
            href={part.href}
            title={part.href}
            target="_blank"
            rel="noopener noreferrer"
            className="group text-kortix-base focus-visible:ring-ring inline-flex max-w-full items-baseline gap-0.5 rounded-sm font-medium outline-none focus-visible:ring-2"
          >
            <span className="decoration-kortix-base/40 group-hover:decoration-kortix-base min-w-0 truncate underline underline-offset-2">
              {part.label}
            </span>
            <ArrowUpRightIcon className="size-3 shrink-0 self-center" />
          </a>
        ),
      )}
    </>
  );
}

/**
 * Renders the fields an agent-minted secret link asks for, and submits the
 * values the human types. Shared by the public /secret-intake/[token] page and
 * the in-chat modal. The value is write-only — it's never read back here.
 */
export function SecretIntakeForm({
  token,
  onDone,
  compact,
  onLinkInfo,
}: {
  token: string;
  onDone?: () => void;
  /** Called once with what the link asks for, so a host can title its dialog. */
  onLinkInfo?: (info: SecretSetupLinkInfo) => void;
  /**
   * The host already states the encryption promise (the in-chat modal header),
   * so the footnote keeps only the expiry.
   */
  compact?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const base = setupLinkApiBase();
  const onLinkInfoRef = useRef(onLinkInfo);
  onLinkInfoRef.current = onLinkInfo;
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<SecretSetupLinkInfo | null>(null);
  const [expiresIn, setExpiresIn] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  // A `browser` link asks for website logins: a username and a password each.
  const [logins, setLogins] = useState<Record<string, SecretSetupLinkLogin>>({});
  // Who can use the values: everyone (the default) or only the person who asked.
  // A website login acts as one person, so it starts as theirs alone.
  const [onlyRequester, setOnlyRequester] = useState(false);
  const tSharing = useTranslations('accessSharing');
  const [error, setError] = useState<string | null>(null);
  const [withheldNotice, setWithheldNotice] = useState<ReturnType<
    typeof describeWithheldSecrets
  > | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await getSecretSetupLink(token, { backendUrl: base });
        if (cancelled) return;
        setInfo(body);
        onLinkInfoRef.current?.(body);
        setOnlyRequester(body.scope === 'browser' && Boolean(body.requester));
        setExpiresIn(describeLinkExpiry(body.expires_at, Date.now()));
        setPhase('ready');
      } catch (cause) {
        if (cancelled) return;
        const kind = classifySetupLinkError(cause);
        if (kind === 'expired') {
          setPhase('expired');
        } else if (kind === 'invalid') {
          setPhase('invalid');
        } else {
          setError(
            cause instanceof Error
              ? cause.message
              : tI18nHardcoded.raw('i18nComplete.texta8234500531a'),
          );
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, token, tI18nHardcoded]);

  /** A `browser` link's logins with both parts filled; the password is kept verbatim. */
  function filledLogins(fields: SecretSetupLinkInfo['fields']): Record<string, SecretSetupLinkLogin> {
    const filled: Record<string, SecretSetupLinkLogin> = {};
    for (const f of fields) {
      const username = (logins[f.name]?.username ?? '').trim();
      const password = logins[f.name]?.password ?? '';
      if (username && password) filled[f.name] = { username, password };
    }
    return filled;
  }

  async function submit() {
    if (!info) return;
    const isLoginLink = info.scope === 'browser';
    const filled: Record<string, string> = {};
    for (const f of info.fields) {
      const v = (values[f.name] ?? '').trim();
      if (v.length > 0) filled[f.name] = v;
    }
    const filledLoginValues = isLoginLink ? filledLogins(info.fields) : {};
    if (Object.keys(isLoginLink ? filledLoginValues : filled).length === 0) {
      setError(
        isLoginLink
          ? tI18nHardcoded.raw('secretIntakeLogin.missing')
          : 'Enter a value before saving.',
      );
      return;
    }
    setPhase('submitting');
    setError(null);
    try {
      const audience = onlyRequester ? { only_requester: true } : undefined;
      const result = isLoginLink
        ? await submitBrowserLoginSetupLink(token, filledLoginValues, { backendUrl: base }, audience)
        : await submitSecretSetupLink(token, filled, { backendUrl: base }, audience);
      setWithheldNotice(describeWithheldSecrets(result));
      setPhase('done');
      onDone?.();
    } catch (cause) {
      if (classifySetupLinkError(cause) === 'expired') {
        setPhase('expired');
        return;
      }
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not save. Check your connection and try again.',
      );
      setPhase('ready');
    }
  }

  switch (phase) {
    case 'loading':
      return (
        <div
          role="status"
          className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm"
        >
          <Loading className="size-4 shrink-0" />
          {tI18nHardcoded.raw('autoComponentsSetupLinksSecretIntakeFormJsxTextLoading93bbc067')}
        </div>
      );
    case 'expired':
      return (
        <StatusNotice
          icon={ClockCountdownIcon}
          tone="warning"
          title={tI18nHardcoded.raw('i18nComplete.text7cb87dcb8d50')}
          description={tI18nHardcoded.raw('i18nComplete.texte7119681d233')}
        />
      );
    case 'invalid':
      return (
        <StatusNotice
          icon={LinkBreakIcon}
          tone="destructive"
          title={tI18nHardcoded.raw('i18nComplete.text72c9ce898bf3')}
          description={tI18nHardcoded.raw('i18nComplete.text8d669b2101c9')}
        />
      );
    case 'error':
      return (
        <StatusNotice
          icon={WarningCircleIcon}
          tone="destructive"
          title={error || tI18nHardcoded.raw('i18nComplete.texta8234500531a')}
        />
      );
    case 'done':
      if (withheldNotice) {
        const { agent, byGrant, byAllowlist } = withheldNotice;
        const description = [
          byGrant.length > 0
            ? tI18nHardcoded('secretIntakeWithheld.grant', {
                names: byGrant.join(', '),
                count: byGrant.length,
                agent,
              })
            : null,
          byAllowlist.length > 0
            ? tI18nHardcoded('secretIntakeWithheld.allowlist', {
                names: byAllowlist.join(', '),
                count: byAllowlist.length,
              })
            : null,
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <StatusNotice
            icon={WarningCircleIcon}
            tone="warning"
            title={tI18nHardcoded('secretIntakeWithheld.title', { agent })}
            description={description}
          />
        );
      }
      if (info?.scope === 'browser') {
        return (
          <StatusNotice
            icon={CheckIcon}
            tone="success"
            title={tI18nHardcoded.raw('secretIntakeLogin.savedTitle')}
            description={tI18nHardcoded.raw('secretIntakeLogin.savedDescription')}
          />
        );
      }
      return (
        <StatusNotice
          icon={CheckIcon}
          tone="success"
          title={tI18nHardcoded.raw(
            'autoComponentsSetupLinksSecretIntakeFormJsxTextSavedSecurelyd63e94b1',
          )}
          description={tI18nHardcoded.raw(
            'autoComponentsSetupLinksSecretIntakeFormJsxTextYouCand69604da',
          )}
        />
      );
  }

  const submitting = phase === 'submitting';
  const fields = info?.fields ?? [];
  const isLogin = info?.scope === 'browser';
  const loginSites = [...new Set(fields.flatMap((f) => f.sites ?? []))];
  const setLogin = (name: string, patch: Partial<SecretSetupLinkLogin>) =>
    setLogins((current) => {
      const previous: SecretSetupLinkLogin = current[name] ?? { username: '', password: '' };
      return { ...current, [name]: { ...previous, ...patch } };
    });
  const footnote = [
    compact
      ? null
      : tI18nHardcoded.raw(
          'autoComponentsSetupLinksSecretIntakeFormJsxTextEncryptedAtRestc2e34213',
        ),
    expiresIn ? tI18nHardcoded('i18nComplete.textefb48f76e65a', { value0: expiresIn }) : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-xs text-pretty">
        {isLogin
          ? tI18nHardcoded('secretIntakeLogin.delivery', { sites: loginSites.join(', ') })
          : info?.scope === 'runtime'
          ? tI18nHardcoded.raw(
              'autoComponentsSetupLinksSecretIntakeFormJsxTextDeliveryRuntime1760e931',
            )
          : info?.scope === 'connector'
            ? tI18nHardcoded.raw(
                'autoComponentsSetupLinksSecretIntakeFormJsxTextDeliveryConnectorb21e2055',
              )
            : tI18nHardcoded.raw(
                'autoComponentsSetupLinksSecretIntakeFormJsxTextDeliveryScopec3e2a686',
              )}
      </p>
      <FieldGroup className="gap-5">
        {isLogin &&
          fields.map((f) => (
            <Field key={f.name} className="space-y-2">
              <div className="space-y-1">
                <p className="text-foreground text-sm font-medium">
                  {f.label || <code className="font-mono">{f.name}</code>}
                </p>
                {f.description ? (
                  <p className="text-muted-foreground text-xs text-pretty">
                    <LinkedText text={f.description} />
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor={`login-${f.name}-username`} className="text-muted-foreground">
                  {tI18nHardcoded.raw('secretIntakeLogin.username')}
                </FieldLabel>
                <Input
                  id={`login-${f.name}-username`}
                  name={`${f.name}-username`}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  // 16px below `sm` so iOS Safari does not zoom the page on focus.
                  className="max-sm:text-base"
                  value={logins[f.name]?.username ?? ''}
                  disabled={submitting}
                  onChange={(e) => setLogin(f.name, { username: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <FieldLabel htmlFor={`login-${f.name}-password`} className="text-muted-foreground">
                  {tI18nHardcoded.raw('secretIntakeLogin.password')}
                </FieldLabel>
                <Input
                  id={`login-${f.name}-password`}
                  name={`${f.name}-password`}
                  type="password"
                  // Not the Kortix account: keep the browser from filling it in.
                  autoComplete="new-password"
                  spellCheck={false}
                  className="font-mono max-sm:text-base"
                  placeholder="••••••••••••"
                  value={logins[f.name]?.password ?? ''}
                  disabled={submitting}
                  onChange={(e) => setLogin(f.name, { password: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && fields.length === 1) void submit();
                  }}
                />
              </div>
            </Field>
          ))}
        {!isLogin && fields.map((f) => (
          <Field key={f.name} className="space-y-2">
            <div className="space-y-1">
              <FieldLabel htmlFor={`secret-${f.name}`} className="text-foreground">
                {f.label || <code className="font-mono">{f.name}</code>}
              </FieldLabel>
              {f.description ? (
                <p className="text-muted-foreground text-xs text-pretty">
                  <LinkedText text={f.description} />
                </p>
              ) : null}
            </div>
            <Input
              id={`secret-${f.name}`}
              name={f.name}
              type="password"
              autoComplete="off"
              spellCheck={false}
              // 16px below `sm` so iOS Safari does not zoom the page on focus.
              className="font-mono max-sm:text-base"
              placeholder="••••••••••••"
              value={values[f.name] ?? ''}
              disabled={submitting}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && fields.length === 1) void submit();
              }}
            />
          </Field>
        ))}
      </FieldGroup>

      {info?.requester ? (
        <div className="space-y-2">
          <FieldLabel>{tSharing('whoCanUse')}</FieldLabel>
          <RadioGroup
            value={onlyRequester ? 'requester' : 'project'}
            onValueChange={(next) => setOnlyRequester(next === 'requester')}
            className="space-y-2"
          >
            <RadioGroupItem
              value="project"
              id="secret-intake-everyone"
              label={tSharing('everyone', { project: info.project_name })}
              description={tSharing('everyoneMeta')}
              size="lg"
              variant="outline"
              disabled={submitting}
            />
            <RadioGroupItem
              value="requester"
              id="secret-intake-requester"
              label={
                info.requester.label
                  ? tSharing('onlyRequester', { name: info.requester.label })
                  : tSharing('onlyRequesterUnnamed')
              }
              description={tSharing('onlyRequesterDescription')}
              size="lg"
              variant="outline"
              disabled={submitting}
            />
          </RadioGroup>
        </div>
      ) : null}

      <div className="space-y-3">
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
        <Button type="button" className="w-full" onClick={submit} disabled={submitting}>
          {submitting ? <Loading className="size-4 shrink-0" /> : null}
          {submitting
            ? tI18nHardcoded.raw('i18nComplete.text23e39291d613')
            : tI18nHardcoded.raw('i18nComplete.textad3d9699142e')}
        </Button>
        {footnote ? (
          <p className="text-muted-foreground text-center text-xs text-pretty">{footnote}</p>
        ) : null}
      </div>
    </div>
  );
}
