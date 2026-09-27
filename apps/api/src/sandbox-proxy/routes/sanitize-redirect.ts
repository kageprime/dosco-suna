// Rewrite an upstream redirect Location so the user stays on the preview.
// `redirectPrefix` is the URL prefix that maps to this sandbox port:
//   - subdomain previews (p{port}-{sandbox}.host):  '' (root-relative)
//   - path-based previews (/v1/p/{sandbox}/{port}):  '/v1/p/{sandbox}/{port}'
// App self-redirects (relative, or absolute to the upstream's own origin) are
// kept on the preview. Same-sandbox provider-host variants (E2B serves
// `<port>-<id>.<domain>` alongside bare `<id>.<domain>`, and apps bounce
// between them on login callbacks and trailing-slash normalizers) are folded
// back in via `opts.sandboxId` — without this the browser escapes to the raw
// provider host, whose token gate (e.g. `e2b-traffic-access-token`) the
// browser can never satisfy. Genuinely external redirects (OAuth, CDNs, …)
// pass through unchanged so the browser can follow them — we never
// hard-block, since blocking turned ordinary app redirects into 502s.
export function sanitizeRedirectLocation(
  previewUrl: string,
  location: string | null,
  redirectPrefix: string,
  opts: { sandboxId?: string; currentPort?: number } = {},
): string | null {
  if (!location) return null;
  if (location.startsWith('/') && !location.startsWith('//')) {
    return `${redirectPrefix}${location}`;
  }
  try {
    const target = new URL(location, previewUrl);
    const preview = new URL(previewUrl);
    const selfHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(target.hostname);
    if (target.origin === preview.origin || selfHost) {
      return `${redirectPrefix}${target.pathname}${target.search}${target.hash}`;
    }
    const sid = opts.sandboxId;
    if (sid && sid.length >= 12 && target.hostname.includes(sid)) {
      const suffix = `${target.pathname}${target.search}${target.hash}`;
      const explicit = target.port ? Number.parseInt(target.port, 10) : NaN;
      const prefixed = target.hostname.match(/^(\d+)-/);
      const port = Number.isNaN(explicit)
        ? prefixed
          ? Number.parseInt(prefixed[1], 10)
          : opts.currentPort
        : explicit;
      if (!port || port < 1 || port > 65535 || !Number.isInteger(port)) return location;
      if (redirectPrefix === '' && port === opts.currentPort) return suffix;
      return `/v1/p/${sid}/${port}${suffix}`;
    }
    return location;
  } catch {
    return null;
  }
}
