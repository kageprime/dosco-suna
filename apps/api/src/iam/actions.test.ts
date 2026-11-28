import { expect, test } from 'bun:test';
import { PROJECT_ACTIONS as CANONICAL_ACTIONS } from '@kortix/sdk/iam-actions';
import { ACTION_CATALOG, PROJECT_ACTIONS, VALID_ACTIONS, isKnownAction, resourceTypeForAction } from './actions';

const expected: [string, string][] = [["PROJECT_READ","project.read"],["PROJECT_WRITE","project.write"],["PROJECT_DELETE","project.delete"],["PROJECT_SESSION_READ","project.session.read"],["PROJECT_SESSION_START","project.session.start"],["PROJECT_SESSION_STOP","project.session.stop"],["PROJECT_SESSION_BINDINGS_WRITE","project.session.bindings.write"],["PROJECT_MEMBERS_READ","project.members.read"],["PROJECT_MEMBERS_MANAGE","project.members.manage"],["PROJECT_TRIGGER_READ","project.trigger.read"],["PROJECT_TRIGGER_CREATE","project.trigger.create"],["PROJECT_TRIGGER_UPDATE","project.trigger.update"],["PROJECT_TRIGGER_DELETE","project.trigger.delete"],["PROJECT_TRIGGER_FIRE","project.trigger.fire"],["PROJECT_GATEWAY_LOGS_READ","project.gateway.logs.read"],["PROJECT_GATEWAY_SPEND_READ","project.gateway.spend.read"],["PROJECT_USAGE_READ","project.usage.read"],["PROJECT_GATEWAY_BUDGET_SET","project.gateway.budget.set"],["PROJECT_GATEWAY_KEYS_MANAGE","project.gateway.keys.manage"],["PROJECT_AGENT_READ","project.agent.read"],["PROJECT_AGENT_WRITE","project.agent.write"],["PROJECT_SKILL_READ","project.skill.read"],["PROJECT_SKILL_WRITE","project.skill.write"],["PROJECT_COMMAND_READ","project.command.read"],["PROJECT_COMMAND_WRITE","project.command.write"],["PROJECT_FILE_READ","project.file.read"],["PROJECT_FILE_WRITE","project.file.write"],["PROJECT_SETTINGS_WRITE","project.settings.write"],["PROJECT_SANDBOX_WRITE","project.sandbox.write"],["PROJECT_MODEL_READ","project.model.read"],["PROJECT_MODEL_WRITE","project.model.write"],["PROJECT_GITOPS_READ","project.gitops.read"],["PROJECT_GITOPS_PUSH","project.gitops.push"],["PROJECT_GITOPS_MERGE","project.gitops.merge"],["PROJECT_GITOPS_REF_ANY","project.gitops.ref.any"],["PROJECT_GITOPS_REF_DELETE","project.gitops.ref.delete"],["PROJECT_SECRET_READ","project.secret.read"],["PROJECT_SECRET_WRITE","project.secret.write"],["PROJECT_CONNECTOR_READ","project.connector.read"],["PROJECT_CONNECTOR_CONNECTIONS_MANAGE","project.connector.connections.manage"],["PROJECT_CONNECTOR_WRITE","project.connector.write"],["PROJECT_APP_READ","project.app.read"],["PROJECT_APP_WRITE","project.app.write"],["PROJECT_APP_DEPLOY","project.app.deploy"],["PROJECT_APP_ADMIN","project.app.admin"],["PROJECT_REVIEW_READ","project.review.read"],["PROJECT_REVIEW_SUBMIT","project.review.submit"],["PROJECT_REVIEW_ACT","project.review.act"],["PROJECT_ARTIFACT_READ","project.artifact.read"],["PROJECT_ARTIFACT_WRITE","project.artifact.write"],["PROJECT_ARTIFACT_MANAGE","project.artifact.manage"],["PROJECT_ARTIFACT_PUBLIC","project.artifact.public"],["PROJECT_CREDENTIALS_ISSUE","project.credentials.issue"]];

test('pins the ordered live project actions and API catalog contract', () => {
  expect(JSON.stringify(Object.entries(PROJECT_ACTIONS))).toBe(JSON.stringify(expected));
  for (const [, action] of expected) {
    expect(VALID_ACTIONS.has(action)).toBe(true);
    expect(ACTION_CATALOG.find((entry) => entry.action === action)).toEqual({
      action,
      workspaceAction: `workspace.${action.slice('project.'.length)}`,
      label: action.split('.').map((part) => part[0]?.toUpperCase() + part.slice(1).replace(/_/g, ' ')).join(' · '),
      resourceType: 'project',
    });
  }
  expect(resourceTypeForAction('project.create')).toBe('account');
  expect(resourceTypeForAction('workspace.create')).toBe('account');
  for (const action of ['project.room.read', 'project.room.write', 'constructor', 'workspace.unknown']) {
    expect(isKnownAction(action)).toBe(false);
  }
});

test('the API consumes the lightweight live catalog object', () => {
  expect(PROJECT_ACTIONS).toBe(CANONICAL_ACTIONS);
});
