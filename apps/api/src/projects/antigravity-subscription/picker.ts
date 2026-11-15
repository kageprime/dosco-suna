/**
 * The Google Antigravity subscription models as the model picker lists them:
 * one dedicated group with reasoning efforts, status badges, and availability.
 */
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_PROVIDER_NAME,
} from '@kortix/api-contract/antigravity';
import { resolveAntigravityCredential } from '../../llm-gateway/credentials/antigravity';
import { fetchAvailableAntigravityModels } from '../../llm-gateway/credentials/antigravity-cloudcode';
import { countUsableAntigravityAccounts } from './accounts';
import { modelAccessAllows, type ProjectModelAccess } from '../../llm-gateway/model-access';

export async function antigravitySubscriptionPickerGroup(input: {
  accountId: string;
  projectId: string;
  userId: string;
  access: ProjectModelAccess;
  modelOverrides: Record<string, boolean>;
}) {
  const connected = (await countUsableAntigravityAccounts(input.accountId, input.projectId, input.userId).catch(() => 0)) > 0;
  let models = ANTIGRAVITY_MODELS;
  if (connected) {
    const credential = await resolveAntigravityCredential(input.projectId, input.userId, input.accountId).catch(() => null);
    if (credential?.access) {
      const liveModels = await fetchAvailableAntigravityModels(credential.access, credential.project).catch(() => null);
      if (liveModels?.length) models = liveModels;
    }
  }
  return {
    providerId: ANTIGRAVITY_PROVIDER_ID,
    name: ANTIGRAVITY_PROVIDER_NAME,
    connected,
    defaultModel: ANTIGRAVITY_DEFAULT_MODEL,
    models: models.map((model) => {
      const id = `${ANTIGRAVITY_PROVIDER_ID}/${model.id}`;
      return {
        id,
        name: model.name,
        description: model.description,
        limit: { context: model.context, output: model.output },
        efforts: model.efforts ? [...model.efforts] : [],
        defaultEffort: model.defaultEffort,
        badge: model.badge,
        unavailable: model.unavailable ?? false,
        requires: 'antigravity_subscription' as const,
        connected,
        enabled: modelAccessAllows(input.access, id) && (input.modelOverrides[id] ?? true),
      };
    }),
  };
}
