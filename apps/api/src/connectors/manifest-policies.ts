import { areValidConditions, isValidMatcher, MAX_POLICY_SETS_PER_CONNECTOR, MAX_RULES_PER_POLICY_SET, POLICY_SETS_UNSUPPORTED_PROVIDERS, policySetNameError } from '@kortix/manifest-schema';
import { type DefaultMode, type ProjectPolicySpec, extractProjectPolicies, projectPoliciesToManifestEntries, projectPolicySettingsToManifest, type ConnectorPolicyAction, type ConnectorPolicySpec, extractConnectors, extractAgents, grantsByAgent, loadManifestForEdit } from '../projects/surface';
import { type RulesMatrix, rulesMatrix } from './agent-rules-matrix';
import { normalizeConditions } from './policy';
import { canonicalConnectorAlias } from '../shared/connector-alias';
import { loadRow, mutateProjectConnectorManifest, type CrudResult } from './manifest-mutation';

const CONNECTOR_POLICY_ACTIONS: readonly ConnectorPolicyAction[] = [
  'always_run',
  'require_approval',
  'block',
];

/** One manifest rule → the API shape, conditions kept. */
function ruleFromManifest(p: Record<string, unknown>): ConnectorPolicySpec {
  const conditions =
    p.conditions !== undefined && p.conditions !== null && areValidConditions(p.conditions)
      ? normalizeConditions(p.conditions)
      : null;
  return {
    match: String(p.match),
    action: p.action as ConnectorPolicyAction,
    ...(conditions && conditions.length > 0 ? { conditions } : {}),
  };
}

function rulesFromManifest(raw: unknown): ConnectorPolicySpec[] {
  return (Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [])
    .filter((p) => p && typeof p.match === 'string')
    .map(ruleFromManifest);
}

export function connectorEntries(manifest: { raw: Record<string, unknown> }): Record<string, unknown>[] {
  return Array.isArray(manifest.raw.connectors)
    ? (manifest.raw.connectors as Record<string, unknown>[])
    : [];
}

function policySetsOf(entry: Record<string, unknown>): Record<string, Record<string, unknown>> | null {
  const sets = entry.policy_sets;
  return sets && typeof sets === 'object' && !Array.isArray(sets)
    ? (sets as Record<string, Record<string, unknown>>)
    : null;
}

/**
 * Read a single connector's rules from kortix.yaml (source of truth): the base
 * `policies:`, or one set's rules when `policySet` is given. `policySetFound`
 * is false when the connector exists but defines no such set.
 */
export async function getConnectorPoliciesFromManifest(
  projectId: string,
  slug: string,
  policySet?: string | null,
): Promise<{ policies: ConnectorPolicySpec[]; policySetFound?: boolean } | null> {
  const row = await loadRow(projectId);
  if (!row) return null;
  const manifest = await loadManifestForEdit(row).catch(() => null);
  if (!manifest) return { policies: [], ...(policySet ? { policySetFound: false } : {}) };
  const entry = connectorEntries(manifest).find((c) => c?.slug === slug);
  if (!entry) return null;
  if (!policySet) return { policies: rulesFromManifest(entry.policies) };
  const sets = policySetsOf(entry);
  const set = sets && Object.hasOwn(sets, policySet) ? sets[policySet] : undefined;
  return { policies: rulesFromManifest(set?.policies), policySetFound: set !== undefined };
}

