'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { ComposerChatInput } from '@/features/session/composer-chat-input';
import type { DraftScope } from '@/features/session/composer/draft/composer-draft';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useTranslations } from '@/i18n/use-translations';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { useAuth } from '@/features/providers/auth-provider';
import { getProjectDetail, listProjectSessions } from '@kortix/sdk';
import { qk, contract } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { toArray } from '@/features/workspace/customize/shared/utils';

export type EasyWorkState = 'done' | 'working' | 'waiting';

/**
 * Maps a session record to one of three human states. Tolerant by design:
 * the API has added status values before (and will again) — unknown shapes
 * read as done, never crash, never blank.
 */
export function easyWorkState(session: {
  status?: string | null;
  needs_you?: boolean | null;
  awaiting_input?: boolean | null;
  pending_approval?: boolean | null;
}): EasyWorkState {
  if (session.needs_you || session.awaiting_input || session.pending_approval) return 'waiting';
  if (session.status === 'running') return 'working';
  return 'done';
}

function daypartKey(hour: number): string {
  if (hour < 12) return 'easyDayMorning';
  if (hour < 18) return 'easyDayAfternoon';
  return 'easyDayEvening';
}

const SUGGESTION_KEYS = ['easySuggest1', 'easySuggest2', 'easySuggest3'] as const;

/**
 * Easy project home: greeting, one outcome composer, recent work, two cards.
 * No builders grids, no stats, no infra vocabulary. Advanced users keep the
 * full `ProjectHome`; the switch lives in the account menu (`setPanelMode`).
 */
export function ProjectHomeEasy({
  projectId,
  onSend,
  busy,
}: {
  projectId: string;
  onSend: (text: string, files: AttachedFile[] | undefined) => void | Promise<void>;
  busy: boolean;
}) {
  const t = useTranslations('projectHomeEasy');
  const { user } = useAuth();
  const setPanelMode = useUserPreferencesStore((s) => s.setPanelMode);

  const displayName =
    (user?.user_metadata?.full_name as string | undefined)?.split(' ')[0] ||
    (user?.user_metadata?.name as string | undefined)?.split(' ')[0] ||
    null;
  const greeting = t(daypartKey(new Date().getHours()));
  const heading = displayName ? t('easyGreetingWithName', { daypart: greeting, name: displayName })
    : t('easyGreeting', { daypart: greeting });

  const [prefill, setPrefill] = useState<{ text: string; id: number } | null>(null);
  const pendingPrefill = useComposerPrefillStore((s) => s.prefillByProject[projectId]);
  const consumePrefill = useComposerPrefillStore((s) => s.consume);
  useEffect(() => {
    if (!pendingPrefill) return;
    consumePrefill(projectId);
    setPrefill({ text: pendingPrefill.text, id: Date.now() });
  }, [pendingPrefill, projectId, consumePrefill]);
  const draftScope = useMemo<DraftScope>(() => ({ kind: 'project', projectId }), [projectId]);

  const sessionsQuery = useQuery({
    queryKey: qk.project.sessions(projectId, { limit: 5 }),
    queryFn: () => listProjectSessions(projectId, { limit: 5 }),
    ...contract('inventory'),
    refetchOnWindowFocus: false,
  });
  const sessions = useMemo(() => (sessionsQuery.data as any)?.items ?? [], [sessionsQuery.data]);

  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const agents = useMemo(
    () => toArray((detailQuery.data as any)?.config?.agents ?? (detailQuery.data as any)?.project?.agents),
    [detailQuery.data],
  );

  const stateLabel: Record<EasyWorkState, string> = {
    done: t.raw('easyStateDone'),
    working: t.raw('easyStateWorking'),
    waiting: t.raw('easyStateWaiting'),
  };
  const stateDot: Record<EasyWorkState, string> = {
    done: 'bg-emerald-500',
    working: 'bg-sky-500 animate-pulse',
    waiting: 'bg-amber-500',
  };

  return (
    <div className="bg-background relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 overflow-y-auto px-6 py-10">
        <div className="space-y-4">
          <h1 className="text-foreground text-2xl font-medium tracking-tight text-balance">
            {heading}
          </h1>
          <ComposerChatInput
            onSend={onSend}
            projectId={projectId}
            draftScope={draftScope}
            isSending={busy}
            disabled={busy}
            clearOnSend={false}
            autoFocus
            placeholder={t.raw('easyComposerPlaceholder')}
            prefill={prefill}
          />
          <div className="flex flex-wrap gap-2">
            {SUGGESTION_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setPrefill({ text: t.raw(k), id: Date.now() })}
                className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 rounded-full px-3 py-1.5 text-sm transition-colors"
              >
                {t.raw(k)}
              </button>
            ))}
          </div>
        </div>

        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-foreground text-base font-medium">{t.raw('easyRecentWork')}</h2>
            <Link
              href={capabilityTabHref(projectId, 'review')}
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              {t.raw('easySeeAll')}
            </Link>
          </div>
          {sessionsQuery.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bg-foreground/5 h-12 animate-pulse rounded-lg" />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-muted-foreground text-sm text-pretty">{t.raw('easyEmpty')}</p>
          ) : (
            <ul className="divide-border/60 divide-y rounded-xl border">
              {sessions.map((s: any) => {
                const st = easyWorkState(s);
                return (
                  <li key={s.session_id ?? s.id}>
                    <Link
                      href={`/projects/${projectId}/sessions/${s.session_id ?? s.id}`}
                      className="hover:bg-foreground/[0.03] flex items-center gap-3 px-4 py-3 transition-colors"
                    >
                      <span className={`size-2 shrink-0 rounded-full ${stateDot[st]}`} />
                      <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                        {s.title || s.session_id}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {stateLabel[st]}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <Link
            href={capabilityTabHref(projectId, 'agent')}
            className="hover:bg-foreground/[0.03] rounded-xl border p-4 transition-colors"
          >
            <div className="text-foreground text-sm font-medium">{t.raw('easyTeam')}</div>
            <div className="text-muted-foreground mt-1 text-xs">
              {t('easyTeamCount', { count: agents.length })}
            </div>
          </Link>
          <Link
            href={capabilityTabHref(projectId, 'marketplace')}
            className="hover:bg-foreground/[0.03] rounded-xl border p-4 transition-colors"
          >
            <div className="text-foreground text-sm font-medium">{t.raw('easyMarketplace')}</div>
            <div className="text-muted-foreground mt-1 text-xs">{t.raw('easyMarketplaceSub')}</div>
          </Link>
        </section>

        <button
          type="button"
          onClick={() => setPanelMode('advanced')}
          className="text-muted-foreground hover:text-foreground mx-auto text-sm transition-colors"
        >
          {t.raw('easyShowEverything')}
        </button>
      </div>
    </div>
  );
}
