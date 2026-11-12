'use client';

import { ChatGptDeviceChallenge } from './chatgpt-device-challenge';
import { AntigravityCredentialsStep } from './antigravity-credentials-step';
import { Button } from '../../../primitives/button';
import { Alert as BannerAlert, AlertDescription as BannerAlertDescription, AlertMedia as BannerAlertMedia } from '../../../primitives/alert';
import Loading from '../../../primitives/loading';
import { errorToast, successToast } from '../../../primitives/toast';
import { ProviderLogo } from '../../../internal/lib/provider-branding';
import {
  completeClaudeSubscriptionLogin,
  createAccountSecretResource,
  deleteAccountSecretResource,
  deleteProjectProviderOAuth,
  deleteProjectSecret,
  getClaudeSubscription,
  getProjectDetail,
  listAccountSecretResources,
  listProjectProviderOAuth,
  listProjectSecrets,
  pollProjectProviderOAuth,
  startClaudeSubscriptionLogin,
  startProjectProviderOAuth,
  upsertProjectSecret,
  completeWorkspaceProviderOAuth,
} from '@kortix/sdk';
import { parseAntigravityAuth } from './antigravity-auth';
import { contract, qk, refreshProjectProviderState } from '@kortix/sdk/react';
import {
  CheckCircleIcon as CheckCircle2,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '../../../i18n';
import { useUiViewer } from '../../../providers/ui-provider';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  forgetSubscriptionCredentials,
  subscriptionIsConnected,
  subscriptionPrimaryAction,
} from './subscription-control';
import type { ChatGptChallenge, ChatGptPhase } from './types';
import { sleep } from './utils';
import { createRunGeneration, runDeviceGrant } from './device-grant';

/**
 * A subscription sign-in card. `chatgpt` is the ChatGPT Plus/Pro login (Codex
 * device grant); `opencode-go` is an OpenCode Console account login for
 * OpenCode Go; `claude` is the member's own Claude Pro or Max login for Claude
 * models run through Claude Code (`claude setup-token` on the server: the
 * member approves on claude.com and pastes the code back, `submitCode`).
 * Same flow, same card; only the provider, the copy and that last step differ.
 */
export type SubscriptionKind = 'chatgpt' | 'opencode-go' | 'claude' | 'antigravity';

/** OAuth route id, the provider the models belong to, and the logo. */
const SUBSCRIPTIONS: Record<SubscriptionKind, { oauth: string; providerId: string; logo: string; logoName: string }> = {
  chatgpt: { oauth: 'openai', providerId: 'codex', logo: 'openai', logoName: 'OpenAI' },
  'opencode-go': { oauth: 'opencode-go', providerId: 'opencode-go', logo: 'opencode-go', logoName: 'OpenCode Go' },
  claude: { oauth: 'claude', providerId: 'claude-agent', logo: 'anthropic', logoName: 'Anthropic' },
  antigravity: { oauth: 'google', providerId: 'antigravity', logo: 'google', logoName: 'Google' },
};

/** Whether the caller can use a Claude account in the project (`GET /projects/:id/claude-subscription`). */
export const claudeSubscriptionKey = (projectId: string) => ['claude-subscription', projectId] as const;

const providerLoginsKey = (projectId: string) => ['project-provider-oauth', projectId] as const;

/**
 * The sign-in state machine behind every subscription surface: the card below
 * and the provider sheet (`packages/ui/src/customize/providers/provider-sheet.tsx`). One copy,
 * so a device-grant fix lands in both.
 */
