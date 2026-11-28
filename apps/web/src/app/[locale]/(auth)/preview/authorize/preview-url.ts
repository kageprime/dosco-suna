/**
 * True only for a URL on a hostname this deployment serves previews on.
 *
 * The template gives the exact origin shape; we compare the host SUFFIX and the
 * label form rather than string-matching the whole URL, because the port and
 * sandbox vary. Anything else — another domain, a lookalike, a path on our own
 * app — is refused.
 */
export function isServablePreviewUrl(candidate: string, template: string | null): boolean {
  if (!template) return false;
  let url: URL;
  let shape: URL;
  try {
    url = new URL(candidate);
    shape = new URL(template.replace('{port}', '1').replace('{sandbox}', 'x'));
  } catch {
    return false;
  }
  if (url.protocol !== shape.protocol) return false;

  // `dev-p{port}-{sandbox}.p.kortix.com` -> suffix `.p.kortix.com`, prefix `dev-`
  const shapeHost = shape.hostname;
  const firstDot = shapeHost.indexOf('.');
  if (firstDot === -1) return false;
  const domain = shapeHost.slice(firstDot); // ".p.kortix.com"
  const envPrefix = shapeHost.slice(0, shapeHost.indexOf('-p1-') + 1); // "dev-"
  if (!envPrefix || !domain) return false;
  if (!url.hostname.endsWith(domain)) return false;

  const label = url.hostname.slice(0, -domain.length);
  if (label.includes('.')) return false;
  return new RegExp(`^${envPrefix}p\\d{1,5}-[a-z0-9-]+$`).test(label);
}
