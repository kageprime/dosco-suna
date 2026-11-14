'use client';

import { Input } from '../../../primitives/input';
import { Label } from '../../../primitives/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../primitives/select';
import { type AutosizeTextAreaRef, Textarea } from '../../../primitives/textarea';
import { ModelSelector } from '../../../session/models/model-selector';
import { AgentSelector } from '../../../session/composer/session-chat-input';
import { resolveProgramAgent } from '../../../session/composer/agent-selector';
import { useTranslations as useI18nTranslations } from '../../../i18n';
import {
  type Agent,
  flattenModels,
  modelProviderMode,
  projectLlmCatalogToProviderList,
  useProjectApps,
  useWorkspaceModelPickerCatalog,
} from '@kortix/sdk/react';
import { useMemo, useRef } from 'react';

import { InlineError, type PatchDraft } from './composer-parts';
import { PromptVariableHints } from './event-trigger-fields';
import type { ComposerDraft } from './trigger-composer-logic';

const TARGET_ERROR_ID = 'trigger-target-error';

/**
 * Then: what a fire does. Run an agent (the instruction, which agent, which
 * model), or call one of the project's Apps (`run: { app, path }` in
 * kortix.yaml), which takes the payload and needs no instruction.
 */
export function ThenFields({
  projectId,
  agents,
  draft,
  patch,
  payloadSchema,
  error,
}: {
  /** The workspace whose servable models the Model picker lists. */
  projectId: string;
  agents: Agent[];
  draft: ComposerDraft;
  patch: PatchDraft;
  /** The chosen event's payload, for the variable chips. */
  payloadSchema: Record<string, unknown> | null | undefined;
  error?: string;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tComposer = useI18nTranslations('triggerComposer');
  const callsApp = draft.thenKind === 'app';
  // A program agent (`run`) has no model: the text is its stdin, and empty sends the payload as JSON.
  const programAgent = resolveProgramAgent(agents, draft.agent);
  // A null project id keeps the hook idle: only the App target lists the project's Apps.
  const projectApps = useProjectApps(callsApp ? projectId : null).data ?? [];
  // A saved target whose App is gone still shows its slug, so the form never reads as blank.
  const unknownApp = draft.targetApp && !projectApps.some((app) => app.slug === draft.targetApp);
  const promptRef = useRef<AutosizeTextAreaRef | null>(null);
  // The workspace's servable catalog (`GET /workspaces/:id/model-picker`), read
  // by id: a trigger runs outside any session, so the session runtime's
  // provider list is not the source.
  const catalog = useWorkspaceModelPickerCatalog(projectId);
  const providers = useMemo(
    () => (catalog ? projectLlmCatalogToProviderList(catalog) : undefined),
    [catalog],
  );
  const models = useMemo(
    () => flattenModels(providers, { providerMode: modelProviderMode(providers) }),
    [providers],
  );

  function insertVariable(token: string) {
    const el = promptRef.current?.textArea;
    const text = draft.instruction;
    const at = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? at;
    // Two chips in a row read as two words, not `}}{{`.
    const insert = at > 0 && !/\s/.test(text[at - 1]) ? ` ${token}` : token;
    patch({ instruction: `${text.slice(0, at)}${insert}${text.slice(end)}` });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + insert.length, at + insert.length);
    });
  }

  const kindPicker = (
    <Select value={draft.thenKind} onValueChange={(thenKind) => patch({ thenKind: thenKind as ComposerDraft['thenKind'] })}>
      <SelectTrigger aria-label={tComposer('thenLabel')} className="w-full cursor-pointer text-sm sm:w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="agent" className="cursor-pointer">
          {tComposer('thenAgent')}
        </SelectItem>
        <SelectItem value="app" className="cursor-pointer">
          {tComposer('thenApp')}
        </SelectItem>
      </SelectContent>
    </Select>
  );

  if (callsApp) {
    return (
      <div className="space-y-3">
        {kindPicker}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem]">
          <div className="space-y-1.5">
            <Label htmlFor="trigger-target-app" className="text-xs">
              {tComposer('appLabel')}
            </Label>
            <Select value={draft.targetApp ?? ''} onValueChange={(targetApp) => patch({ targetApp })}>
              <SelectTrigger
                id="trigger-target-app"
                className="w-full cursor-pointer text-sm"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? TARGET_ERROR_ID : undefined}
              >
                <SelectValue placeholder={tComposer('appPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {unknownApp ? (
                  <SelectItem value={draft.targetApp!} className="cursor-pointer">
                    {draft.targetApp}
                  </SelectItem>
                ) : null}
                {projectApps.map((app) => (
                  <SelectItem key={app.app_id} value={app.slug} className="cursor-pointer">
                    {app.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="trigger-target-path" className="text-xs">
              {tComposer('targetPath')}
            </Label>
            <Input
              id="trigger-target-path"
              size="xs"
              value={draft.targetPath}
              onChange={(e) => patch({ targetPath: e.target.value })}
              placeholder="/"
              maxLength={2048}
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="trigger-target-method" className="text-xs">
              {tComposer('targetMethod')}
            </Label>
            <Select
              value={draft.targetMethod}
              onValueChange={(method) => patch({ targetMethod: method as ComposerDraft['targetMethod'] })}
            >
              <SelectTrigger id="trigger-target-method" className="w-full cursor-pointer font-mono text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="POST" className="cursor-pointer font-mono">
                  POST
                </SelectItem>
                <SelectItem value="GET" className="cursor-pointer font-mono">
                  GET
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <InlineError id={TARGET_ERROR_ID} message={error} />
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{tComposer('targetHelp')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {kindPicker}
      <div className="space-y-2">
        <Textarea
          value={draft.instruction}
          ref={promptRef}
          onChange={(e) => patch({ instruction: e.target.value })}
          aria-label={tI18nComplete.raw('text112f3ccb1b36')}
          aria-invalid={error ? true : undefined}
          placeholder={programAgent ? tComposer('programInputPlaceholder') : tI18nComplete.raw('text2438ee64fbf9')}
          rows={3}
          className={programAgent ? 'font-mono text-sm leading-relaxed' : 'leading-relaxed'}
        />
        <InlineError message={error} />
        {programAgent ? (
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{tComposer('programInputHelp')}</p>
        ) : draft.kind === 'event' && draft.eventType ? (
          <PromptVariableHints payloadSchema={payloadSchema} onInsert={insertVariable} />
        ) : (
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
            {tI18nComplete.raw('text03956d4b33dc')}
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{tI18nComplete.raw('text11b39c93777e')}</Label>
          {/* `field`: the selector is the bordered h-9 box itself, like every
              Select in this form, not a chat chip inside a frame. */}
          <AgentSelector
            agents={agents}
            selectedAgent={draft.agent}
            appearance="field"
            onSelect={(agent) => patch({ agent })}
          />
        </div>
        {programAgent ? null : (
        <div className="space-y-1.5">
          <Label className="text-xs">{tI18nComplete.raw('text5e2c614c23f0')}</Label>
          <ModelSelector
            models={models}
            providers={providers}
            modelsLoading={!catalog}
            selectedModel={draft.model}
            unsetLabel={tI18nComplete.raw('text57069bbd0d2e')}
            appearance="field"
            onSelect={(model) => patch({ model })}
          />
        </div>
        )}
      </div>
    </div>
  );
}