/** Validate an API rule list. Returns the clean manifest rules or a 400. */
function cleanRules(
  policies: ConnectorPolicySpec[],
): { ok: true; rules: Record<string, unknown>[] } | { ok: false; error: string; status: 400 } {
  if (!Array.isArray(policies)) return { ok: false, error: '`policies` must be an array', status: 400 };
  const rules: Record<string, unknown>[] = [];
  for (const [i, p] of policies.entries()) {
    if (!p || !p.match || typeof p.match !== 'string')
      return { ok: false, error: `rule #${i + 1}: \`match\` is required`, status: 400 };
    if (!isValidMatcher(p.match.trim()))
      return { ok: false, error: `rule #${i + 1}: invalid regex pattern`, status: 400 };
    if (!CONNECTOR_POLICY_ACTIONS.includes(p.action)) {
      return {
        ok: false,
        error: `rule #${i + 1}: \`action\` must be ${CONNECTOR_POLICY_ACTIONS.join(' | ')}`,
        status: 400,
      };
    }
    // Conditions are written back, never dropped: dropping one turns a
    // conditional rule into an unconditional one.
    if (p.conditions !== undefined && p.conditions !== null && !areValidConditions(p.conditions)) {
      return { ok: false, error: `rule #${i + 1}: invalid \`conditions\``, status: 400 };
    }
    const conditions = normalizeConditions(p.conditions) ?? [];
    rules.push({
      match: p.match.trim(),
      action: p.action,
      ...(conditions.length > 0 ? { conditions } : {}),
    });
  }
  return { ok: true, rules };
}

/**
 * Replace a connector's rules in kortix.yaml, commit, re-sync (→
 * connector_policies / connector_policy_sets, which the gateway enforces).
 * Without `policySet` it replaces the base `policies:`; with it, the rules of
 * that set, which must exist (404 `policy_set_not_found`).
 */
