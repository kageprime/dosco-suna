/**
 * An internal-only feature flag (`catalogHidden`; none today) is written by a
 * platform operator only: `PATCH /v1/projects/:id/features` answers 403
 * `feature_operator_only` to a project owner. Flows that need a flag set as
 * the operator go through the operator route as the run-scoped platform admin.
 */
import type { FeatureFlagKey } from "@kortix/api-contract";
import type { FlowContext } from "../core/types";
import { asPlatformAdmin } from "./enterprise-access";


/** Sets (`true`/`false`) or clears (`null`) a flag as the platform operator. Asserts 200. */
export async function setFeatureAsOperator(
  ctx: FlowContext,
  projectId: string,
  feature: FeatureFlagKey,
  enabled: boolean | null,
): Promise<{ enabled: boolean }> {
  const response = await asPlatformAdmin(ctx).put(
    "/v1/admin/api/projects/:id/features",
    { feature, enabled },
    { params: { id: projectId } },
  );
  response.status(200);
  return response.json() as { enabled: boolean };
}
