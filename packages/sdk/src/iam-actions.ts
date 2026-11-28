export const PROJECT_ACTIONS = {
  PROJECT_READ: 'project.read',
  PROJECT_WRITE: 'project.write',
  /** Archiving the project (`DELETE /projects/:id`). Not implied by `project.write`. */
  PROJECT_DELETE: 'project.delete',
  // Change requests. Distinct from write so an agent can be granted
  // "open a CR" WITHOUT "merge it to the base branch" — merge is the canonical
  // destructive action (it lands code on main), and stays human/explicit.

  PROJECT_SESSION_READ: 'project.session.read',
  PROJECT_SESSION_START: 'project.session.start',
  PROJECT_SESSION_STOP: 'project.session.stop',
  PROJECT_SESSION_BINDINGS_WRITE: 'project.session.bindings.write',

  PROJECT_MEMBERS_READ: 'project.members.read',
  PROJECT_MEMBERS_MANAGE: 'project.members.manage',

  PROJECT_TRIGGER_READ: 'project.trigger.read',
  PROJECT_TRIGGER_CREATE: 'project.trigger.create',
  PROJECT_TRIGGER_UPDATE: 'project.trigger.update',
  PROJECT_TRIGGER_DELETE: 'project.trigger.delete',
  PROJECT_TRIGGER_FIRE: 'project.trigger.fire',

  PROJECT_GATEWAY_LOGS_READ: 'project.gateway.logs.read',
  PROJECT_GATEWAY_SPEND_READ: 'project.gateway.spend.read',
  PROJECT_USAGE_READ: 'project.usage.read',
  PROJECT_GATEWAY_BUDGET_SET: 'project.gateway.budget.set',
  PROJECT_GATEWAY_KEYS_MANAGE: 'project.gateway.keys.manage',

  // ── Per-capability leaf actions (IAM v1) ────────────────────────────────
  // Each project feature gets its own read/write leaf so a custom role can
  // DEACTIVATE one capability (omit the leaf) without losing the rest. Until a
  // route is migrated to assert these, it keeps gating on project.read/write,
  // so adding them is additive: every write leaf is also seeded into the Manager
  // built-in role and every read leaf into the User floor role (see
  // role-perms.ts), so no existing manager/user loses a capability. All resolve to 'project' scope
  // (prefix = 'project') via resourceTypeForAction.
  PROJECT_AGENT_READ: 'project.agent.read',
  PROJECT_AGENT_WRITE: 'project.agent.write',
  PROJECT_SKILL_READ: 'project.skill.read',
  PROJECT_SKILL_WRITE: 'project.skill.write',
  PROJECT_COMMAND_READ: 'project.command.read',
  // No API route writes a command: a command is a repository file, changed by
  // a git push (project.gitops.push). This leaf gates the web Edit control and
  // stays a valid name in kortix.yaml `kortix_permissions` lists.
  PROJECT_COMMAND_WRITE: 'project.command.write',
  PROJECT_FILE_READ: 'project.file.read',
  PROJECT_FILE_WRITE: 'project.file.write',
  // Project settings: name, description, icon, sandbox provider, feature
  // flags, the connected repository.
  /** Project settings: name, branch, manifest path, icon, sandbox provider, feature flags. */
  PROJECT_SETTINGS_WRITE: 'project.settings.write',
  // The project's sandbox environment: templates and snapshot rebuilds.
  PROJECT_SANDBOX_WRITE: 'project.sandbox.write',
  // Which models the project may use, its defaults, and gateway routing.
  PROJECT_MODEL_READ: 'project.model.read',
  PROJECT_MODEL_WRITE: 'project.model.write',
  PROJECT_GITOPS_READ: 'project.gitops.read',
  /** Opening a change request, and every push. */
  PROJECT_GITOPS_PUSH: 'project.gitops.push',
  /** Merging a change request into the base branch. */
  PROJECT_GITOPS_MERGE: 'project.gitops.merge',
  // Ref-level push authority, on top of `project.gitops.push`. The git proxy
  // scopes a SESSION credential to its own branch structurally — that binding
  // is the credential's identity, not a permission, and is never grantable.
  // These two leaves are what a principal needs to act OUTSIDE that lane, and
  // they are what a role or a `kortix_permissions` grant can hand to an agent
  // deliberately. Absent = denied: unlike the rest of the agent-grant fold, the
  // git path treats a null grant as "principal defaults", never "unrestricted".
  // See git-proxy/ref-policy.ts.
  PROJECT_GITOPS_REF_ANY: 'project.gitops.ref.any',
  PROJECT_GITOPS_REF_DELETE: 'project.gitops.ref.delete',
  PROJECT_SECRET_READ: 'project.secret.read',
  PROJECT_SECRET_WRITE: 'project.secret.write',
  PROJECT_CONNECTOR_READ: 'project.connector.read',
  PROJECT_CONNECTOR_CONNECTIONS_MANAGE: 'project.connector.connections.manage',
  PROJECT_CONNECTOR_WRITE: 'project.connector.write',

  // Kortix Apps, every kind. Apps used to borrow project.customize.write /
  // project.gitops.read, so a custom role could not grant or revoke Apps on its
  // own. These are the real leaves. `read` = list and inspect the Apps the
  // caller may see, connect, mint a member token. `write` = create, rename,
  // resize, delete an App, read and set the access policy. `deploy` = ship a
  // version, roll back, start, or stop, and read the operations view
  // (deployments, events, runtime logs, machines, volumes, snapshots) — the
  // action that changes what the public hostname serves, so it stays separable
  // from write exactly as project.gitops.merge is separable from
  // project.gitops.push. `admin` = the App-administration leaf; no route
  // requires it today.
  PROJECT_APP_READ: 'project.app.read',
  PROJECT_APP_WRITE: 'project.app.write',
  PROJECT_APP_DEPLOY: 'project.app.deploy',
  PROJECT_APP_ADMIN: 'project.app.admin',

  // Review Center. `read` = see the inbox (floor user). `submit` = an agent puts
  // an output / decision / batch up for human review (floor user + their agent).
  // `act` = approve / reject / request-changes / answer — a consequential
  // decision on agent work, so it sits with the manager tier (like gitops).
  PROJECT_REVIEW_READ: 'project.review.read',
  PROJECT_REVIEW_SUBMIT: 'project.review.submit',
  /** A verdict on a review item: approve, reject, request changes, answer. */
  PROJECT_REVIEW_ACT: 'project.review.act',

  // Artifacts: Files folders shared as docs and pages.
  // `read` = the gallery, open an artifact, its versions and files. `write` =
  // publish, share a folder, save, restore, and rename / share / unshare your
  // own. `manage` = change how anyone's artifact is shared. `public` = give an
  // artifact a public link: the one outward step, so a custom role or an
  // agent's `kortix_permissions` can withhold it on its own.
  PROJECT_ARTIFACT_READ: 'project.artifact.read',
  PROJECT_ARTIFACT_WRITE: 'project.artifact.write',
  PROJECT_ARTIFACT_MANAGE: 'project.artifact.manage',
  PROJECT_ARTIFACT_PUBLIC: 'project.artifact.public',

  // Issuing a project credential — a project CLI token (`POST|DELETE
  // /projects/:id/cli-token`) or a project-scoped PAT (`POST /accounts/tokens`
  // with a project_id). Its own leaf because a credential OUTLIVES the request
  // that minted it: until now these routes gated on the coarse `manage` alias,
  // which mapped to project.write, so anyone who could edit the project could
  // mint a long-lived token for it (routes.md §5.2). Seeded into Manager only.
  /** Minting a project CLI token or a project-scoped PAT. */
  PROJECT_CREDENTIALS_ISSUE: 'project.credentials.issue',
} as const;

