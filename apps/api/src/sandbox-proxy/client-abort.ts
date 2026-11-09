import { classifyRuntimeRequest, stripInBoxProxyPrefix } from './runtime-request';
import { carriesSessionData } from './session-data-ports';

/**
 * The runtime session a client asked to abort, or `null` when this request is
 * not that call.
 *
 * Every client that stops a turn — web, mobile, SDK, CLI — does it with
 * `POST /kortix/runtime/sessions/:id/abort` or the box's OpenCode-shaped
 * `POST /session/:id/abort` through this proxy. An abort the daemon
 * issues itself (memory guard, queue interrupt, runaway guard) never passes
 * here, which is what makes this the place to record that a stop was ASKED FOR:
 * the end frame that follows is the same "Aborted" either way.
 *
 * Pure + exported so it is unit-tested without provisioning a box, like
 * `isTurnStartEnvSync`.
 */
export function clientAbortTarget(port: number, method: string, path: string): string | null {
  if (port !== 8000) return null;
  const request = classifyRuntimeRequest(method, path);
  return request.kind === 'abort' ? request.runtimeSessionId : null;
}

/**
 * The conversation a fork starts from (`POST /session/:id/fork`), or `null`.
 *
 * ONE parser for the two call sites that care: the stopped-sandbox gate in
 * `forward-to-sandbox.ts` (refuse the fork before any wake) and the record a
 * successful fork registers after the response. The two used to parse with
 * different regexes — the gate accepted the in-box `/proxy/<n>/` prefix, a
 * trailing slash and a query tail that the post-response extractor did not —
 * so a fork on a prefixed path was refused-if-stopped yet never registered its
 * record. Both go through here now.
 *
 * Pure + exported so it is unit-tested without provisioning a box, like
 * `clientAbortTarget`.
 */
export function parseForkPath(port: number, method: string, path: string): string | null {
  if (!carriesSessionData(port) || method.toUpperCase() !== 'POST') return null;
  return /^\/?session\/([^/?#]+)\/fork\/?(?:$|[?#])/.exec(stripInBoxProxyPrefix(path))?.[1] ?? null;
}

/**
 * The message a client asked OpenCode to rewind to (`POST /session/:id/revert`
 * `{messageID}`): `''` when the body names none, `null` when this request is
 * not a rewind.
 */
export function clientRevertMessage(port: number, method: string, path: string, body: ArrayBuffer | undefined): string | null {
  if (port !== 8000 || classifyRuntimeRequest(method, path).kind !== 'revert') return null;
  try {
    const parsed = body?.byteLength ? (JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>) : null;
    return typeof parsed?.messageID === 'string' ? parsed.messageID : '';
  } catch {
    return '';
  }
}
