'use client';

import {
  type AdminConnector,
  type AgentConfigBlock,
  type AgentGrantSet,
  getWorkspaceDetail,
  listConnectors,
  setAgentScope,
  type WorkspaceAgentEntry,
} from '@kortix/sdk';
import {
  contract,
  flattenModels,
  modelProviderMode,
  qk,
  useModelDefaults,
  useRuntimeProviders,
  useSetWorkspaceAgentPaused,
} from '@kortix/sdk/react';
import { ArrowUpRightIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { useTranslations } from '../../i18n';
import { ConnectorLogo } from '../../internal/connector-logo/connector-logo';
import { installedConnectorLogoSource } from '../../internal/connector-logo/connector-logo-source';
import { useAgentConfig, useUpdateAgentConfig } from '../../internal/hooks/projects/use-agent-config';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../../primitives/input-group';
import { Switch } from '../../primitives/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import { Textarea } from '../../primitives/textarea';
import { errorToast } from '../../primitives/toast';
import { UiLink as Link } from '../../providers/ui-provider';
import { ModelSelector } from '../../session/models/model-selector';
import { toggleGrant } from './agent-apps-grant';
import { SpaceRoutines } from './space-details-panel';

type AgentSettingsTab = 'general' | 'apps' | 'routines';

/**
 * An agent's settings (flag `channels`), in the details panel of its chat, in
 * three tabs. General: status, model and description. Apps: one switch per
 * workspace connector, the agent's connector grant. Routines: the routines
 * that post into the agent's chat. Every field is the agent's own config,
 * written where the agent page writes it.
 */
export function AgentSettingsTabs({ projectId, agent, spaceId }: { projectId: string; agent: WorkspaceAgentEntry; spaceId: string }) {
  const t = useTranslations('spaces.agentChat.settings');
  const [tab, setTab] = useState<AgentSettingsTab>('general');
  const adminPath = uiRoutes().admin(projectId, `agents/${encodeURIComponent(agent.name)}`);
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as AgentSettingsTab)} className="gap-0">
      <TabsList type="underline" size="sm" className="border-border w-full shrink-0 justify-start gap-4 border-b px-5">
        <TabsTrigger value="general" className="w-fit flex-none">
          {t('general')}
        </TabsTrigger>
        <TabsTrigger value="apps" className="w-fit flex-none">
          {t('appsTab')}
        </TabsTrigger>
        <TabsTrigger value="routines" className="w-fit flex-none">
          {t('routines')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="general" className="px-5 py-5">
        <AgentChatGeneral projectId={projectId} agent={agent} adminPath={adminPath} />
      </TabsContent>
      <TabsContent value="apps">
        <AgentChatApps projectId={projectId} name={agent.name} />
      </TabsContent>
      <TabsContent value="routines" className="px-3 py-4">
        <SpaceRoutines projectId={projectId} space={{ space_id: spaceId, kind: 'dm', dm_agent_name: agent.name }} />
      </TabsContent>
    </Tabs>
  );
}

