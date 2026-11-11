import { resolveCatalogUpstream } from '../llm-gateway/models/provider-registry';

/**
 * The env-var name a provider's pooled credential must use. The runtime
 * catalog (models.dev) names most providers; a subscription provider the
 * catalog does not carry pins its fixed secret name here, mirroring the
 * provider set `subscription-connections` lists (`'codex'`, `'claude-agent'`,
 * `'antigravity'`). Without it a pooled Antigravity resource can never be
 * created, so the connect flow's fallback write always 400s.
 */
export function expectedSecretResourceName(providerId: string): string | undefined {
  if (providerId === 'antigravity') return 'ANTIGRAVITY_AUTH_JSON';
  return resolveCatalogUpstream(providerId)?.envVar;
}
