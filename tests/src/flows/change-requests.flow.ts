/**
 * Change requests — git-backed CR lifecycle on a project. Maps to spec §… (CR-1..12).
 *
 * Scope: a fresh project has only `main` and no session branch, so we cannot
 * drive a real merge (that needs a session branch + a funded sandbox). We assert
 * the create-validation surface, the read endpoints, and the access boundaries —
 * all against real handlers. A bogus `head_ref` fails branch-tip resolution
 * (resolveBranchTip throws → 400). Unknown :crId → 404.
 */
import { ChangeRequestListSchema } from "@kortix/api-contract";
import { assert } from "../core/expect";
import { flow } from "../core/flow";
import type { FlowContext } from "../core/types";
import { AgentPrincipalsWorld, assertDenial, git } from "../fixtures/agent-principals";
import { CliSandbox } from "../fixtures/cli";
import { serveFixtureRepoLocally } from "../fixtures/local-git";

const RANDOM_UUID = "00000000-0000-4000-a000-0000000000c1";

flow(
  "CR-1",
  { domain: "change-requests", tags: ["smoke"], routes: ["GET /v1/workspaces/:projectId/change-requests"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER lists change requests → 200 with the contract ChangeRequestList envelope", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:projectId/change-requests", { params: { projectId: p.id } });
      r.status(200).body().exists("$.change_requests").schema(ChangeRequestListSchema);
    });
    await ctx.step("invalid status filter → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:projectId/change-requests", { params: { projectId: p.id }, query: { status: "wizard" } });
      r.status(400);
    });
  },
);

flow(
  "CR-2",
  { domain: "change-requests", routes: ["POST /v1/workspaces/:projectId/change-requests"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("missing title → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:projectId/change-requests", { head_ref: "feature" }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("missing head_ref → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/:projectId/change-requests", { title: ctx.fixtures.name("cr") }, { params: { projectId: p.id } });
      r.status(400);
    });
    await ctx.step("base_ref == head_ref → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/workspaces/:projectId/change-requests",
        { title: ctx.fixtures.name("cr"), head_ref: "main", base_ref: "main" },
        { params: { projectId: p.id } },
      );
      r.status(400);
    });
    await ctx.step("nonexistent head_ref → branch-tip resolution fails → 400/404/409", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/workspaces/:projectId/change-requests",
        { title: ctx.fixtures.name("cr"), head_ref: "ke2e/does-not-exist" },
        { params: { projectId: p.id } },
      );
      r.status([400, 404, 409]);
    });
  },
);

flow(
  "CR-3",
  { domain: "change-requests", routes: ["GET /v1/workspaces/:projectId/change-requests/:crId"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("unknown crId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:projectId/change-requests/:crId", { params: { projectId: p.id, crId: RANDOM_UUID } });
      r.status(404);
    });
  },
);

flow(
  "CR-4",
  { domain: "change-requests", routes: ["PATCH /v1/workspaces/:projectId/change-requests/:crId"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("patch unknown crId → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch(
        "/v1/workspaces/:projectId/change-requests/:crId",
        { title: "renamed" },
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(404);
    });
  },
);

flow(
  "CR-5",
  { domain: "change-requests", routes: ["GET /v1/workspaces/:projectId/change-requests/:crId/diff"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("diff for unknown crId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:projectId/change-requests/:crId/diff", { params: { projectId: p.id, crId: RANDOM_UUID } });
      r.status(404);
    });
  },
);

flow(
  "CR-6",
  { domain: "change-requests", routes: ["GET /v1/workspaces/:projectId/change-requests/:crId/merge-preview"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("merge-preview for unknown crId → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId/change-requests/:crId/merge-preview", {
        params: { projectId: p.id, crId: RANDOM_UUID },
      });
      r.status(404);
    });
  },
);

flow(
  "CR-7",
  { domain: "change-requests", routes: ["POST /v1/workspaces/:projectId/change-requests/:crId/merge"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("merge unknown crId → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/workspaces/:projectId/change-requests/:crId/merge",
        {},
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(404);
    });
  },
);

