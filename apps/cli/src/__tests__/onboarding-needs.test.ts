import { expect, test } from 'bun:test';
import { findHook, foreignHooks, type RepoHook } from '../onboarding/github-hooks.ts';
import { manifestNeeds } from '../onboarding/manifest-needs.ts';
import { slackReturnsHere } from '../onboarding/phases.ts';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const hook = (id: number, url: string): RepoHook => ({ id, url, events: ['issues'], active: true, last_code: 200 });

test('a hook of another workspace is never this trigger\'s hook; a moved host still is', () => {
  const url = `https://new.example.test/v1/webhooks/workspaces/${WS}/intake`;
  const moved = hook(1, `https://old.example.test/v1/webhooks/workspaces/${WS}/intake`);
  const foreign = hook(2, `https://old.example.test/v1/webhooks/workspaces/${OTHER}/intake`);
  expect(findHook([foreign], url)).toBeNull();
  expect(findHook([foreign, moved], url)?.id).toBe(1);
  expect(foreignHooks([foreign, moved, hook(3, 'https://ci.example.test/intake')], url, 'intake')).toEqual([{ ...foreign, workspace: OTHER }]);
});

test('Slack is needed only by a grant, a channel connector or a trigger that is on', () => {
  const trigger = (enabled: boolean) => ({ triggers: [{ slug: 'source-slack', enabled, on: { cron: '0 0 * * * *' }, run: { agent: 'a', prompt: 'read the channels' } }] });
  expect(manifestNeeds(trigger(false)).uses_slack).toBe(false);
  expect(manifestNeeds(trigger(true)).uses_slack).toBe(true);
  expect(manifestNeeds({ agents: { a: { connectors: '*' } } }).uses_slack).toBe(false);
  expect(manifestNeeds({ agents: { a: { connectors: ['kortix_slack'] } } }).uses_slack).toBe(true);
});

test('a webhook trigger that filters on the repository name carries that repository', () => {
  const needs = manifestNeeds({
    triggers: [{ slug: 'intake', on: { webhook: { secret: 'HOOK_SECRET' } }, filter: { 'headers.github_event': 'issues', 'body.repository.full_name': 'acme/app' } }],
  });
  expect(needs.github_webhooks).toEqual([{ slug: 'intake', events: ['issues'], secret: 'HOOK_SECRET', enabled: true, label: null, repo: 'acme/app' }]);
});

test('a Slack install link that returns to another deployment is not offered', () => {
  const link = (back: string) => `https://slack.com/oauth/v2/authorize?redirect_uri=${encodeURIComponent(back)}`;
  expect(slackReturnsHere(link('https://api.example.test/v1/webhooks/slack/oauth/callback'), 'https://api.example.test/v1')).toBe(true);
  expect(slackReturnsHere(link('https://other.example.test/v1/webhooks/slack/oauth/callback'), 'https://api.example.test/v1')).toBe(false);
});
