import { connectorDerivedState, connectorDisplayName, type AdminConnector } from '@kortix/sdk';

import type { SecretRow } from '../../customize/sections/view/secrets-view';

/**
 * One step of a workspace's setup that only a person can do: sign in to a
 * connector, set a required secret, add Kortix to Slack. The setup page
 * (`/workspaces/<id>/setup`) lists them; `kortix onboard --wait` polls the
 * same three facts (`pendingSetup` in the CLI), so the page and the terminal
 * agree on what is left.
 */
export type SetupStep =
  | { kind: 'connector'; id: string; name: string; done: boolean; broken: boolean; connector: AdminConnector }
  | { kind: 'secret'; id: string; name: string; done: boolean; row: SecretRow }
  | { kind: 'slack'; id: 'slack'; name: string; done: boolean };

/** A channel or the computer connector has no sign-in of its own here: Slack is its own step. */
function isSignInConnector(connector: AdminConnector): boolean {
  return connector.provider !== 'channel' && connector.provider !== 'computer';
}

/** The workspace uses Slack: the setup asked for it (`?slack=1`), or kortix.yaml declares the Slack channel. */
export function slackNeeded(connectors: AdminConnector[], requested: boolean): boolean {
  return requested || connectors.some((c) => c.provider === 'channel' && c.platform === 'slack');
}

/**
 * The steps, the open ones first, each group in kortix.yaml order. A connector
 * that is switched off (`enabled: false`) is not a step: nothing uses it.
 */
export function setupSteps({
  connectors,
  secrets,
  slack,
  slackName,
}: {
  connectors: AdminConnector[];
  secrets: SecretRow[];
  slack: { needed: boolean; installed: boolean };
  slackName: string;
}): SetupStep[] {
  const steps: SetupStep[] = [];
  for (const connector of connectors) {
    if (!isSignInConnector(connector) || connector.status === 'disabled' || connector.state === 'disabled') continue;
    const state = connectorDerivedState(connector);
    const done = state === 'connected' || (state === null && connector.status === 'active');
    steps.push({
      kind: 'connector',
      id: `connector:${connector.slug}`,
      name: connectorDisplayName(connector),
      done,
      broken: state === 'error',
      connector,
    });
  }
  for (const row of secrets) {
    if (row.requirement !== 'required') continue;
    steps.push({ kind: 'secret', id: `secret:${row.identifier}`, name: row.key, done: row.configured, row });
  }
  if (slack.needed) steps.push({ kind: 'slack', id: 'slack', name: slackName, done: slack.installed });
  return [...steps.filter((step) => !step.done), ...steps.filter((step) => step.done)];
}

/**
 * The required open steps this viewer can finish. Installed connectors are optional.
 * A required secret needs secret write; Slack needs connector write.
 * Task-requested connector sign-ins live in the session transcript instead.
 */
export function openStepsFor(steps: SetupStep[], can: { connect: boolean; setSecrets: boolean }): SetupStep[] {
  return steps.filter((step) => !step.done && step.kind !== 'connector' && (step.kind === 'secret' ? can.setSecrets : can.connect));
}
