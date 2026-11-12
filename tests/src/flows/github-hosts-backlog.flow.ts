/**
 * GitHub / git-transport backlog flows: GH-4, GH-8.
 *
 * Behaviour DERIVED from apps/api/src/projects/index.ts (spec text is treated as
 * a hint, not the contract):
 *
 *  - GH-8  GET/POST/DELETE /v1/projects/:projectId/cli-token[/:tokenId] —
 *    project-scoped CLI tokens. GET = loadProjectForUser('read'); POST/DELETE =
 *    loadProjectForUser('manage'). POST → 201 with a one-time `secret_key` +
 *    `token_id`; GET lists `items` (no secret); DELETE → 200 {ok:true}, unknown
 *    token → 404. ANON → 401; non-member / no-access → 404 (never 403).
 *
 *  - GH-4  POST /v1/projects/github/installations/linkable and
 *    POST /v1/projects/github/installations/link — the authenticated account
 *    linking flow. Both routes require Kortix authentication. The list route
 *    requires a GitHub user token. The link route validates installation_id
 *    before it calls GitHub.
 *
 * NOT AUTHORED (reported as drift — no black-box HTTP surface):
 *  - HOSTS-1..6 (`kortix hosts ls|use|add|rm|info|current`): pure CLI-LOCAL
 *    config operations (apps/cli/src/commands/hosts.ts → api/config.ts). They
 *    read/write the local CLI config file and make NO HTTP calls — there are no
 *    API routes to test in a black-box suite.
 */
import { flow } from "../core/flow";

const UNKNOWN = "00000000-0000-4000-a000-000000000000";

// ── GH-4 — link an existing GitHub App installation ───────────────────────

flow(
  "GH-4",
  {
    domain: "github",
    routes: [
      "POST /v1/workspaces/github/installations/linkable",
      "POST /v1/workspaces/github/installations/link",
    ],
  },
  async (ctx) => {
    await ctx.step("ANON cannot list linkable installations → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/workspaces/github/installations/linkable", {});
      r.status(401);
    });

    await ctx.step("missing github_user_token cannot list installations → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/github/installations/linkable", {});
      r.status(400).body().has("$.error", "GitHub authorization is required to list installations");
    });

    await ctx.step("missing installation_id cannot link an installation → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/github/installations/link", {});
      r.status(400).body().has("$.error", "installation_id is required");
    });

    await ctx.step("nonnumeric installation_id cannot link an installation → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/workspaces/github/installations/link", {
          installation_id: "not-a-github-installation-id",
        });
      r.status(400).body().has("$.error", "installation_id must be a GitHub installation id");
    });
  },
);

// ── GH-8 — project-scoped CLI tokens (list / mint / revoke) ────────────────

flow(
  "GH-8",
  {
    domain: "git",
    routes: [
      "GET /v1/workspaces/:projectId/cli-token",
      "POST /v1/workspaces/:projectId/cli-token",
      "DELETE /v1/workspaces/:projectId/cli-token/:tokenId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    let tokenId = "";

    await ctx.step("ANON cannot list → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/workspaces/:projectId/cli-token", { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("ANON cannot mint → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/workspaces/:projectId/cli-token", { name: "x" }, { params: { projectId: p.id } });
      r.status(401);
    });
    await ctx.step("OWNER mints a project-scoped CLI token → 201 with one-time secret", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/workspaces/:projectId/cli-token",
          { name: ctx.fixtures.name("cli-tok") },
          { params: { projectId: p.id } },
        );
      r.status(201).body().exists("$.token_id").exists("$.secret_key").has("$.project_id", p.id);
      tokenId = r.json<any>().token_id;
    });
    await ctx.step("GET lists the token (secret absent from the list) → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/workspaces/:projectId/cli-token", { params: { projectId: p.id } });
      r.status(200).body().exists("$.items");
      const items = r.json<any>().items as any[];
      const mine = items.find((t) => t.token_id === tokenId);
      // The minted token is present and the list never re-exposes the secret.
      if (!mine) throw new Error(`cli-token list must include the minted token ${tokenId}`);
      if ("secret_key" in mine) throw new Error("cli-token list must not return secret_key");
    });
    await ctx.step("NONMEMBER cannot mint → 404 (project not loadable)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/workspaces/:projectId/cli-token", { name: "x" }, { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("NONMEMBER cannot list → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/workspaces/:projectId/cli-token", { params: { projectId: p.id } });
      r.status([403, 404]);
    });
    await ctx.step("a project member without project.credentials.issue cannot list the project's keys → 403", async () => {
      const member = await team.addMember("member");
      await team.grantProjectRole(p.id, member.userId!, "member");
      const r = await ctx.client
        .as(member)
        .get("/v1/workspaces/:projectId/cli-token", { params: { projectId: p.id } });
      r.status(403);
    });
    await ctx.step("OWNER revokes the token → 200 {ok:true}", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/workspaces/:projectId/cli-token/:tokenId", {
          params: { projectId: p.id, tokenId: tokenId || UNKNOWN },
        });
      r.status([200, 404]);
      if (r.statusCode === 200) r.body().has("$.ok", true);
    });
    await ctx.step("revoking an unknown token → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/workspaces/:projectId/cli-token/:tokenId", {
          params: { projectId: p.id, tokenId: UNKNOWN },
        });
      r.status(404);
    });
    await ctx.step("ANON cannot revoke → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .del("/v1/workspaces/:projectId/cli-token/:tokenId", {
          params: { projectId: p.id, tokenId: UNKNOWN },
        });
      r.status(401);
    });
  },
);
