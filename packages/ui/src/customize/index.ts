/**
 * @kortix/ui/customize — The project configuration pages (connectors, agents, triggers,
 * secrets, models, skills, settings). Each takes `projectId`.
 */
export { AgentPage } from './agents/agent-page';
export { AgentsPage } from './agents/agents-page';
export { ConnectorsPage } from './connectors/connectors-page';
export { ModelsPage } from './models/models-page';
export { ProjectSettingsPage } from './project-settings/project-settings-page';
export { SecretsPage } from './secrets/secrets-page';
export { CapabilityPageShell } from './shared/capability-page-shell';
export { CustomizeSidebar } from './shared/customize-sidebar';
export { SkillsPage } from './skills/skills-page';
export { TriggersPage } from './triggers/triggers-page';
export { UnifiedSettingsPage } from './unified-settings/unified-settings-page';
export { LlmSections, ProjectDefaultPicker, LLM_TABS } from './sections/gateway-view';
export { GitView } from './sections/view/git-view';
export { useStandaloneCapabilityNav } from './shared/standalone-settings-nav';
export { SettingsNavProvider } from '../internal/layout/settings-nav-context';
export type {
  AgentConfigSectionGroup,
  AgentConfigSectionKey,
} from './sections/view/agent-editor';
