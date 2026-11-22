/**
 * The preview location bridge.
 *
 * The session panel's Browser frames a sandbox port on its own origin
 * (`p{port}-{sandbox}.{previewDomain}`), so the frame is cross-origin to the
 * web app: the panel can read neither `contentWindow.location` nor the frame's
 * history. After a click inside the frame, the address bar kept the first URL
 * and Back left the site (D-05).
 *
 * This module adds one small inline script to a FRAMED HTML document. The
 * script posts the page's path to the Kortix web app that frames it. It reads
 * nothing else and accepts no messages. The panel owns Back/Forward itself and
 * reloads the frame at the remembered address.
 *
 * Blast radius, all gates required (`shouldInjectPreviewBridge`):
 *   - a `GET` that answered `text/html` with a body, UTF-8 or no charset, not
 *     encoded, and not a download (`Content-Disposition: attachment`);
 *   - `Sec-Fetch-Dest: iframe` — a top-level tab is never rewritten;
 *   - no CSP that governs scripts, so the script never causes a CSP violation
 *     and no app header is changed;
 *   - not a session-data port (the daemon), only user code;
 *   - at least one known web-app origin to post to.
 * Any page outside the gates behaves as before: the address bar keeps the URL
 * the panel loaded.
 *
 * The script removes its own `<script>` element as it runs, so the page's DOM
 * stays identical to what the app served and hydration sees no extra node.
 *
 * The script posts only to the allowlisted web-app origins (`postMessage`
 * targetOrigin), so a third-party site that frames a preview learns nothing.
 * It polls `location` every 250 ms instead of patching `history.pushState`:
 * the app's own globals stay untouched. Each report carries the frame's own
 * history position and slot, `navigation.currentEntry.index` and `.key`
 * (Navigation API; -1 and '' without it), and `history.length` as the
 * fallback signal. The panel mirrors
 * push, replace and traversal from them (`frame-history.ts`).
 */
import { carriesSessionData } from './session-data-ports';

/** The message type the panel listens for. Same string in
 *  `packages/ui/src/session/panel/easy/app-preview.tsx`. */
export const PREVIEW_LOCATION_MESSAGE = 'kortix:preview-location';

const POLL_MS = 250;

export function shouldInjectPreviewBridge(input: {
  method: string;
  status: number;
  upstreamPort: number;
  requestHeaders: Headers;
  responseHeaders: Headers;
  parentOrigins: string[];
}): boolean {
  const { method, status, upstreamPort, requestHeaders, responseHeaders, parentOrigins } = input;
  // Any HTML document the frame shows, an app's own 404/500 page included, so
  // a click to a broken link still moves the address bar. No-body and partial
  // answers are never rewritten.
  if (method.toUpperCase() !== 'GET' || status < 200 || NO_REWRITE_STATUSES.has(status)) return false;
  if (requestHeaders.get('sec-fetch-dest') !== 'iframe') return false;
  if (carriesSessionData(upstreamPort) || parentOrigins.length === 0) return false;
  const type = (responseHeaders.get('content-type') || '').toLowerCase();
  if (!type.startsWith('text/html')) return false;
  const charset = /charset\s*=\s*"?([^";\s]+)/.exec(type)?.[1];
  if (charset && charset !== 'utf-8' && charset !== 'utf8') return false;
  // A download is saved, not shown: its bytes must stay the app's own.
  if (/^\s*attachment/i.test(responseHeaders.get('content-disposition') || '')) return false;
  const encoding = (responseHeaders.get('content-encoding') || '').trim().toLowerCase();
  if (encoding && encoding !== 'identity') return false;
  for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
    if (governsScripts(responseHeaders.get(key) || '')) return false;
  }
  return true;
}

const NO_REWRITE_STATUSES = new Set([204, 205, 206, 304]);

/** True when a CSP has a directive that applies to inline scripts. A
 *  directive may end at a space, a `;`, a `,` or the end (an empty source list). */
function governsScripts(policy: string): boolean {
  return /(^|[;,\s])(script-src(-elem)?|default-src)(?=[\s;,]|$)/i.test(policy);
}