export const WORKSPACE_ACTION_BY_LEGACY = {
  // ── account-scoped (31) ────────────────────────────────────────────────
  'account.read': 'workspace.account.read',
  'account.write': 'workspace.account.write',
  'account.delete': 'workspace.account.delete',
  'billing.read': 'workspace.billing.read',
  'billing.write': 'workspace.billing.write',
  'audit.read': 'workspace.audit.read',
  'member.read': 'workspace.member.read',
  'member.invite': 'workspace.member.invite',
  'member.update': 'workspace.member.update',
  'member.remove': 'workspace.member.remove',
  'member.super_admin.grant': 'workspace.member.super_admin.grant',
  'group.read': 'workspace.group.read',
  'group.create': 'workspace.group.create',
  'group.update': 'workspace.group.update',
  'group.delete': 'workspace.group.delete',
  'group.members.manage': 'workspace.group.members.manage',
  'policy.read': 'workspace.policy.read',
  'policy.create': 'workspace.policy.create',
  'policy.delete': 'workspace.policy.delete',
  'role.read': 'workspace.role.read',
  'role.create': 'workspace.role.create',
  'role.update': 'workspace.role.update',
  'role.delete': 'workspace.role.delete',
  'token.read': 'workspace.token.read',
  'token.create': 'workspace.token.create',
  'token.revoke': 'workspace.token.revoke',
  'token.personal.create': 'workspace.token.personal.create',
  'token.personal.revoke': 'workspace.token.personal.revoke',
  'project.create': 'workspace.create',
  'capture.read_all': 'workspace.capture.read_all',
  'capture.manage': 'workspace.capture.manage',

  // ── project-scoped (54) ────────────────────────────────────────────────
  'project.read': 'workspace.read',
  'project.write': 'workspace.write',
  'project.delete': 'workspace.delete',
  'project.session.read': 'workspace.session.read',
  'project.session.start': 'workspace.session.start',
  'project.session.stop': 'workspace.session.stop',
  'project.session.bindings.write': 'workspace.session.bindings.write',
  'project.members.read': 'workspace.members.read',
  'project.members.manage': 'workspace.members.manage',
  'project.trigger.read': 'workspace.trigger.read',
  'project.trigger.create': 'workspace.trigger.create',
  'project.trigger.update': 'workspace.trigger.update',
  'project.trigger.delete': 'workspace.trigger.delete',
  'project.trigger.fire': 'workspace.trigger.fire',
  'project.gateway.logs.read': 'workspace.gateway.logs.read',
  'project.gateway.spend.read': 'workspace.gateway.spend.read',
  'project.usage.read': 'workspace.usage.read',
  'project.gateway.budget.set': 'workspace.gateway.budget.set',
  'project.gateway.keys.manage': 'workspace.gateway.keys.manage',
  'project.agent.read': 'workspace.agent.read',
  'project.agent.write': 'workspace.agent.write',
  'project.skill.read': 'workspace.skill.read',
  'project.skill.write': 'workspace.skill.write',
  'project.command.read': 'workspace.command.read',
  'project.command.write': 'workspace.command.write',
  'project.file.read': 'workspace.file.read',
  'project.file.write': 'workspace.file.write',
  'project.settings.write': 'workspace.settings.write',
  'project.sandbox.write': 'workspace.sandbox.write',
  'project.model.read': 'workspace.model.read',
  'project.model.write': 'workspace.model.write',
  'project.gitops.read': 'workspace.gitops.read',
  'project.gitops.push': 'workspace.gitops.push',
  'project.gitops.merge': 'workspace.gitops.merge',
  'project.gitops.ref.any': 'workspace.gitops.ref.any',
  'project.gitops.ref.delete': 'workspace.gitops.ref.delete',
  'project.secret.read': 'workspace.secret.read',
  'project.secret.write': 'workspace.secret.write',
  'project.connector.read': 'workspace.connector.read',
  'project.connector.connections.manage': 'workspace.connector.connections.manage',
  'project.connector.write': 'workspace.connector.write',
  'project.app.read': 'workspace.app.read',
  'project.app.write': 'workspace.app.write',
  'project.app.deploy': 'workspace.app.deploy',
  'project.app.admin': 'workspace.app.admin',
  'project.review.read': 'workspace.review.read',
  'project.review.submit': 'workspace.review.submit',
  'project.review.act': 'workspace.review.act',
  'project.artifact.read': 'workspace.artifact.read',
  'project.artifact.write': 'workspace.artifact.write',
  'project.artifact.manage': 'workspace.artifact.manage',
  'project.artifact.public': 'workspace.artifact.public',
  'project.credentials.issue': 'workspace.credentials.issue',
} as const;
