import { useTranslations } from '../../i18n';
/** The canonical audit timeline keeps this record even after inbox delivery. */
export function ModelSwitchEvent({
  summary,
}: {
  summary: Record<string, unknown> | null | undefined;
}) {
  const t = useTranslations('sessionModelSwitch');
  if (typeof summary?.to !== 'string') return null;
  return (
    <div className="text-muted-foreground mt-1 min-w-0 space-y-1 text-xs">
      <p className="break-all font-mono text-foreground">
        {typeof summary.from === 'string' ? summary.from : '—'} → {summary.to}
      </p>
      <p className="break-all">
        {typeof summary.actor_session_id === 'string'
          ? t('agentSession', { id: summary.actor_session_id })
          : t('human')}
      </p>
      {typeof summary.prompt === 'string' ? (
        <p className="whitespace-pre-wrap break-words">{summary.prompt}</p>
      ) : null}
    </div>
  );
}

export function ModelSwitchHistory({
  history,
  current,
}: {
  history: unknown;
  current?: unknown;
}) {
  const t = useTranslations('sessionModelSwitch');
  if (!Array.isArray(history)) return null;
  const entries = history.filter(
    (item): item is Record<string, unknown> & { id: string; to: string } =>
      item !== null &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.to === 'string',
  );
  if (entries.length === 0) return null;
  return (
    <details className="text-muted-foreground mx-auto w-full min-w-0 max-w-2xl px-4 text-xs">
      <summary className="cursor-pointer py-2">
        <span>
          {t('listLabel')} · {entries.length}
        </span>
        {typeof current === 'string' ? (
          <span
            className="block max-w-full truncate pl-4 font-mono"
            title={current}
          >
            {current}
          </span>
        ) : null}
      </summary>
      <ol
        aria-label={t('listLabel')}
        className="mb-2 max-h-64 space-y-2 overflow-y-auto overscroll-contain border-l border-border pl-3"
      >
        {entries.map((item) => (
          <li key={item.id} className="min-w-0">
            <ModelSwitchEvent summary={item} />
            {typeof item.at === 'string' ? (
              <time
                className="break-all text-muted-foreground text-xs"
                dateTime={item.at}
              >
                {item.at}
              </time>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
