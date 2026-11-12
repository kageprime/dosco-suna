import type { ComposerOptions } from '../../session/composer/composer-chat-input';
import { modelKeyToWire, type SessionConnectorBindingsInput } from '@kortix/sdk';
import { isMyKortixAgentName, MY_KORTIX_SANDBOX_SLUG } from '@kortix/shared';

export interface NewSessionCreateInput {
  sandbox_slug?: string;
  agent_name?: string;
  /** The composer's launch model, gateway wire form — the create-time pin. */
  model?: string;
  connector_bindings?: SessionConnectorBindingsInput;
  inherit_unbound?: boolean;
  provider_secret_pools?: Record<string, string[]>;
}

/**
 * Build the session-create payload from the composer's send options.
 *
 * A project session chooses its boot agent at creation. The first prompt uses
 * the same agent so initial provisioning applies the intended grants. Later
 * prompts can switch agents after server-side re-scoping. The boot agent
 * defaults to "default" when none is set at create.
 *
 * `agent_name` therefore mirrors `options.agent` exactly: the create-time bind
 * and the first-prompt send read the same value, so they can never disagree.
 *
 * Returns `undefined` when there is nothing to bind (sandbox stays default and
 * no agent was picked), so callers can omit the create overrides entirely.
 */
export function buildNewSessionCreateInput(
  options: Pick<ComposerOptions, 'agent' | 'model' | 'scope' | 'providerSecretPools'> & {
    sandbox_slug?: string;
    } = {},
): NewSessionCreateInput | undefined {
  const input: NewSessionCreateInput = {};
  if (isMyKortixAgentName(options.agent)) {
    input.sandbox_slug = MY_KORTIX_SANDBOX_SLUG;
  } else if (options.sandbox_slug) {
    input.sandbox_slug = options.sandbox_slug;
  }
  if (options.agent) input.agent_name = options.agent;
  // The launch model as the create-time pin. Only riding `pending_prompt.model`
  // it never reaches the row: the server stamps the default chain, and the
  // session's selector then shows the project default while the session starts
  // even though the first turn runs on this pick. The same top-level `model`
  // the CLI and mobile send — the API validates servability and pins
  // `metadata.model` with `model_source: 'explicit'`, so the row carries the
  // launch model from the first read, before the runtime is up.
  if (options.model && options.model.modelID !== 'auto' && options.model.modelID !== 'kortix/auto') {
    input.model = modelKeyToWire(options.model);
  }
  if (options.providerSecretPools && Object.keys(options.providerSecretPools).length > 0) {
    input.provider_secret_pools = options.providerSecretPools;
  }
  if (
    options.scope?.availability.connector_bindings &&
    options.scope.draft.connector_bindings !== undefined &&
    options.scope.draft.connector_bindings_inherited !== true
  ) {
    input.connector_bindings = Object.fromEntries(
      Object.entries(options.scope.draft.connector_bindings).map(([alias, binding]) => [
        alias,
        {
          connection_id: binding.connection_id,
        },
      ]),
    );
    input.inherit_unbound = false;
  }
  return Object.keys(input).length > 0 ? input : undefined;
}