/** JSON that is safe inside an inline `<script>`. */
function scriptJson(value: unknown): string {
  // U+2028/U+2029 are legal in string literals since ES2019; only `<` can end the script.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * The inline script. `prefix` is the path-preview prefix (`/v1/p/{sandbox}/{port}`)
 * or '' on a preview origin; the parent receives the app's own path.
 */
export function previewBridgeScript(opts: { prefix: string; origins: string[] }): string {
  // The script removes its own element first, so the DOM a framework hydrates
  // is exactly the server's HTML (React 18 treats an extra <body> child as a
  // hydration mismatch).
  const body = `(function(){
var s=document.currentScript;if(s&&s.parentNode)s.parentNode.removeChild(s);
if(window.parent===window)return;
var T=${scriptJson(PREVIEW_LOCATION_MESSAGE)},P=${scriptJson(opts.prefix)},O=${scriptJson(opts.origins)},last=null;
function report(){
var p=location.pathname;
if(P&&p.indexOf(P)===0)p=p.slice(P.length)||'/';
p=p+location.search+location.hash;
var N=window.navigation,e=N&&N.currentEntry,x=e&&typeof e.index==='number'?e.index:-1,k=e&&typeof e.key==='string'?e.key:'';
if(p+'|'+x+'|'+k===last)return;
last=p+'|'+x+'|'+k;
for(var i=0;i<O.length;i++){try{window.parent.postMessage({type:T,path:p,length:history.length,index:x,key:k},O[i]);}catch(e){}}
}
if(window.navigation&&window.navigation.addEventListener)window.navigation.addEventListener('currententrychange',report);
addEventListener('popstate',report);
addEventListener('hashchange',report);
window.setInterval(report,${POLL_MS});
report();
})();`;
  return `<script>${body}</script>`;
}

/**
 * A framed and a top-level load of one HTML page get different bodies, so a
 * browser cache must key them apart. Every HTML answer (200 or other) and
 * every `304` carries `Vary: Sec-Fetch-Dest`; otherwise a page first cached
 * from a new tab would later fill the frame without the bridge.
 */
export function varyOnFetchDest(status: number, headers: Headers): void {
  const type = (headers.get('content-type') || '').toLowerCase();
  if (status !== 304 && !type.startsWith('text/html')) return;
  const vary = headers.get('vary') || '';
  if (/(^|,)\s*(\*|sec-fetch-dest)\s*(,|$)/i.test(vary)) return;
  headers.set('vary', vary ? `${vary}, Sec-Fetch-Dest` : 'Sec-Fetch-Dest');
}

/**
 * Streams `response` through with `script` at the start of `<body>`, or at the
 * end of a document that has no `<body>` tag.
 *
 * Two cases leave the bytes untouched, because the script would break them:
 *   - a UTF-16 document (byte-order mark), where ASCII script bytes are garbage;
 *   - a `<meta http-equiv="Content-Security-Policy">` that governs scripts,
 *     which would block the script, leave it in the DOM and log a violation.
 */
export async function injectPreviewBridge(response: Response, script: string): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  // The validators describe the app's bytes, not this body: a revalidation
  // answered `304` would reuse a body the browser may hold without the bridge.
  headers.delete('etag');
  headers.delete('last-modified');
  varyOnFetchDest(response.status, headers);
  const body = await peekBody(response.body);
  const init = { status: response.status, statusText: response.statusText, headers };
  if (body.utf16) return new Response(body.stream, init);
  let injected = false;
  let blocked = false;
  return new HTMLRewriter()
    .on('meta', {
      element(element) {
        const equiv = (element.getAttribute('http-equiv') || '').trim().toLowerCase();
        if (equiv === 'content-security-policy' && governsScripts(element.getAttribute('content') || '')) {
          blocked = true;
        }
      },
    })
    .on('body', {
      element(element) {
        if (injected || blocked) return;
        injected = true;
        element.prepend(script, { html: true });
      },
    })
    .onDocument({
      end(end) {
        if (!injected && !blocked) end.append(script, { html: true });
      },
    })
    .transform(new Response(body.stream, init));
}

/** Reads until it holds 2 bytes (or the end) to check for a UTF-16 byte-order
 *  mark, which a chunk boundary can split, and hands back a stream that still
 *  yields every byte unchanged. */
async function peekBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<{ stream: ReadableStream<Uint8Array> | null; utf16: boolean }> {
  if (!body) return { stream: null, utf16: false };
  const reader = body.getReader();
  const buffered: Uint8Array[] = [];
  let size = 0;
  let done = false;
  let failure: { reason: unknown } | null = null;
  try {
    while (size < 2) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }
      buffered.push(next.value);
      size += next.value.length;
    }
  } catch (reason) {
    // The upstream died in its first bytes: the client gets the same failing
    // stream an untouched response would give it, not a thrown route error.
    failure = { reason };
  }
  const bytes: number[] = [];
  for (const chunk of buffered) for (const byte of chunk) if (bytes.length < 2) bytes.push(byte);
  const utf16 = !failure && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
      if (failure) controller.error(failure.reason);
      else if (done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream, utf16 };
}
