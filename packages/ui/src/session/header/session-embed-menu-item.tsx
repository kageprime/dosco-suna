'use client';

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../../primitives/dropdown-menu';
import { errorToast, successToast } from '../../primitives/toast';
import { useTranslations } from '../../i18n';
import { CodeIcon } from '@phosphor-icons/react';
import { copyToClipboard } from '../../internal/lib/utils/clipboard';
import { sessionEmbedSnippet } from './session-embed-snippet';

/**
 * "Embed" in the session menu: the snippet for framing the actual session
 * page, with its caveat. The entry point left the Session access dialog
 * (KRTX-4639) — a developer affordance does not belong in a permissions
 * dialog — and this submenu is its one home. The caller gates the mount on
 * the same verdicts the dialog's section used: the viewer may manage sharing
 * (`can_manage_sharing`) and the host serves public shares.
 */
export function SessionEmbedMenuItem({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const t = useTranslations('hardcodedUi.sessionEmbed');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');

  const copy = async () => {
    const snippet = sessionEmbedSnippet(projectId, sessionId, window.location.origin);
    if (!snippet) return;
    if (await copyToClipboard(snippet)) successToast(t.raw('copied'));
    else errorToast(tI18nComplete.raw('text167c96824acb'));
  };

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="cursor-pointer">
        <CodeIcon />
        {t.raw('sectionTitle')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <p className="text-muted-foreground px-2 py-1.5 text-xs">{t.raw('sectionDescription')}</p>
        <DropdownMenuItem className="cursor-pointer" onClick={() => void copy()}>
          <CodeIcon />
          {t.raw('copy')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
