import { config } from '../../config';
import { managedTransportAvailable } from '../resolution/descriptors';
import {
  FREE_MANAGED_MODELS,
  managedLineup,
  resolvePlatformDefaultModelId,
  type ManagedModel,
} from './managed-models';
import { platformDefaultFreeModelId } from './free-models';

export { platformDefaultFreeModelId };

function deduplicateModels(models: readonly ManagedModel[]): readonly ManagedModel[] {
  const seen = new Set<string>();
  const deduped: ManagedModel[] = [];
  for (const model of models) {
    if (!seen.has(model.id)) {
      seen.add(model.id);
      deduped.push(model);
    }
  }
  return deduped;
}

/**
 * The managed lineup this deployment can serve now: Platinum's list, plus
 * Dosco's free managed models when their transports are available.
 */
export function servedManagedModels(): readonly ManagedModel[] {
  return deduplicateModels([...managedLineup(), ...FREE_MANAGED_MODELS].filter(managedTransportAvailable));
}

/** The designated free models served on this deployment. */
export function servedFreeManagedModels(): readonly ManagedModel[] {
  return deduplicateModels(FREE_MANAGED_MODELS.filter(managedTransportAvailable));
}

/**
 * The platform default model this deployment can actually serve. Read this
 * anywhere a route ADVERTISES the default (`/model-picker`, `/model-defaults`)
 * or RESOLVES it (gateway routing) — never `config.LLM_GATEWAY_DEFAULT_MODEL`
 * directly, which is only what the operator asked for.
 */
export function platformDefaultModelId(): string {
  return resolvePlatformDefaultModelId(config.LLM_GATEWAY_DEFAULT_MODEL ?? '', servedManagedModels());
}

/** The platform vision model: the configured one when served, else the first served model that reads images. */
export function platformVisionModelId(): string {
  const configured = (config.LLM_GATEWAY_VISION_MODEL ?? '').trim();
  const served = servedManagedModels();
  if (configured && (configured.includes('/') || served.some((m) => m.id === configured && m.vision))) return configured;
  return served.find((m) => m.vision)?.id ?? configured;
}
