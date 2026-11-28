import { dispatchChat } from './chat-dispatch';

import { admitChat } from './admission';
import { respond } from './chat-response';
import type { ChatCompletionRequest, HandlerRuntime } from './chat-shared';
import { routeChat } from './routing';
export { authorize, bearer, billingRefusal, identity, passthroughHeaders, refundHold, requestId } from './chat-shared';
export type { ChatCompletionRequest, GatewayDeps, HandlerRuntime } from './chat-shared';

export async function handleChatCompletions(runtime: HandlerRuntime, req: ChatCompletionRequest): Promise<Response> {
  const admitted = await admitChat(runtime, req);
  if (admitted instanceof Response) return admitted;
  let body: Record<string, unknown> | null = admitted.body;
  // The phase result must not retain the parsed graph during upstream prefill.
  admitted.body = {};
  const routed = await routeChat(runtime, admitted);
  if (routed instanceof Response) return routed;
  const pending = dispatchChat(runtime, req, admitted, routed, body);
  body = null;
  const dispatched = await pending;
  return respond({
    runtime, req, id: admitted.id, emit: admitted.emit, principal: routed.principal,
    requestedModel: admitted.requestedModel, routedModel: routed.routedModel,
    routeModel: routed.routeModel, resolvedCandidates: routed.resolvedCandidates,
    sentRequestBytes: admitted.sentRequestBytes, ...dispatched,
  });
}