export async function setConnectorPoliciesInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  policies: ConnectorPolicySpec[],
  policySet?: string | null,
): Promise<CrudResult> {
  const clean = cleanRules(policies);
  if (!clean.ok) return clean;
  if (policySet && clean.rules.length > MAX_RULES_PER_POLICY_SET) {
    return { ok: false, error: `at most ${MAX_RULES_PER_POLICY_SET} rules per policy set`, status: 400 };
  }

  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the connector ${slug} policies were being updated`,
    (manifest) => {
      const current = connectorEntries(manifest);
      const entry = current.find((candidate) => candidate?.slug === slug);
      if (!entry) return { ok: false, error: 'connector not found', status: 404 };

      if (policySet) {
        const sets = policySetsOf(entry);
        if (!sets || !Object.hasOwn(sets, policySet)) return policySetNotFound(slug, policySet);
        const set = { ...(sets[policySet] ?? {}) };
        if (clean.rules.length) set.policies = clean.rules;
        else delete set.policies;
        sets[policySet] = set;
      } else if (clean.rules.length) entry.policies = clean.rules;
      else delete entry.policies;
      manifest.raw.connectors = current;

      const error = extractConnectors(manifest).errors.find(
        (candidate) => candidate.slug === slug,
      );
      if (error) return { ok: false, error: error.error, status: 400 };
      return {
        ok: true,
        commitMessage: policySet
          ? `chore: update ${slug} policy set ${policySet}`
          : `chore: update ${slug} permissions`,
      };
    },
    slug,
  );
}

// ─── Policy sets (`connectors[].policy_sets` + `agents.<a>.policy_sets`) ────

function policySetError(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return { ok: false as const, error, status, code, body: { error, code, ...extra } };
}

function policySetNotFound(slug: string, name: string) {
  return policySetError(404, 'policy_set_not_found', `connector "${slug}" has no policy set "${name}"`);
}

/** The map-shaped (v2/v3) agent blocks of a manifest; empty for v1. */
export function agentBlocks(manifest: { raw: Record<string, unknown> }): Record<string, unknown>[] {
  const agents = manifest.raw.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return [];
  return Object.values(agents as Record<string, unknown>).filter(
    (block): block is Record<string, unknown> => !!block && typeof block === 'object' && !Array.isArray(block),
  );
}

/**
 * Rewrite an agent block's `policy_sets` entry for `slug` (either alias
 * spelling). `next` gets the current set name and returns the new one, or
 * null to remove the entry. An emptied map is removed.
 */
export function rewriteAgentPolicySet(
  block: Record<string, unknown>,
  slug: string,
  next: (current: string) => string | null,
): void {
  const map = block.policy_sets;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  const sets = map as Record<string, unknown>;
  const wanted = canonicalConnectorAlias(slug);
  for (const key of Object.keys(sets)) {
    if (canonicalConnectorAlias(key) !== wanted) continue;
    const value = next(String(sets[key]));
    if (value === null) delete sets[key];
    else sets[key] = value;
  }
  if (Object.keys(sets).length === 0) delete block.policy_sets;
}

/** Agent names whose `policy_sets` assign set `name` on connector `slug`. */
export function agentsUsingPolicySet(
  manifest: { raw: Record<string, unknown> },
  slug: string,
  name: string,
): string[] {
  const agents = manifest.raw.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return [];
  const wanted = canonicalConnectorAlias(slug);
  return Object.entries(agents as Record<string, unknown>)
    .filter(([, block]) => {
      const map = (block as Record<string, unknown> | null)?.policy_sets;
      if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
      return Object.entries(map as Record<string, unknown>).some(
        ([key, value]) => canonicalConnectorAlias(key) === wanted && value === name,
      );
    })
    .map(([agent]) => agent)
    .sort();
}

/** Shared guard: a connector that may carry sets. */
function policySetTarget(
  manifest: { raw: Record<string, unknown> },
  slug: string,
):
  | { ok: true; current: Record<string, unknown>[]; entry: Record<string, unknown> }
  | ReturnType<typeof policySetError> {
  const current = connectorEntries(manifest);
  const entry = current.find((candidate) => candidate?.slug === slug);
  if (!entry) return policySetError(404, 'connector_not_found', 'connector not found');
  const provider = typeof entry.provider === 'string' ? entry.provider.trim().toLowerCase() : '';
  if ((POLICY_SETS_UNSUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    return policySetError(400, 'policy_sets_unsupported', `${provider} connectors cannot carry policy sets`);
  }
  return { ok: true, current, entry };
}

function checkSetName(name: string) {
  const problem = policySetNameError(name);
  return problem ? policySetError(400, 'invalid_policy_set_name', problem) : null;
}

/** The sets of one connector as kortix.yaml declares them, with the agents using each. */
export async function listConnectorPolicySetsFromManifest(
  projectId: string,
  slug: string,
): Promise<{
  sets: Array<{ name: string; description: string | null; policies: ConnectorPolicySpec[] }>;
  agents: Record<string, string[]>;
} | null> {
  const row = await loadRow(projectId);
  if (!row) return null;
  const manifest = await loadManifestForEdit(row).catch(() => null);
  if (!manifest) return null;
  const entry = connectorEntries(manifest).find((c) => c?.slug === slug);
  if (!entry) return null;
  const sets = Object.entries(policySetsOf(entry) ?? {}).map(([name, set]) => ({
    name,
    description: typeof set?.description === 'string' && set.description.trim() ? set.description.trim() : null,
    policies: rulesFromManifest(set?.policies),
  }));
  const agents: Record<string, string[]> = Object.create(null);
  for (const set of sets) agents[set.name] = agentsUsingPolicySet(manifest, slug, set.name);
  return { sets, agents };
}

/**
 * Create a set, or change its description. Rules are written through
 * `setConnectorPoliciesInManifest(…, policySet)`, the one rule writer.
 * `description: null` or `''` removes the description; undefined keeps it.
 */
export async function upsertConnectorPolicySetInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  name: string,
  description: string | null | undefined,
  /** Replace the set's rules in the same commit (a template). */
  policies?: Array<{ match: string; action: ConnectorPolicyAction }>,
): Promise<CrudResult & { created?: boolean }> {
  const bad = checkSetName(name);
  if (bad) return bad;
  let created = false;
  const result = await mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the policy set ${slug}/${name} was being saved`,
    (manifest) => {
      const target = policySetTarget(manifest, slug);
      if (!target.ok) return target;
      const sets = policySetsOf(target.entry) ?? {};
      created = !Object.hasOwn(sets, name);
      if (created && Object.keys(sets).length >= MAX_POLICY_SETS_PER_CONNECTOR) {
        return policySetError(400, 'policy_set_limit', `at most ${MAX_POLICY_SETS_PER_CONNECTOR} policy sets per connector`);
      }
      const set = { ...(sets[name] ?? {}) };
      if (description !== undefined) {
        if (description && description.trim()) set.description = description.trim();
        else delete set.description;
      }
      if (policies) set.policies = policies.map((rule) => ({ match: rule.match, action: rule.action }));
      if (!created && description === undefined && !policies) return { ok: true, commitMessage: null };
      sets[name] = set;
      target.entry.policy_sets = sets;
      manifest.raw.connectors = target.current;
      const error = extractConnectors(manifest).errors.find((candidate) => candidate.slug === slug);
      if (error) return { ok: false, error: error.error, status: 400 };
      return {
        ok: true,
        commitMessage: created ? `chore: add ${slug} policy set ${name}` : `chore: update ${slug} policy set ${name}`,
      };
    },
    slug,
  );
  return result.ok ? { ...result, created } : result;
}