flow(
  "CR-8",
  {
    domain: "change-requests",
    routes: [
      "POST /v1/workspaces/:projectId/change-requests/:crId/close",
      "POST /v1/workspaces/:projectId/change-requests/:crId/reopen",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("close unknown crId → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/workspaces/:projectId/change-requests/:crId/close",
        {},
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(404);
    });
    await ctx.step("reopen unknown crId → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/workspaces/:projectId/change-requests/:crId/reopen",
        {},
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(404);
    });
  },
);

flow(
  "CR-11",
  { domain: "change-requests", routes: ["GET /v1/workspaces/:projectId/change-requests"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("NONMEMBER cannot list → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/workspaces/:projectId/change-requests", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("NONMEMBER cannot create → 403/404", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).post(
        "/v1/workspaces/:projectId/change-requests",
        { title: "nope", head_ref: "feature" },
        { params: { projectId: p.id } },
      );
      r.status([403, 404]);
    });
  },
);

// KRTX-2316: the list is one page plus a cursor; the 500 ceiling refuses, it
// no longer clamps. Cursor completeness over real rows is the DB suite
// `integration-change-requests-list-filters` (a CR needs a session branch).
flow(
  "CR-13",
  { domain: "change-requests", routes: ["GET /v1/workspaces/:projectId/change-requests"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    const get = (query: Record<string, string>) =>
      ctx.client.as(ctx.P.OWNER).get("/v1/workspaces/:projectId/change-requests", { params: { projectId: p.id }, query });
    await ctx.step("no limit → 200 one page; the contract requires next_cursor (null on the last page)", async () => {
      const r = await get({});
      r.status(200).body().schema(ChangeRequestListSchema);
      const body = r.json<{ change_requests: unknown[]; next_cursor?: string | null }>();
      assert({
        kind: "body.has",
        description: "next_cursor is present, at most 50 rows",
        expected: "next_cursor key, ≤ 50 rows",
        actual: { keys: Object.keys(body), rows: body.change_requests.length },
        pass: "next_cursor" in body && body.change_requests.length <= 50,
      });
    });
    await ctx.step("limit=500 → 200; limit=501 → 400 (the ceiling refuses, it does not clamp)", async () => {
      (await get({ status: "all", limit: "500" })).status(200).body().schema(ChangeRequestListSchema);
      (await get({ status: "all", limit: "501" })).status(400);
    });
    await ctx.step("limit=0 and a word → 400; a cursor that is not a CR number → 400; a number cursor → 200", async () => {
      (await get({ limit: "0" })).status(400);
      (await get({ limit: "many" })).status(400);
      (await get({ cursor: "abc" })).status(400);
      (await get({ cursor: "1" })).status(200).body().has("$.next_cursor", null);
    });
  },
);

flow(
  "CR-12",
  { domain: "change-requests", routes: ["GET /v1/workspaces/:projectId/change-requests"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("ANON cannot list → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/workspaces/:projectId/change-requests", { params: { projectId: p.id } });
      r.status(401);
    });
  },
);

// CR-8b — request-changes (Review Center "request changes" on an open CR,
// change-requests.ts). `feedback` is validated BEFORE the CR lookup (so a missing feedback
// is 400 even against an unknown crId); an unknown crId is 404. A real CR
// needs a session branch + a funded sandbox this suite can't cheaply drive
// (see the file header), so — like CR-3..CR-8 — we assert the real validation
// + not-found boundaries against a fresh project with no CRs.
flow(
  "CR-8b",
  {
    domain: "change-requests",
    routes: ["POST /v1/workspaces/:projectId/change-requests/:crId/request-changes"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("missing feedback → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/workspaces/:projectId/change-requests/:crId/request-changes",
        {},
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(400);
    });
    await ctx.step("unknown crId (feedback present) → 404", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post(
        "/v1/workspaces/:projectId/change-requests/:crId/request-changes",
        { feedback: "please fix the thing" },
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status(404);
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client.as(ctx.P.NONMEMBER).post(
        "/v1/workspaces/:projectId/change-requests/:crId/request-changes",
        { feedback: "please fix the thing" },
        { params: { projectId: p.id, crId: RANDOM_UUID } },
      );
      r.status([403, 404]);
    });
  },
);

