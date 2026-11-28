/**
 * Workspace cache — a project's saved /workspace that new sessions start from, behind `platinum_cache`.
 * Maps to spec §WSC-*.
 *
 * Saving and listing need Platinum's cache API, which this stack does not have, so the flow proves the contract
 * that holds without it: the flag gate, who may call, and the refusals that come before any Platinum call.
 */
import { flow } from '../core/flow';

const LIST = '/v1/workspaces/:projectId/workspace-cache';
const BUILD = '/v1/workspaces/:projectId/workspace-cache/build';

flow(
  'WSC-1',
  {
    domain: 'sessions',
    tags: ['workspace-cache', 'feature-flags'],
    routes: [`GET ${LIST}`, `POST ${LIST}`, `POST ${BUILD}`],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const params = { projectId: p.id };
    const owner = ctx.client.as(ctx.P.OWNER);
    // A well-formed id the project has no session for.
    const missing = crypto.randomUUID();

    await ctx.step('ANON → 401; NONMEMBER → 403/404', async () => {
      (await ctx.client.as(ctx.P.ANON).get(LIST, { params })).status(401);
      (await ctx.client.as(ctx.P.NONMEMBER).get(LIST, { params })).status([403, 404]);
      (await ctx.client.as(ctx.P.NONMEMBER).post(BUILD, {}, { params })).status([403, 404]);
    });

    await ctx.step('with platinum_cache off (the default), every route → 403 feature_disabled', async () => {
      (await owner.get(LIST, { params })).status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'platinum_cache');
      (await owner.post(LIST, { session_id: missing, key: 'ws-flow' }, { params }))
        .status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'platinum_cache');
      (await owner.post(BUILD, {}, { params })).status(403).body().has('$.code', 'feature_disabled').has('$.feature', 'platinum_cache');
    });

    await ctx.step('OWNER turns platinum_cache on → 200', async () => {
      (await owner.patch('/v1/workspaces/:projectId/features', { feature: 'platinum_cache', enabled: true }, { params })).status(200);
    });

    await ctx.step('a build before anyone saved → 409 no_builder', async () => {
      (await owner.post(BUILD, {}, { params })).status(409).body().has('$.code', 'no_builder');
    });

    await ctx.step('a save of a session the project does not have → 404 session_not_found; a short key → 400', async () => {
      (await owner.post(LIST, { session_id: missing, key: 'ws-flow' }, { params })).status(404).body().has('$.code', 'session_not_found');
      (await owner.post(LIST, { session_id: missing, key: 'ws' }, { params })).status(400);
    });

    await ctx.step('OWNER clears the flag → 200, and the routes are gated again', async () => {
      (await owner.patch('/v1/workspaces/:projectId/features', { feature: 'platinum_cache', enabled: null }, { params })).status(200);
      (await owner.post(BUILD, {}, { params })).status(403).body().has('$.code', 'feature_disabled');
    });
  },
);
