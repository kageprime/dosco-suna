/**
 * The Google Antigravity subscription models as the model picker lists them:
 * one dedicated group with reasoning efforts, status badges, and availability.
 */
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_EFFORTS,
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_PROVIDER_NAME,
} from '@kortix/api-contract/antigravity';
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
  return {
    providerId: ANTIGRAVITY_PROVIDER_ID,
    name: ANTIGRAVITY_PROVIDER_NAME,
    connected,
    defaultModel: ANTIGRAVITY_DEFAULT_MODEL,
    models: ANTIGRAVITY_MODELS.map((model) => {
      const id = `${ANTIGRAVITY_PROVIDER_ID}/${model.id}`;
      return {
        id,
        name: model.name,
        description: model.description,
        limit: { context: model.context, output: model.output },
        efforts: [...ANTIGRAVITY_EFFORTS],
        defaultEffort: model.defaultEffort,
        badge: model.badge,
        unavailable: model.unavailable ?? false,
        requires: 'antigravity_subscription' as const,
        connected,
        enabled: !model.unavailable && modelAccessAllows(input.access, id) && (input.modelOverrides[id] ?? true),
      };
    }),
  };
}