/**
 * Rename a set and every `agents.<a>.policy_sets` reference to it, in one
 * commit, so no agent ever points at a missing set (which blocks).
 */
export async function renameConnectorPolicySetInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  from: string,
  to: string,
): Promise<CrudResult> {
  const bad = checkSetName(to);
  if (bad) return bad;
  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the policy set ${slug}/${from} was being renamed`,
    (manifest) => {
      const target = policySetTarget(manifest, slug);
      if (!target.ok) return target;
      const sets = policySetsOf(target.entry);
      if (!sets || !Object.hasOwn(sets, from)) return policySetNotFound(slug, from);
      if (from === to) return { ok: true, commitMessage: null };
      if (Object.hasOwn(sets, to)) {
        return policySetError(409, 'policy_set_exists', `connector "${slug}" already has a policy set "${to}"`);
      }
      // Rebuild to keep the authoring order: the renamed set stays in place.
      target.entry.policy_sets = Object.fromEntries(
        Object.entries(sets).map(([key, value]) => [key === from ? to : key, value]),
      );
      for (const block of agentBlocks(manifest)) {
        rewriteAgentPolicySet(block, slug, (current) => (current === from ? to : current));
      }
      manifest.raw.connectors = target.current;
      return { ok: true, commitMessage: `chore: rename ${slug} policy set ${from} to ${to}` };
    },
    slug,
  );
}

/**
 * Delete a set. Refused with 409 `policy_set_in_use` while an agent uses it.
 * The check runs inside the compare-and-swap callback, over the manifest that
 * gets committed, so a concurrent assignment cannot slip in between.
 */
export async function deleteConnectorPolicySetInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  name: string,
): Promise<CrudResult> {
  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the policy set ${slug}/${name} was being deleted`,
    (manifest) => {
      const target = policySetTarget(manifest, slug);
      if (!target.ok) return target;
      const sets = policySetsOf(target.entry);
      if (!sets || !Object.hasOwn(sets, name)) return policySetNotFound(slug, name);
      const agents = agentsUsingPolicySet(manifest, slug, name);
      if (agents.length > 0) {
        return policySetError(
          409,
          'policy_set_in_use',
          `policy set "${name}" is used by ${agents.map((a) => `"${a}"`).join(', ')}. Give those agents another set first.`,
          { agents },
        );
      }
      delete sets[name];
      if (Object.keys(sets).length === 0) delete target.entry.policy_sets;
      manifest.raw.connectors = target.current;
      return { ok: true, commitMessage: `chore: delete ${slug} policy set ${name}` };
    },
    slug,
  );
}

// ─── Project-level policies (top-level `policies:` list + `policy:` block) ──

export interface ProjectPoliciesView {
  policies: ProjectPolicySpec[];
  defaultMode: DefaultMode;
  errors: Array<{ path: string; error: string }>;
  /** Per-connector tool-call rule counts, from the same manifest (KRTX-2527):
   *  `policy <slug> set` must be visible to the parent `policy ls` too. */
  connectorRules: Array<{ slug: string; count: number }>;
}