export function useSubscriptionSignIn({
  projectId,
  onConnected,
  kind = 'chatgpt',
}: {
  projectId: string;
  onConnected: (providerId: string) => void;
  kind?: SubscriptionKind;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tPooled = useTranslations('pooledSecrets');
  const queryClient = useQueryClient();
  const viewer = useUiViewer();
  const subscription = SUBSCRIPTIONS[kind];
  const chatgpt = kind === 'chatgpt';
  const claude = kind === 'claude';
  const antigravity = kind === 'antigravity';
  const tClaude = useTranslations('claudeSubscription');
  const tAntigravity = useTranslations('antigravitySubscription');
  const copy = claude ? {
    title: tClaude('title'),
    description: tClaude('description'),
    connectedBanner: tClaude('connectedTitle'),
    connectedToast: tClaude('connected'),
    disconnectedToast: tClaude('disconnected'),
    connect: tClaude('connectClaude'),
    reconnect: tClaude('reconnectClaude'),
    disconnect: tClaude('disconnect'),
    connecting: tClaude('starting'),
    deviceDescription: undefined,
    failed: tClaude('startError'),
  } : antigravity ? {
    title: tAntigravity('title') || 'Google Antigravity',
    description: tAntigravity('description') || 'Sign in with your Google Antigravity account to access Gemini and frontier models on your Google AI Pro / Ultra subscription.',
    connectedBanner: tAntigravity('connectedTitle') || 'Google Antigravity subscription connected',
    connectedToast: tAntigravity('connected') || 'Google Antigravity subscription connected',
    disconnectedToast: tAntigravity('disconnected') || 'Google Antigravity disconnected',
    connect: tAntigravity('connectAntigravity') || 'Sign in with Google Antigravity',
    reconnect: tAntigravity('reconnectAntigravity') || 'Reconnect Google Antigravity',
    disconnect: tAntigravity('disconnect') || 'Disconnect',
    connecting: tAntigravity('starting') || 'Starting sign-in...',
    deviceDescription: tAntigravity('deviceDescription') || 'Follow instructions on google.com/device to connect your Antigravity subscription.',
    failed: tAntigravity('startError') || 'Failed to connect Google Antigravity',
  } : chatgpt ? {
    title: tHardcodedUi.raw('autoComponentsProjectsProjectProviderModalJsxTextChatGPTPlusPro0deb5530'),
    description: tHardcodedUi.raw('autoComponentsProjectsProjectProviderModalJsxTextSignInWitha0c5128c'),
    connectedBanner: tHardcodedUi.raw('autoComponentsProjectsProjectProviderModalJsxTextChatGPTSubscriptionConnectedcf12bc87'),
    connectedToast: tHardcodedUi.raw('i18nComplete.text3f86a31c64fc'),
    disconnectedToast: tHardcodedUi.raw('i18nComplete.text555cd401b3c3'),
    connect: tHardcodedUi.raw('i18nComplete.textaa023456aca4'),
    reconnect: tHardcodedUi.raw('i18nComplete.textd9c95c52010d'),
    disconnect: tHardcodedUi.raw('i18nComplete.textc4e46df5702b'),
    connecting: tHardcodedUi.raw('i18nComplete.textf29674479db4'),
    deviceDescription: undefined,
    failed: 'Failed to connect ChatGPT subscription',
  } : {
    title: tPooled('opencodeGoTitle'),
    description: tPooled('opencodeGoDescription'),
    connectedBanner: tPooled('opencodeGoConnectedBanner'),
    connectedToast: tPooled('opencodeConnected'),
    disconnectedToast: tPooled('opencodeGoDisconnected'),
    connect: tPooled('opencodeGoConnect'),
    reconnect: tPooled('opencodeGoReconnect'),
    disconnect: tPooled('opencodeGoDisconnect'),
    connecting: tPooled('opencodeStarting'),
    deviceDescription: tPooled('opencodeDeviceDescription'),
    failed: tPooled('opencodeGoFailed'),
  };
  const [phase, setPhase] = useState<ChatGptPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<ChatGptChallenge | null>(null);
  /** Claude: the sign-in the pasted code completes, and whether it is being checked. */
  const [claudeFlow, setClaudeFlow] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // One generation per sign-in run: Cancel then Connect must not revive the
  // old loop (see `createRunGeneration`).
  const [runs] = useState(createRunGeneration);
  const [antigravityRedirect, setAntigravityRedirect] = useState<{ flowId: string; authorizeUrl: string } | null>(null);
  const [antigravityRedirectUrl, setAntigravityRedirectUrl] = useState('');

  useEffect(() => {
    return () => runs.cancel();
  }, [runs]);

  const reset = useCallback(() => {
    runs.cancel();
    setChallenge(null);
    setClaudeFlow(null);
    setChecking(false);
    setError(null);
    setPhase('idle');
    setAntigravityRedirect(null);
    setAntigravityRedirectUrl('');
  }, [runs]);

  const claudeConnected = useCallback(async () => {
    setPhase('done');
    setChallenge(null);
    setClaudeFlow(null);
    successToast(copy.connectedToast);
    await queryClient.invalidateQueries({ queryKey: claudeSubscriptionKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: ['account-secret-resources'] });
    refreshProjectProviderState(queryClient, projectId);
    onConnected(subscription.providerId);
  }, [copy.connectedToast, onConnected, projectId, queryClient, subscription.providerId]);

  /** Claude: start `claude setup-token` and open claude.com. The tab opens inside the click, so a popup blocker lets it through. */
  const startClaude = useCallback(async () => {
    const isCancelled = runs.begin();
    setError(null);
    setChallenge(null);
    setPhase('waiting');
    const popup = typeof window === 'undefined' ? null : window.open('about:blank', '_blank');
    try {
      const started = await startClaudeSubscriptionLogin(projectId);
      if (isCancelled()) {
        popup?.close();
        return;
      }
      setClaudeFlow(started.flow_id);
      setChallenge({ url: started.authorize_url, code: null });
      if (popup && !popup.closed) popup.location.href = started.authorize_url;
    } catch (err) {
      popup?.close();
      if (isCancelled()) return;
      setPhase('idle');
      setError(err instanceof Error && err.message ? err.message : copy.failed);
    }
  }, [copy.failed, projectId, runs]);

  const completeAntigravityRedirect = useCallback(async (redirectUrl: string) => {
    if (!antigravityRedirect?.flowId || !redirectUrl.trim()) return;
    const isCancelled = runs.begin();
    setChecking(true);
    setError(null);
    try {
      const res = await completeWorkspaceProviderOAuth(projectId, subscription.oauth, antigravityRedirect.flowId, redirectUrl.trim());
      if (isCancelled()) return;
      if ((res as any).status === 'success') {
        setAntigravityRedirect(null);
        setAntigravityRedirectUrl('');
        setPhase('done');
        successToast(copy.connectedToast);
        void queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
        void queryClient.invalidateQueries({ queryKey: providerLoginsKey(projectId) });
        void queryClient.invalidateQueries({ queryKey: ['account-secret-resources'] });
        refreshProjectProviderState(queryClient, projectId, { expectProviderId: subscription.providerId });
        onConnected(subscription.providerId);
      } else if ((res as any).status === 'failed') {
        setError((res as any).error || copy.failed);
      } else if ((res as any).status === 'expired') {
        setError(copy.failed);
        setAntigravityRedirect(null);
      }
    } catch (err) {
      if (isCancelled()) return;
      setError(err instanceof Error && err.message ? err.message : copy.failed);
    } finally {
      setChecking(false);
    }
  }, [antigravityRedirect, copy.connectedToast, copy.failed, onConnected, projectId, queryClient, runs, subscription.oauth, subscription.providerId]);

  /** Claude: hand the code claude.com showed to the sign-in. A refused code ends it: the next try signs in again. */
  const submitCode = useCallback(async (code: string) => {
    if (!claudeFlow || !code.trim()) return;
    const isCancelled = runs.current();
    setChecking(true);
    setError(null);
    try {
      await completeClaudeSubscriptionLogin(projectId, { flowId: claudeFlow, code: code.trim() });
      if (!isCancelled()) await claudeConnected();
    } catch (err) {
      if (isCancelled()) return;
      setPhase('idle');
      setChallenge(null);
      setClaudeFlow(null);
      setError(err instanceof Error && err.message ? err.message : tClaude('codeError'));
    } finally {
      setChecking(false);
    }
  }, [claudeConnected, claudeFlow, projectId, tClaude, runs]);

  const submitAntigravityCredentials = useCallback(async (raw: string) => {
    const isCancelled = runs.begin();
    setChecking(true);
    setError(null);
    try {
      const parsed = parseAntigravityAuth(raw);
      if (!parsed || (!parsed.access && !parsed.refresh)) {
        throw new Error('Invalid Antigravity credentials or token format');
      }
      const authJson = JSON.stringify({ antigravity: parsed }, null, 2);
      // The LLM gateway reads this secret with consumer `llm_gateway`; the
      // generic default (`sandbox`) makes every gateway read a denial, and the
      // model then reports `provider_not_connected` despite the row existing.
      await upsertProjectSecret(projectId, {
        name: 'ANTIGRAVITY_AUTH_JSON',
        value: authJson,
        consumer: 'llm_gateway',
        strategy: 'broker',
      });

      const detail = await getProjectDetail(projectId).catch(() => null);
      const accountId = detail?.project?.account_id;
      if (accountId) {
        await createAccountSecretResource(accountId, {
          label: 'Google Antigravity',
          provider_id: 'antigravity',
          name: 'ANTIGRAVITY_AUTH_JSON',
          value: authJson,
          consumer: 'llm_gateway',
          strategy: 'broker',
        }).catch(() => {});
      }

      if (isCancelled()) return;
      setPhase('done');
      setChallenge(null);
      successToast(copy.connectedToast);
      await queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      await queryClient.invalidateQueries({ queryKey: providerLoginsKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: ['account-secret-resources'] });
      refreshProjectProviderState(queryClient, projectId, { expectProviderId: subscription.providerId });
      onConnected(subscription.providerId);
    } catch (err) {
      if (isCancelled()) return;
      setPhase('idle');
      setError(err instanceof Error && err.message ? err.message : copy.failed);
    } finally {
      setChecking(false);
    }
  }, [projectId, queryClient, onConnected, subscription.providerId, copy.connectedToast, copy.failed, runs]);

  const handleConnect = useCallback(async () => {
    if (claude) return startClaude();
    if (antigravity) {
      const isCancelled = runs.begin();
      setError(null);
      setChallenge(null);
      setPhase('waiting');
      let start: Awaited<ReturnType<typeof startProjectProviderOAuth>>;
      try {
        start = await startProjectProviderOAuth(projectId, subscription.oauth, {});
      } catch (err) {
        if (isCancelled()) return;
        // The device flow is unavailable (a server without it, or Google
        // unreachable): keep the paste step on screen as the manual fallback.
        setError(err instanceof Error && err.message ? err.message : copy.failed);
        setPhase('waiting');
        return;
      }
      if (isCancelled()) return;
      const started = start;
      if ((started as any).mode === 'redirect' && (started as any).authorize_url) {
        try {
          if (typeof window !== 'undefined') window.open((started as any).authorize_url, '_blank', 'noopener');
        } catch {}
        setAntigravityRedirect({ flowId: started.flow_id, authorizeUrl: (started as any).authorize_url });
        setPhase('waiting');
        return;
      }
      await runDeviceGrant({
        startOAuth: () => Promise.resolve(started),
        pollOAuth: (flowId) => pollProjectProviderOAuth(projectId, subscription.oauth, flowId),
        sleep,
        now: Date.now,
        isCancelled,
        setChallenge,
        setPhase,
        setError,
        failedMessage: copy.failed,
        onSuccess: () => {
          setPhase('done');
          successToast(copy.connectedToast);
          void queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
          void queryClient.invalidateQueries({ queryKey: providerLoginsKey(projectId) });
          void queryClient.invalidateQueries({ queryKey: ['account-secret-resources'] });
          refreshProjectProviderState(queryClient, projectId, { expectProviderId: subscription.providerId });
          onConnected(subscription.providerId);
        },
      });
      return;
    }
    const isCancelled = runs.begin();
    setError(null);
    setChallenge(null);
    setPhase('waiting');
    await runDeviceGrant({
      startOAuth: () => startProjectProviderOAuth(projectId, subscription.oauth, {}),
      pollOAuth: (flowId) => pollProjectProviderOAuth(projectId, subscription.oauth, flowId),
      sleep,
      now: Date.now,
      isCancelled,
      setChallenge,
      setPhase,
      setError,
      failedMessage: copy.failed,
      onSuccess: () => {
          setPhase('done');
          successToast(copy.connectedToast);
          queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
          queryClient.invalidateQueries({ queryKey: providerLoginsKey(projectId) });
          refreshProjectProviderState(queryClient, projectId, { expectProviderId: subscription.providerId });
          onConnected(subscription.providerId);
      },
    });
  }, [claude, antigravity, startClaude, projectId, queryClient, onConnected, subscription, copy.connectedToast, copy.failed, runs]);

  // What the PROJECT holds, not what this component remembers doing. A
  // credential connected in another tab, another surface, or before this page
  // load is still connected — and until this read existed the card offered
  // "Connect ChatGPT" over it and no way to remove it at all.
  const secretsQuery = useQuery({
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
    enabled: !claude,
  });
  // A Claude account is an account secret resource: own or shared, the server counts the usable ones.
  const claudeQuery = useQuery({
    queryKey: claudeSubscriptionKey(projectId),
    queryFn: () => getClaudeSubscription(projectId),
    enabled: claude,
  });
  // An OpenCode key secret can hold a plain API key, so a secret name does not
  // say "signed in"; the login list does.
  const loginsQuery = useQuery({
    queryKey: providerLoginsKey(projectId),
    queryFn: () => listProjectProviderOAuth(projectId),
    ...contract('config'),
    enabled: !chatgpt && !claude,
  });
  const connected = useMemo(() => {
    if (claude) return claudeQuery.data?.connected === true;
    if (antigravity) {
      const data = secretsQuery.data;
      const items = Array.isArray(data) ? data : (data?.items ?? []);
      return items.some((item) => item.name === 'ANTIGRAVITY_AUTH_JSON');
    }
    if (!chatgpt) return (loginsQuery.data ?? []).some((login) => login.provider_id === subscription.oauth);
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return subscriptionIsConnected(items.map((item) => item.name));
  }, [antigravity, chatgpt, claude, claudeQuery.data, loginsQuery.data, secretsQuery.data, subscription.oauth]);

  const disconnect = useMutation({
    // The server route was always correct and always unreachable: it deletes
    // the credential, audits it, and refreshes the model catalog. Nothing in
    // the product called it.
    mutationFn: async () => {
      if (claude) {
        // The caller's own Claude accounts in this project; one shared by someone else stays theirs to remove.
        const accountId = (await getProjectDetail(projectId)).project?.account_id;
        if (!accountId) throw new Error(tClaude('startError'));
        const { secrets } = await listAccountSecretResources(accountId, projectId);
        for (const secret of secrets.filter((item) => item.provider_id === subscription.providerId && item.created_by === viewer?.id)) {
          await deleteAccountSecretResource(accountId, secret.secret_id);
        }
      } else if (antigravity) {
        await deleteProjectSecret(projectId, 'ANTIGRAVITY_AUTH_JSON').catch(() => {});
        const detail = await getProjectDetail(projectId).catch(() => null);
        const accountId = detail?.project?.account_id;
        if (accountId) {
          const { secrets } = await listAccountSecretResources(accountId, projectId).catch(() => ({ secrets: [] }));
          for (const secret of secrets.filter((item) => item.provider_id === 'antigravity')) {
            await deleteAccountSecretResource(accountId, secret.secret_id).catch(() => {});
          }
        }
      } else await deleteProjectProviderOAuth(projectId, subscription.oauth);
    },
    // Returning the promise keeps the button in its pending state until the
    // cache says "disconnected", so the card never shows a live Disconnect
    // button over a credential the server already removed.
    onSuccess: async () => {
      if (claude) {
        await queryClient.invalidateQueries({ queryKey: claudeSubscriptionKey(projectId) });
        void queryClient.invalidateQueries({ queryKey: ['account-secret-resources'] });
      }
      else if (chatgpt) await forgetSubscriptionCredentials(queryClient, projectId);
      else if (antigravity) {
        void queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
        void queryClient.invalidateQueries({ queryKey: ['account-secret-resources'] });
      }
      else {
        queryClient.setQueryData(providerLoginsKey(projectId), (logins: Awaited<ReturnType<typeof listProjectProviderOAuth>> | undefined) =>
          logins?.filter((login) => login.provider_id !== subscription.oauth));
        void queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      }
      successToast(copy.disconnectedToast);
      setPhase('idle');
      setError(null);
      refreshProjectProviderState(queryClient, projectId);
    },
    onError: (err) =>
      errorToast(
        err instanceof Error ? err.message : tHardcodedUi.raw('i18nComplete.text7b7e67f5f919'),
      ),
  });

  return {
    subscription,
    copy,
    phase,
    challenge,
    error,
    connected,
    start: handleConnect,
    cancel: reset,
    disconnect,
    /** Claude only: the member pastes the code claude.com shows (`submitCode`) instead of typing one into the provider. */
    pastesCode: claude,
    submitCode,
    submitAntigravityCredentials,
    isAntigravity: antigravity,
    checking,
    antigravityRedirect,
    antigravityRedirectUrl,
    setAntigravityRedirectUrl,
    completeAntigravityRedirect,
  };
}

// Legacy ChatGPT subscription login. With pooled connections enabled this
// component shows only an existing project login; new accounts use resources.
export function ChatGptSubscriptionConnect({
  projectId,
  onConnected,
  accessSlot,
  usageSlot,
  legacyOnly = false,
  kind = 'chatgpt',
}: {
  projectId: string;
  onConnected: (providerId: string) => void;
  accessSlot?: ReactNode;
  /** The login's plan windows, under its name (the legacy project login). */
  usageSlot?: ReactNode;
  legacyOnly?: boolean;
  kind?: SubscriptionKind;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tPooled = useTranslations('pooledSecrets');
  const {
    subscription,
    copy,
    phase,
    challenge,
    error,
    connected,
    start: handleConnect,
    cancel: reset,
    disconnect,
    submitAntigravityCredentials,
    isAntigravity,
    checking,
    antigravityRedirect,
    antigravityRedirectUrl,
    setAntigravityRedirectUrl,
    completeAntigravityRedirect,
  } = useSubscriptionSignIn({ projectId, onConnected, kind });
  const waiting = phase === 'waiting';
  const action = subscriptionPrimaryAction({ connected, failed: !!error });
  if (legacyOnly && !connected) return null;

  return (
    <div className="bg-popover rounded-md border px-4 py-4">
      <div className="flex items-start gap-3">
        <ProviderLogo providerID={subscription.logo} name={subscription.logoName} size="default" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-medium">
            {legacyOnly ? tPooled('legacyChatGptLogin') : copy.title}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs leading-5">
            {legacyOnly ? tPooled('legacyChatGptDescription') : copy.description}
          </p>
        </div>
        {accessSlot}
      </div>
      {usageSlot ? <div className="mt-3">{usageSlot}</div> : null}

      {waiting && isAntigravity && antigravityRedirect && (
        <div className="mt-3 space-y-2">
          <div className="text-foreground text-xs font-medium">
            Sign in in the opened browser window, then paste the redirect URL below.
          </div>
          <a
            className="text-muted-foreground hover:text-foreground block text-xs underline underline-offset-2"
            href={antigravityRedirect.authorizeUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open Google sign-in
          </a>
          <input
            type="text"
            className="border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1"
            value={antigravityRedirectUrl}
            onChange={(e) => setAntigravityRedirectUrl(e.target.value)}
            placeholder="http://localhost:51121/oauth-callback?code=...&state=..."
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="px-3"
            disabled={checking || !antigravityRedirectUrl.trim()}
            onClick={() => void completeAntigravityRedirect(antigravityRedirectUrl)}
          >
            {checking ? 'Completing…' : 'Complete sign-in'}
          </Button>
        </div>
      )}

      {waiting && isAntigravity && !challenge && !antigravityRedirect && error && (
        // The device flow was refused before any code arrived: the paste step
        // is the manual fallback, shown together with the reason below.
        <div className="mt-3">
          <AntigravityCredentialsStep
            saving={checking}
            onSubmit={(raw) => void submitAntigravityCredentials(raw)}
          />
        </div>
      )}

      {waiting && (!isAntigravity || challenge || !error) && !(isAntigravity && antigravityRedirect) && (
        <div className="border-border bg-muted/30 mt-3 rounded-md border p-3">
          {challenge ? (
            <>
              <div className="text-foreground text-xs font-medium">
                {tHardcodedUi.raw(
                  'autoComponentsProjectsProjectProviderModalJsxTextAuthorizeInThed882ae47',
                )}
              </div>
              <div className="mt-3">
                <ChatGptDeviceChallenge url={challenge.url} code={challenge.code} description={copy.deviceDescription} />
              </div>
            </>
          ) : (
            <div className="text-foreground text-xs font-medium">
              {tHardcodedUi.raw(
                'autoComponentsProjectsProjectProviderModalJsxTextStartingAuthorization35b1fe13',
              )}
            </div>
          )}
          <div className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
            <Loading className="size-3.5 shrink-0" />
            {challenge
              ? tHardcodedUi.raw('i18nComplete.text2f938f9b118b')
              : copy.connecting}
          </div>
        </div>
      )}

      {(phase === 'done' || (connected && !waiting)) && (
        <BannerAlert variant="success" className="mt-3 text-xs"><BannerAlertMedia><CheckCircle2 /></BannerAlertMedia><BannerAlertDescription>
          {copy.connectedBanner}
        </BannerAlertDescription></BannerAlert>
      )}

      {error && (
        <BannerAlert variant="destructive" className="mt-3 text-xs"><BannerAlertMedia><TriangleAlert /></BannerAlertMedia><BannerAlertDescription>
          {error}
        </BannerAlertDescription></BannerAlert>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {waiting ? (
          <Button type="button" size="sm" variant="outline" className="px-4" onClick={reset}>
            {tHardcodedUi.raw('i18nComplete.text19766ed6ccb2')}
          </Button>
        ) : action === 'disconnect' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="px-4"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {disconnect.isPending
              ? tHardcodedUi.raw('i18nComplete.textcb2b6a572a85')
              : copy.disconnect}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="px-4"
            onClick={handleConnect}
          >
            {action === 'reconnect' ? copy.reconnect : copy.connect}
          </Button>
        )}
      </div>
    </div>
  );
}
