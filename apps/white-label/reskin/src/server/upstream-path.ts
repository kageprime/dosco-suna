/**
 * The upstream base every server route forwards to — ONE documented env chain.
 *
 * Six routes each carried their own copy of this function and the chains
 * drifted apart; two of the drifts were live 404 incidents:
 *
 * - `session-model` read only `KORTIX_API_URL`, so on any deployment that
 *   configured the documented variable every model change went to the PUBLIC
 *   api and 404'd.
 * - `connections` read only the public origin too, and swallowed the failure
 *   as "no connectors" — an empty picker with no error anywhere.
 *
 * `KORTIX_UPSTREAM` (`.env.example`, wrapper mode) is always first.
 * `NEXT_PUBLIC_KORTIX_API_URL` is the documented DIRECT-mode origin and is the
 * second fallback so the one server route that also serves direct mode
 * (`/api/preview-url`) reaches the same origin the browser was given.
 * `KORTIX_API_URL` is documented nowhere and is deliberately not honored: a
 * chain that reads it silently bypasses the documented setup.
 */
export function upstreamBase(): string {
  return (
    process.env.KORTIX_UPSTREAM ??
    process.env.NEXT_PUBLIC_KORTIX_API_URL ??
    'https://api.kortix.com/v1'
  ).replace(/\/+$/, '');
}