/** Read the project's `policies:` list + `policy:` block (kortix.yaml = source of truth). */
export async function getProjectPoliciesFromManifest(
  projectId: string,
): Promise<ProjectPoliciesView | null> {
  const row = await loadRow(projectId);
  if (!row) return null;
  const manifest = await loadManifestForEdit(row).catch(() => null);
  if (!manifest)
    return { policies: [], defaultMode: 'allow_all', errors: [], connectorRules: [] };
  const parsed = extractProjectPolicies(manifest);
  const connectorSpecs = extractConnectors(manifest).specs;
  return {
    policies: parsed.policies,
    defaultMode: parsed.settings.defaultMode,
    errors: parsed.errors,
    connectorRules: connectorSpecs
      .filter((spec) => spec.policies.length > 0)
      .map((spec) => ({ slug: spec.slug, count: spec.policies.length })),
  };
}

/**
 * Replace the WHOLE `policies:` list + `policy.default_mode` in kortix.yaml,
 * commit, and re-sync so the runtime tables reflect the new posture. The UI is
 * an ordered list; "save" PUTs the whole list back. Per-rule add/edit/delete
 * remain client-side until commit.
 */
export async function setProjectPoliciesInManifest(
  projectId: string,
  accountId: string,
  policies: ProjectPolicySpec[],
  defaultMode: DefaultMode,
): Promise<CrudResult> {
  // Validate against the parser before writing — same rules the runtime enforces.
  for (const [i, p] of policies.entries()) {
    if (!p.match || typeof p.match !== 'string') {
      return { ok: false, error: `policy #${i + 1}: \`match\` is required`, status: 400 };
    }
    if (p.action !== 'always_run' && p.action !== 'require_approval' && p.action !== 'block') {
      return {
        ok: false,
        error: `policy #${i + 1}: \`action\` must be always_run | require_approval | block`,
        status: 400,
      };
    }
    // Also checked at the route, re-checked here because this is the function
    // that WRITES kortix.yaml — a bad condition committed to the manifest would
    // come back on every sync, and an unevaluable rule silently loses its
    // restriction rather than failing loudly.
    if (p.conditions !== undefined && p.conditions !== null && !areValidConditions(p.conditions)) {
      return {
        ok: false,
        error: `policy #${i + 1}: invalid \`conditions\``,
        status: 400,
      };
    }
  }
  if (defaultMode !== 'risk' && defaultMode !== 'allow_all') {
    return { ok: false, error: '`default_mode` must be risk | allow_all', status: 400 };
  }

  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    'the project connector policies were being updated',
    (manifest) => {
      const entries = projectPoliciesToManifestEntries(policies);
      if (entries.length > 0) manifest.raw.policies = entries;
      else delete manifest.raw.policies;

      const settingsBlock = projectPolicySettingsToManifest({ defaultMode });
      if (settingsBlock) manifest.raw.policy = settingsBlock;
      else delete manifest.raw.policy;

      return { ok: true, commitMessage: 'chore: update connector policies' };
    },
  );
}

/**
 * Every declared agent × every connector profile, from kortix.yaml (the source
 * of truth): granted, and the rule set each runs under. Null: no project, or
 * the manifest cannot be read.
 */
export async function rulesMatrixFromManifest(projectId: string): Promise<RulesMatrix | null> {
  const row = await loadRow(projectId);
  if (!row) return null;
  const manifest = await loadManifestForEdit(row).catch(() => null);
  if (!manifest) return null;
  const connectors = connectorEntries(manifest)
    .filter((entry) => typeof entry?.slug === 'string')
    .map((entry) => ({
      slug: String(entry.slug),
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : String(entry.slug),
      policy_sets: Object.keys(policySetsOf(entry) ?? {}).sort(),
    }));
  return rulesMatrix(connectors, grantsByAgent(extractAgents(manifest)));
}