/** Status, model and description, then the full agent page. The panel above already shows who the agent is. */
function AgentChatGeneral({ projectId, agent, adminPath }: { projectId: string; agent: WorkspaceAgentEntry; adminPath: string | null }) {
  const t = useTranslations('spaces.agentChat.settings');
  const pause = useSetWorkspaceAgentPaused(projectId);
  const paused = agent.status === 'paused';
  return (
    <div className="flex flex-col gap-6">
      <dl className="flex flex-col gap-3 text-sm">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <dt className="text-muted-foreground">{t('status')}</dt>
          <dd className="flex items-center gap-2">
            <span>{agent.status === 'off' ? t('off') : paused ? t('paused') : t('active')}</span>
            <Switch
              checked={agent.status === 'active'}
              disabled={pause.isPending || agent.status === 'off'}
              aria-label={t('active')}
              onCheckedChange={(on) =>
                pause.mutate({ name: agent.name, paused: !on }, { onError: () => errorToast(t('pauseFailed')) })
              }
            />
          </dd>
        </div>
        {agent.is_default ? (
          <div className="flex min-h-8 items-center justify-between gap-3">
            <dt className="text-muted-foreground">{t('role')}</dt>
            <dd>{t('workspaceDefault')}</dd>
          </div>
        ) : null}
        <div className="flex min-h-8 items-center justify-between gap-3">
          <dt className="text-muted-foreground shrink-0">{t('model')}</dt>
          <dd className="min-w-0">
            <AgentChatModel projectId={projectId} name={agent.name} />
          </dd>
        </div>
      </dl>

      <AgentChatDescription projectId={projectId} name={agent.name} />

      {adminPath ? (
        <Button asChild variant="outline" size="sm" className="self-start">
          <Link href={adminPath}>
            {t('allSettings')}
            <ArrowUpRightIcon />
          </Link>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The model the agent runs on: the per-agent gateway default (no commit). Unset,
 * it follows the workspace default, which the picker names. Without
 * `project.model.write` the resolved model shows as text.
 */
function AgentChatModel({ projectId, name }: { projectId: string; name: string }) {
  const t = useTranslations('spaces.agentChat.settings');
  const canManage = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MODEL_WRITE).allowed === true;
  const { data: providers } = useRuntimeProviders();
  const models = useMemo(() => flattenModels(providers, { providerMode: modelProviderMode(providers) }), [providers]);
  const defaults = useModelDefaults(projectId);
  const explicit = defaults.agentDefaults[name] ?? null;
  const resolved = defaults.resolveDefaultFor(name) ?? null;
  const nameOf = (m: { providerID: string; modelID: string } | null) =>
    m ? (models.find((x) => x.providerID === m.providerID && x.modelID === m.modelID)?.modelName ?? `${m.providerID}/${m.modelID}`) : null;
  const fallback = nameOf(resolved);
  const unsetLabel = fallback ? t('modelDefaultNamed', { model: fallback }) : t('modelDefault');
  if (!canManage) return <span className="block truncate">{nameOf(explicit) ?? unsetLabel}</span>;
  return (
    <ModelSelector
      models={models}
      providers={providers}
      selectedModel={explicit}
      unsetLabel={unsetLabel}
      onSelect={(m) => void (m ? defaults.setAgentDefault(name, m) : defaults.clearAgentDefault(name))}
    />
  );
}

/** The agent's description: what the agent is for. Saved to its block in kortix.yaml. */
function AgentChatDescription({ projectId, name }: { projectId: string; name: string }) {
  const config = useAgentConfig(projectId, name);
  const block = config.data?.block ?? null;
  const saved = block?.behavior?.description ?? '';
  // Keyed on the saved text: a save that lands, or a change from elsewhere, starts a fresh draft.
  return <AgentChatDescriptionForm key={saved} projectId={projectId} name={name} saved={saved} block={config.data?.editable ? block : null} />;
}

function AgentChatDescriptionForm({
  projectId,
  name,
  saved,
  block,
}: {
  projectId: string;
  name: string;
  saved: string;
  /** Null: the description is read-only (no block, or the server says not editable). */
  block: AgentConfigBlock | null;
}) {
  const t = useTranslations('spaces.agentChat.settings');
  const save = useUpdateAgentConfig(projectId, name);
  const [draft, setDraft] = useState(saved);
  return (
    <section className="flex flex-col gap-2">
      <label htmlFor="agent-description" className="text-muted-foreground text-sm">
        {t('description')}
      </label>
      <Textarea
        id="agent-description"
        value={draft}
        disabled={!block || save.isPending}
        rows={4}
        onChange={(event) => setDraft(event.target.value)}
      />
      {block && draft !== saved ? (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => setDraft(saved)}>
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                { ...block, behavior: { ...block.behavior, description: draft.trim() } },
                { onError: () => errorToast(t('saveFailed')) },
              )
            }
          >
            {t('save')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Which workspace connectors the agent may use: a search, then one row per
 * connector (logo, name, switch). A switch saves at once
 * (`PUT /agents/:name/scope`). Without `project.agent.write` the switches are
 * read-only.
 */
function AgentChatApps({ projectId, name }: { projectId: string; name: string }) {
  const t = useTranslations('spaces.agentChat.settings');
  const queryClient = useQueryClient();
  const canManage = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  const [query, setQuery] = useState('');
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getWorkspaceDetail(projectId),
    ...contract('config'),
  });
  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    ...contract('config'),
  });
  const scope = detail.data?.config?.agents?.find((agent) => agent.name === name)?.scope;
  // The grant as last written here; the saved scope once the config refetches.
  const [pending, setPending] = useState<AgentGrantSet | null>(null);
  const grant = pending ?? scope?.connectors ?? null;
  const save = useMutation({
    mutationFn: (connectors: AgentGrantSet) => setAgentScope(projectId, name, { connectors }),
    onError: () => {
      setPending(null);
      errorToast(t('appsFailed'));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) }).then(() => setPending(null)),
  });

  const connectors = useMemo(
    () => [...(connectorsQuery.data?.connectors ?? [])].sort((a, b) => connectorName(a).localeCompare(connectorName(b))),
    [connectorsQuery.data],
  );
  const slugs = useMemo(() => connectors.map((connector) => connector.slug), [connectors]);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? connectors.filter((connector) => `${connectorName(connector)} ${connector.slug}`.toLowerCase().includes(needle))
    : connectors;

  return (
    <>
      <div className="px-5 pt-4 pb-2">
        <InputGroup>
          <InputGroupAddon>
            <MagnifyingGlassIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            placeholder={t('searchApps')}
            aria-label={t('searchApps')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
      </div>
      <div className="px-3 pb-4">
        {!connectorsQuery.data || !detail.data ? null : connectors.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-sm">{t('noApps')}</p>
        ) : !grant ? (
          <p className="text-muted-foreground px-2 py-3 text-sm text-pretty">{t('appsUnavailable')}</p>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-sm">{t('noAppsMatch', { query: query.trim() })}</p>
        ) : (
          <ul>
            {shown.map((connector) => {
              const label = connectorName(connector);
              const on = grant === 'all' || grant.includes(connector.slug);
              return (
                <li key={connector.slug}>
                  <label className="hover:bg-hover flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 has-disabled:cursor-default has-disabled:hover:bg-transparent">
                    <ConnectorLogo source={installedConnectorLogoSource(connector)} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                    <Switch
                      checked={on}
                      disabled={!canManage || save.isPending}
                      aria-label={label}
                      onCheckedChange={(next) => {
                        const nextGrant = toggleGrant(grant, slugs, connector.slug, next);
                        setPending(nextGrant);
                        save.mutate(nextGrant);
                      }}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function connectorName(connector: AdminConnector): string {
  return connector.name || connector.slug;
}
