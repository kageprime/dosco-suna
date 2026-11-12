/**
 * Namespaces the template-row predecessor reaper can delete without a
 * data-plane ownership check. `kpp2-` is intentionally absent. Its first key
 * identifies the owning data plane, but this reaper does not receive or prove
 * that identity. The ownership-aware per-project reaper handles scoped images;
 * Daytona quota GC provides the pressure backstop on that provider.
 *
 * `kortix-default-` is absent too. The platform default's name carries no
 * environment, project or region, so two deployments that share a provider
 * org (dev and staging share one Platinum org) compute the same name for the
 * same runtime. One deployment's "superseded" default can be the image the
 * other still serves: on 2026-11-11 dev reaped `kortix-default-c9bd85a7e4c0`
 * 19 minutes before the staging release gate waited for it, and the gate timed
 * out after 15 minutes. The database the reaper checks cannot see another
 * deployment's rows, so it must not delete a shared name.
 */
const REAPABLE_TEMPLATE_PREDECESSOR_PREFIXES = [
  'kortix-tpl-',
  'kortix-wproj-',
  'kortix-ppwarm-',
] as const;

export function isReapableTemplatePredecessor(snapshotName: string): boolean {
  return REAPABLE_TEMPLATE_PREDECESSOR_PREFIXES.some((prefix) =>
    snapshotName.startsWith(prefix),
  );
}