/**
 * CR-14 — a merge that carries another open request's commits marks that
 * request merged (KRTX-3371). Merging the top of a stack fast-forwards the
 * base past every request below it; those used to stay `open` forever while
 * `cr show` already said "Already at base".
 */
flow(
  "CR-14",
  {
    domain: "change-requests",
    requires: ["database"],
    routes: [
      "POST /v1/workspaces/:projectId/change-requests",
      "POST /v1/workspaces/:projectId/change-requests/:crId/merge",
      "GET /v1/workspaces/:projectId/change-requests/:crId",
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== "local") return; // the branches are pushed straight to the bare repository
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Client: PgClient } = await import("pg");
    const project = await ctx.fixtures.project({ managedGit: true });
    const params = { projectId: project.id };
    const owner = ctx.client.as(ctx.P.OWNER);
    const db = new PgClient({ connectionString: ctx.env.databaseUrl! });
    await db.connect();
    const work = mkdtempSync(join(tmpdir(), "ke2e-cr14-"));
    const open = async (head: string) => {
      const r = await owner.post("/v1/workspaces/:projectId/change-requests", { title: `ke2e ${head}`, head_ref: head }, { params });
      r.status([200, 201]);
      return r.json<{ change_request?: { cr_id: string; number: number }; cr_id?: string; number?: number }>();
    };
    const idOf = (created: Awaited<ReturnType<typeof open>>) => created.change_request ?? { cr_id: created.cr_id!, number: created.number! };
    try {
      let stackedLow = { cr_id: "", number: 0 };
      let stackedTop = { cr_id: "", number: 0 };
      let unrelated = { cr_id: "", number: 0 };
      await ctx.step("push a, b on top of a, and an unrelated c; open a request for each", async () => {
        const { rows } = await db.query("SELECT repo_url, default_branch FROM kortix.projects WHERE project_id = $1", [project.id]);
        const base = String(rows[0]?.default_branch || "main");
        const git = (...a: string[]) => execFileSync("git", a, { cwd: work, stdio: "pipe" });
        const commit = (file: string) => {
          writeFileSync(join(work, file), `${file}\n`);
          git("add", "-A");
          git("-c", "user.name=KE2E", "-c", "user.email=ke2e@kortix.invalid", "commit", "-qm", file);
        };
        git("clone", "-q", "--branch", base, String(rows[0]?.repo_url), ".");
        git("checkout", "-q", "-b", "ke2e-cr14-a");
        commit("a.txt");
        git("push", "-q", "origin", "ke2e-cr14-a");
        git("checkout", "-q", "-b", "ke2e-cr14-b");
        commit("b.txt");
        git("push", "-q", "origin", "ke2e-cr14-b");
        git("checkout", "-q", base);
        git("checkout", "-q", "-b", "ke2e-cr14-c");
        commit("c.txt");
        git("push", "-q", "origin", "ke2e-cr14-c");
        stackedLow = idOf(await open("ke2e-cr14-a"));
        stackedTop = idOf(await open("ke2e-cr14-b"));
        unrelated = idOf(await open("ke2e-cr14-c"));
      });

      await ctx.step("merging b names a's request in also_merged; a reads merged, c stays open", async () => {
        const merged = await owner.post(
          "/v1/workspaces/:projectId/change-requests/:crId/merge",
          {},
          { params: { ...params, crId: stackedTop.cr_id } },
        );
        merged.status(200).body().has("$.change_request.status", "merged");
        const result = merged.json<{ merge: { merge_commit_sha: string }; also_merged?: Array<{ number: number }> }>();
        const also = result.also_merged ?? [];
        if (JSON.stringify(also.map((cr) => cr.number)) !== JSON.stringify([stackedLow.number])) {
          throw new Error(`also_merged ${JSON.stringify(also)}, expected only #${stackedLow.number}`);
        }
        const read = (crId: string) => owner.get("/v1/workspaces/:projectId/change-requests/:crId", { params: { ...params, crId } });
        (await read(stackedLow.cr_id))
          .status(200)
          .body()
          .has("$.change_request.status", "merged")
          .has("$.change_request.merge_commit_sha", result.merge.merge_commit_sha);
        (await read(unrelated.cr_id)).status(200).body().has("$.change_request.status", "open");
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
      await db.end();
    }
  },
);

// ── CR-15 / CR-16 — what a merge may land on the base branch ─────────────────
// Agent sessions come from the AGP fixture (tests/src/fixtures/agent-principals.ts):
// the local profile has no sandbox, so it reproduces the production token row.

/** A synthetic GitHub-shaped token, assembled at runtime so this file carries no scanner-flagged literal. */
const fakeGithubToken = (): string =>
  ["ghp", Array.from({ length: 36 }, (_, i) => "aB3dE5gH7jK9mN2pQ4sT6vW8yZ"[(i * 7) % 26]).join("")].join("_");

const crManifest = (connectors: string[]) =>
  [
    "project:",
    "  name: example-org-cr-guard",
    "default_agent: kortix",
    "agents:",
    "  kortix: {}",
    "  builder:",
    '    kortix_permissions: ["project.read", "project.write", "project.gitops.read", "project.gitops.push", "project.gitops.merge", "project.agent.write"]',
    "  curator:",
    '    kortix_permissions: ["project.read", "project.write", "project.gitops.read", "project.gitops.push", "project.gitops.merge", "project.connector.write"]',
    ...(connectors.length ? ["connectors:"] : []),
    ...connectors.flatMap((slug) => [`  - slug: ${slug}`, "    provider: mcp", `    url: https://${slug}.example.test/mcp`]),
    "",
  ].join("\n");

const CR_GUARD_ROUTES = [
  "POST /v1/accounts/tokens",
  "GET /v1/accounts/:accountId/iam/agent-identities",
  "GET /v1/connectors/workspaces/:projectId/catalog",
  "GET /v1/git/:project/info/refs",
  "POST /v1/git/:project/git-upload-pack",
  "POST /v1/git/:project/git-receive-pack",
  "POST /v1/workspaces/:projectId/change-requests",
  "POST /v1/workspaces/:projectId/change-requests/:crId/merge",
  "GET /v1/workspaces/:projectId/change-requests/:crId",
];

/** A governed project served over the Git proxy, and the git helpers both flows use. */
async function crGuardWorld(ctx: FlowContext, label: string, opts: { enterprise?: boolean; connectors: string[] }) {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const team = await ctx.fixtures.team(opts.enterprise ? { enterprise: true } : undefined);
  const project = await team.project({ managedGit: true });
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  await world.localRepoPath();
  await world.writeManifest(crManifest(opts.connectors));
  const builder = await world.mintAgentSession({ agent: "builder", launcher: ctx.P.OWNER });
  const curator = await world.mintAgentSession({ agent: "curator", launcher: ctx.P.OWNER });
  const server = await serveFixtureRepoLocally(ctx, world.db, project.id, label);
  const work = await mkdtemp(join(tmpdir(), `ke2e-${label.toLowerCase()}-`));
  const remote = `${ctx.env.apiUrl.replace(/\/v1$/, "")}/v1/git/${project.id}`;
  const auth = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${builder.secret}` };
  const agentGit = (args: string[]) => git(args, { cwd: work, env: auth });
  await agentGit(["clone", remote, "."]);
  const params = { projectId: project.id };
  const crPath = "/v1/workspaces/:projectId/change-requests";
  return {
    team,
    project,
    world,
    builder,
    curator,
    work,
    params,
    agentGit,
    path: (file: string) => join(work, file),
    /** Start the builder's branch from the current main. */
    fromMain: async () => {
      await agentGit(["fetch", "-q", "origin", "main"]);
      await agentGit(["reset", "-q", "--hard", "origin/main"]);
    },
    /** Commit everything and force-push the builder's session branch. */
    pushBranch: async (message: string) => {
      await agentGit(["add", "-A"]);
      await agentGit(["-c", "user.name=builder", "-c", "user.email=builder@example.test", "commit", "-q", "-m", message]);
      await agentGit(["push", "-q", "-f", "origin", `HEAD:refs/heads/${builder.sessionId}`]);
    },
    openCr: async (title: string) => {
      const r = await builder.client.post(crPath, { title, head_ref: builder.sessionId }, { params });
      r.status(201);
      const body = r.json<{ cr_id: string; number: number }>();
      return { crId: String(body.cr_id), number: Number(body.number) };
    },
    merge: (client: { post: (typeof builder.client)["post"] }, crId: string, body: Record<string, unknown> = {}) =>
      client.post(`${crPath}/:crId/merge`, body, { params: { ...params, crId } }),
    readCr: (crId: string) => world.owner.get(`${crPath}/:crId`, { params: { ...params, crId } }),
    mainFile: async (file: string): Promise<string | null> => {
      await agentGit(["fetch", "-q", "origin", "main"]);
      return agentGit(["show", `origin/main:${file}`]).catch(() => null);
    },
    close: async () => {
      const { rm } = await import("node:fs/promises");
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(work, { recursive: true, force: true });
      await world.close();
    },
  };
}

/**
 * CR-15 — a merge needs the permission a direct connector write needs. A
 * customer reported an agent session that deleted a connector from
 * kortix.yaml; the change-request merge asked nothing about connectors, so a
 * principal refused `DELETE …/connectors/:slug` could land the same deletion
 * through a merge.
 */
flow(
  "CR-15",
  {
    domain: "change-requests",
    requires: ["database"],
    timeoutMs: 300_000,
    routes: [
      ...CR_GUARD_ROUTES,
      "POST /v1/accounts/:accountId/iam/roles",
      "POST /v1/accounts/:accountId/iam/policies",
      "DELETE /v1/connectors/projects/:projectId/connectors/:slug",
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== "local") return; // the manifest is committed straight to the bare repository
    const { readFile, writeFile } = await import("node:fs/promises");
    const w = await crGuardWorld(ctx, "CR-15", { enterprise: true, connectors: ["desk", "crm", "ops"] });
    const owner = ctx.client.as(ctx.P.OWNER);
    const dropConnector = async (slug: string) => {
      const current = await readFile(w.path("kortix.yaml"), "utf8");
      const edited = current.replace(new RegExp(` {2}- slug: ${slug}\\n(?: {4}.*\\n)+`), "");
      if (edited === current) throw new Error(`kortix.yaml has no connector ${slug} to drop`);
      await writeFile(w.path("kortix.yaml"), edited);
    };
    const mainHas = async (slug: string) => (await w.mainFile("kortix.yaml"))?.includes(`slug: ${slug}`) ?? false;
    try {
      // A person whose custom role merges but does not write connectors.
      const merger = await w.team.addMember("member");
      await ctx.step("a custom role with project.gitops.merge and no project.connector.write is bound to a member", async () => {
        await w.team.grantProjectRole(w.project.id, merger.userId!, "member");
        const key = `crmerge_${w.team.id.replace(/-/g, "").slice(0, 10)}`;
        const role = await owner.post(
          "/v1/accounts/:accountId/iam/roles",
          { key, name: key, resourceType: "project", actions: ["project.read", "project.gitops.read", "project.gitops.merge"] },
          { params: { accountId: w.team.id } },
        );
        role.status(201);
        (await owner.post(
          "/v1/accounts/:accountId/iam/policies",
          { principalType: "member", principalId: merger.userId, roleId: role.json<{ role_id: string }>().role_id, scopeType: "project", scopeId: w.project.id },
          { params: { accountId: w.team.id } },
        )).status(201);
      });

      await ctx.step("control: `builder` (merge, no connector write) merges a README-only change request → 200", async () => {
        await writeFile(w.path("README.md"), "# example-org\n\nagent note\n");
        await w.pushBranch("docs: agent note");
        const cr = await w.openCr("Agent note");
        (await w.merge(w.builder.client, cr.crId)).status(200).body().has("$.change_request.status", "merged");
      });

      let dropDesk = { crId: "", number: 0 };
      await ctx.step("`builder` merging a change request that deletes connector desk → 403 agent_scope_insufficient (project.connector.write); main keeps desk", async () => {
        await w.fromMain();
        await dropConnector("desk");
        await w.pushBranch("connectors: drop desk");
        dropDesk = await w.openCr("Drop desk");
        assertDenial(await w.merge(w.builder.client, dropDesk.crId), "agent_scope_insufficient", "project.connector.write");
        if (!(await mainHas("desk"))) throw new Error("a refused merge removed desk from main");
      });

      await ctx.step("`curator` (merge + project.connector.write) merges the same change request → 200; main no longer has desk", async () => {
        (await w.merge(w.curator.client, dropDesk.crId)).status(200).body().has("$.change_request.status", "merged");
        if (await mainHas("desk")) throw new Error("main still declares desk after the merge");
      });

      await ctx.step("control: the member merges a README-only change request → 200", async () => {
        await w.fromMain();
        await writeFile(w.path("README.md"), "# example-org\n\nsecond note\n");
        await w.pushBranch("docs: second note");
        const cr = await w.openCr("Second note");
        // IAM caches refresh within 15 s: a fresh policy can answer 403 first.
        const deadline = Date.now() + 20_000;
        let r = await w.merge(ctx.client.as(merger), cr.crId);
        while (r.statusCode === 403 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          r = await w.merge(ctx.client.as(merger), cr.crId);
        }
        r.status(200).body().has("$.change_request.status", "merged");
      });

      let dropCrm = { crId: "", number: 0 };
      await ctx.step("the member is refused the direct delete of crm → 403 (project.connector.write)", async () => {
        const r = await ctx.client.as(merger).del("/v1/connectors/projects/:projectId/connectors/:slug", { params: { ...w.params, slug: "crm" } });
        r.status(403).body().has("$.action", "project.connector.write");
      });

      await ctx.step("the member merging a change request that deletes crm → 403 project_role_insufficient (project.connector.write); main keeps crm", async () => {
        await w.fromMain();
        await dropConnector("crm");
        await w.pushBranch("connectors: drop crm");
        dropCrm = await w.openCr("Drop crm");
        const r = await w.merge(ctx.client.as(merger), dropCrm.crId);
        r.status(403).body().has("$.action", "project.connector.write");
        if (!(await mainHas("crm"))) throw new Error("a refused merge removed crm from main");
      });

      await ctx.step("the owner merges the same change request → 200; main no longer has crm", async () => {
        (await w.merge(owner, dropCrm.crId)).status(200).body().has("$.change_request.status", "merged");
        if (await mainHas("crm")) throw new Error("main still declares crm after the merge");
      });
    } finally {
      await w.close();
    }
  },
);

/**
 * CR-16 — a merge never lands a key a change adds. A customer reported an
 * agent session that committed a hard-coded API key into the workspace
 * repository. The merge refuses a change whose commits add a provider-shaped
 * key: 409 with file, line, commit and rule, never the value. A person may
 * merge anyway; an agent session may not.
 */
flow(
  "CR-16",
  {
    domain: "change-requests",
    requires: ["database"],
    timeoutMs: 300_000,
    routes: [
      ...CR_GUARD_ROUTES,
      "POST /v1/accounts/:accountId/iam/service-accounts",
      "POST /v1/accounts/:accountId/iam/assignments",
      "POST /v1/workspaces/:workspaceId/tokens",
    ],
  },
  async (ctx) => {
    if (ctx.env.target !== "local") return; // the manifest is committed straight to the bare repository
    const { mkdir, writeFile } = await import("node:fs/promises");
    const w = await crGuardWorld(ctx, "CR-16", { enterprise: true, connectors: [] });
    const owner = ctx.client.as(ctx.P.OWNER);
    const token = fakeGithubToken();
    const cli = new CliSandbox("cr16");
    const agentEnv = { KORTIX_TOKEN: w.builder.secret, KORTIX_PROJECT_ID: w.project.id, KORTIX_API_URL: ctx.env.apiUrl };
    const noValue = (text: string) => {
      if (text.includes(token) || text.includes(token.slice(4, 16))) throw new Error(`the response carries the token: ${text.slice(0, 300)}`);
    };
    let leak = { crId: "", number: 0 };
    let headCommit = "";
    try {
      await ctx.step("`builder` pushes src/config.ts with a hard-coded GitHub token and opens a change request", async () => {
        await mkdir(w.path("src"), { recursive: true });
        await writeFile(w.path("src/config.ts"), `// config\nexport const GITHUB_TOKEN = '${token}';\n`);
        await w.pushBranch("feat: config");
        headCommit = (await w.agentGit(["rev-parse", "HEAD"])).trim();
        leak = await w.openCr("Add config");
      });

      await ctx.step("`builder` merges it → 409 CR_SECRET_DETECTED naming src/config.ts:2, the commit and github_token, never the value; main unchanged", async () => {
        const r = await w.merge(w.builder.client, leak.crId);
        r.status(409).body().has("$.code", "CR_SECRET_DETECTED").has("$.findings_total", 1);
        const body = r.json<{ findings: Array<Record<string, unknown>>; remediation: string }>();
        const expected = [{ commit: headCommit.slice(0, 12), file: "src/config.ts", line: 2, rule: "github_token", label: "GitHub token" }];
        if (JSON.stringify(body.findings) !== JSON.stringify(expected)) throw new Error(`findings ${JSON.stringify(body.findings)}`);
        if (!body.remediation.includes("kortix secrets request <NAME>")) throw new Error(`remediation ${body.remediation}`);
        noValue(r.text());
        if ((await w.mainFile("src/config.ts")) !== null) throw new Error("a refused merge landed src/config.ts");
      });

      await ctx.step("`builder` asks to override (allow_secrets: true) → 403 CR_SECRET_OVERRIDE_REFUSED; main unchanged", async () => {
        const r = await w.merge(w.builder.client, leak.crId, { allow_secrets: true });
        r.status(403).body().has("$.code", "CR_SECRET_OVERRIDE_REFUSED");
        noValue(r.text());
        if ((await w.mainFile("src/config.ts")) !== null) throw new Error("a refused override landed src/config.ts");
      });

      await ctx.step("a service account with the manager role asks to override → 403 CR_SECRET_OVERRIDE_REFUSED: automation is not a person", async () => {
        const created = await owner.post(
          "/v1/accounts/:accountId/iam/service-accounts",
          { name: ctx.fixtures.name("cr16-sa"), description: "CI" },
          { params: { accountId: w.team.id } },
        );
        created.status(201);
        const sa = ctx.client.withBearer(created.json<{ secret: string }>().secret, "service-account");
        (await owner.post(
          "/v1/accounts/:accountId/iam/assignments",
          { principal_type: "service_account", principal_id: created.json<{ service_account_id: string }>().service_account_id, role_key: "manager", scope_type: "project", scope_id: w.project.id },
          { params: { accountId: w.team.id } },
        )).status(201);
        // IAM verdicts are cached for up to 15 s: the first calls can answer a role 403.
        const deadline = Date.now() + 30_000;
        let r = await w.merge(sa, leak.crId, { allow_secrets: true });
        while (r.json<{ code?: string }>()?.code !== "CR_SECRET_OVERRIDE_REFUSED" && r.statusCode !== 200 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          r = await w.merge(sa, leak.crId, { allow_secrets: true });
        }
        r.status(403).body().has("$.code", "CR_SECRET_OVERRIDE_REFUSED");
        if ((await w.mainFile("src/config.ts")) !== null) throw new Error("a service account override landed src/config.ts");
      });

      await ctx.step("the owner's key bound to this workspace asks to override → 403 CR_SECRET_OVERRIDE_REFUSED: only an unbound personal key or a browser session is the person", async () => {
        const minted = await owner.post("/v1/workspaces/:workspaceId/tokens", { name: ctx.fixtures.name("cr16-bound") }, { params: { workspaceId: w.project.id } });
        minted.status(201);
        const bound = ctx.client.withBearer(minted.json<{ secret_key: string }>().secret_key, "workspace-key");
        const r = await w.merge(bound, leak.crId, { allow_secrets: true });
        r.status(403).body().has("$.code", "CR_SECRET_OVERRIDE_REFUSED");
        if ((await w.mainFile("src/config.ts")) !== null) throw new Error("a workspace-bound key override landed src/config.ts");
      });

      await ctx.step("the real CLI as the agent: `kortix cr merge <n>` exits 1 and names src/config.ts:2 and `kortix secrets request`, never the value", async () => {
        const res = await cli.run(["cr", "merge", String(leak.number)], { env: agentEnv });
        if (res.exitCode !== 1) throw new Error(`exit ${res.exitCode}: ${res.stdout}${res.stderr}`);
        if (!res.stderr.includes("src/config.ts:2 (GitHub token") || !res.stderr.includes("kortix secrets request")) {
          throw new Error(`stderr: ${res.stderr}`);
        }
        noValue(res.stdout + res.stderr);
      });

      await ctx.step("deleting the token in a later commit does not clear it: the merge carries the first commit → 409 still", async () => {
        await writeFile(w.path("src/config.ts"), "// config\nexport const GITHUB_TOKEN = process.env.GITHUB_TOKEN;\n");
        await w.pushBranch("fix: read the token from the environment");
        const r = await w.merge(w.builder.client, leak.crId);
        r.status(409).body().has("$.code", "CR_SECRET_DETECTED").has("$.findings[0].commit", headCommit.slice(0, 12));
      });

      await ctx.step("the owner merges without the override → 409; with allow_secrets → 200, and the change request records who overrode which finding", async () => {
        (await w.merge(owner, leak.crId)).status(409).body().has("$.code", "CR_SECRET_DETECTED");
        (await w.merge(owner, leak.crId, { allow_secrets: true })).status(200).body().has("$.change_request.status", "merged");
        const read = await w.readCr(leak.crId);
        read
          .status(200)
          .body()
          .has("$.change_request.metadata.secret_override.by", ctx.P.OWNER.userId)
          .has("$.change_request.metadata.secret_override.findings_total", 1)
          .has("$.change_request.metadata.secret_override.findings[0].file", "src/config.ts");
        noValue(read.text());
      });

      await ctx.step("control: `builder` merges a clean change request → 200", async () => {
        await w.fromMain();
        await writeFile(w.path("README.md"), "# example-org\n\nclean note\n");
        await w.pushBranch("docs: clean note");
        const cr = await w.openCr("Clean note");
        (await w.merge(w.builder.client, cr.crId)).status(200).body().has("$.change_request.status", "merged");
      });

      let unread = { crId: "", number: 0 };
      await ctx.step("a change request the check cannot read in full (an octopus merge, no key) → `builder` gets 409 CR_SECRET_SCAN_INCOMPLETE, and 403 with allow_secrets", async () => {
        await w.fromMain();
        for (const side of ["side-a", "side-b"]) {
          await w.agentGit(["checkout", "-q", "-b", side, "origin/main"]);
          await writeFile(w.path(`${side}.md`), `${side}\n`);
          await w.agentGit(["add", "-A"]);
          await w.agentGit(["-c", "user.name=builder", "-c", "user.email=builder@example.test", "commit", "-q", "-m", side]);
        }
        await w.agentGit(["checkout", "-q", "-B", "octopus", "origin/main"]);
        await w.agentGit(["-c", "user.name=builder", "-c", "user.email=builder@example.test", "merge", "-q", "--no-ff", "--no-edit", "side-a", "side-b"]);
        await w.agentGit(["push", "-q", "-f", "origin", `HEAD:refs/heads/${w.builder.sessionId}`]);
        unread = await w.openCr("Octopus");
        (await w.merge(w.builder.client, unread.crId))
          .status(409)
          .body()
          .has("$.code", "CR_SECRET_SCAN_INCOMPLETE")
          .has("$.unscanned", "an octopus merge")
          .has("$.findings_total", 0);
        (await w.merge(w.builder.client, unread.crId, { allow_secrets: true })).status(403).body().has("$.code", "CR_SECRET_OVERRIDE_REFUSED");
        if ((await w.mainFile("side-a.md")) !== null) throw new Error("a refused merge landed side-a.md");
      });

      await ctx.step("the owner merges it without allow_secrets → 200; the change request records metadata.secret_scan_skipped with the reason and who", async () => {
        (await w.merge(owner, unread.crId)).status(200).body().has("$.change_request.status", "merged");
        (await w.readCr(unread.crId))
          .status(200)
          .body()
          .has("$.change_request.metadata.secret_scan_skipped.reason", "an octopus merge")
          .has("$.change_request.metadata.secret_scan_skipped.by", ctx.P.OWNER.userId);
        if ((await w.mainFile("side-a.md")) === null) throw new Error("main lacks the merged octopus change");
      });
    } finally {
      cli.dispose();
      await w.close();
    }
  },
);
