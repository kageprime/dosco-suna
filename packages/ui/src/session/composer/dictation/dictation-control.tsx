'use client';

import { CheckIcon, MicrophoneIcon, XIcon } from '@phosphor-icons/react';
import { useReducedMotion } from 'motion/react';

import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { Button } from '../../../primitives/button';
import Hint from '../../../primitives/hint';
import Loading from '../../../primitives/loading';
import { DICTATION_BARS, formatElapsed } from './dictation-state';
import type { ComposerDictation } from './use-composer-dictation';

/** The composer's other icon buttons: round, a press scale, color on hover. */
const ICON_BUTTON =
  'shrink-0 rounded-full p-0 hit-area-3 text-muted-foreground hover:text-foreground transition-[color,background-color,scale] active:scale-[0.96] active:duration-(--duration-normal) duration-(--duration-fast) ease-out motion-reduce:active:scale-100';

/**
 * The composer's microphone. Idle: one ghost button before Send. Recording:
 * Discard, the live level, the time, and Done in its place. Done puts the
 * words at the caret; Escape discards.
 */
export function DictationControl({ dictation, disabled = false }: { dictation: ComposerDictation; disabled?: boolean }) {
  const t = useTranslations('dictation');
  const reduceMotion = useReducedMotion();
  const { phase } = dictation;

  if (phase === 'idle' || phase === 'starting') {
    return (
      <Hint
        side="top"
        label={
          <span className="flex flex-col">
            <span>{t('start')}</span>
            <span className="text-muted-foreground">{t('price', { credits: dictation.creditsPerMinute })}</span>
          </span>
        }
      >
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon-base"
            aria-label={t('start')}
            disabled={disabled || phase === 'starting'}
            onClick={dictation.start}
            className={ICON_BUTTON}
          >
            <MicrophoneIcon className="size-4" />
          </Button>
        </span>
      </Hint>
    );
  }

  const transcribing = phase === 'transcribing';
  const padded = [...Array(Math.max(0, DICTATION_BARS - dictation.levels.length)).fill(0), ...dictation.levels];
  return (
    <div className="flex items-center gap-1" role="group" aria-label={t('recording')}>
      <Hint side="top" label={t('discard')}>
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon-base"
            aria-label={t('discard')}
            onClick={dictation.cancel}
            className={ICON_BUTTON}
          >
            <XIcon className="size-4" />
          </Button>
        </span>
      </Hint>
      {!reduceMotion && (
        <div
          aria-hidden
          className={cn('flex h-4 items-center gap-0.5', transcribing && 'text-muted-foreground')}
        >
          {padded.map((level, i) => (
            <span
              key={i}
              className="bg-current w-0.5 rounded-full"
              style={{ height: `${Math.round(2 + level * 14)}px` }}
            />
          ))}
        </div>
      )}
      <span className="text-muted-foreground min-w-9 text-right text-xs tabular-nums" aria-live="off">
        {transcribing ? t('transcribing') : formatElapsed(dictation.elapsedMs)}
      </span>
      <Hint side="top" label={t('finish')}>
        <span className="inline-flex">
          <Button
            type="button"
            size="icon-base"
            aria-label={transcribing ? t('transcribing') : t('finish')}
            disabled={transcribing}
            onClick={dictation.finish}
            className="shrink-0 rounded-full p-0 hit-area-3"
          >
            {transcribing ? <Loading className="size-3.5 shrink-0" /> : <CheckIcon weight="bold" className="size-4" />}
          </Button>
        </span>
      </Hint>
    </div>
  );
}
