import { expect, test } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import { createApiJsonClient } from '../helpers/http';
import { createAuthUser, deleteAuthUser, installBrowserSessionDirect, signIn } from '../helpers/session-auth';
import { dismissOnboarding, selectAccountForUi } from '../helpers/ui';
import { ensureOwnedAccount } from '../helpers/accounts';
import { expectSettingsLayout } from '../helpers/settings-layout';

/**
 * One Settings panel per workspace (design.md §3.2 C7): one rail, no tab bar
 * above it, the sections in the registry's order, and every old link landing
 * on the section that owns it now.
 */

const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://localhost:13740',
  password: 'E2eWorkspaceSettings123!',
};
const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const api = createApiJsonClient(apiBase);

test.describe('58 — Workspace settings is one panel', () => {
  test('the rail lists the sections top to bottom, and old links land on their section', async ({ page }) => {
    test.setTimeout(240_000);
    const env = loadEnv();
    if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
    const runId = Date.now().toString(36);
    const email = `e2e-ws-settings-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    let projectId: string | null = null;

    try {
      const session = await signIn(email, authOptions);
      const account = await ensureOwnedAccount(api, session.access_token);
      const project = await createDatabaseProject(env, { accountId: account, userId: user.id, name: `Panel ${runId}` });
      projectId = project.id;
      await installBrowserSessionDirect(page, session, `/workspaces/${project.id}`, authOptions);
      await selectAccountForUi(page, account);
      await page.goto(`/workspaces/${project.id}`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);

      await test.step('/admin opens General inside one rail, with no tab bar above it', async () => {
        await page.goto(`/workspaces/${project.id}/admin`, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}/admin/general`), { timeout: 60_000 });
        const rail = page.getByRole('navigation', { name: 'Workspace settings' });
        await expect(rail.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
        // The rail is the only navigation: no Customize tab bar over the panel.
        await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toHaveCount(0);
      });

      await test.step('the rail groups and their first rows follow the registry', async () => {
        const rail = page.getByRole('navigation', { name: 'Workspace settings' });
        const groups = await rail.getByRole('tablist').evaluateAll((lists) =>
          lists.map((list) => list.getAttribute('aria-label')),
        );
        expect(groups.slice(0, 3)).toEqual(['Workspace', 'Library', 'People']);
        expect(groups.at(-1)).toBe('Support');
        const workspaceRows = await rail.getByRole('tablist', { name: 'Workspace' }).getByRole('tab').allInnerTexts();
        expect(workspaceRows.slice(0, 2).map((row) => row.trim())).toEqual(['General', 'Security']);
        const peopleRows = (await rail.getByRole('tablist', { name: 'People' }).getByRole('tab').allInnerTexts()).map(
          (row) => row.trim(),
        );
        expect(peopleRows[0]).toBe('Members');
        // Access merged into Members.
        expect(peopleRows).not.toContain('Access');
      });

      await test.step('General holds the workspace ID and the Danger zone; Security holds MFA', async () => {
        await expect(page.getByText('Workspace ID', { exact: true })).toBeVisible();
        await expect(page.getByText(project.id)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Delete workspace' })).toBeVisible();
        await page.goto(`/workspaces/${project.id}/admin/security`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('switch', { name: 'Require two-factor authentication' })).toBeVisible({ timeout: 60_000 });
      });

      await test.step('old links land on the section that owns them now', async () => {
        const cases: Array<[string, string]> = [
          [`/workspaces/${project.id}/admin/access`, `/workspaces/${project.id}/admin/members`],
          [`/workspaces/${project.id}/members`, `/workspaces/${project.id}/admin/members`],
          [`/workspaces/${project.id}?accountId=${account}&accountTab=settings`, `/workspaces/${project.id}/admin/security`],
          [`/workspaces/${project.id}/admin/loops`, `/workspaces/${project.id}/admin/triggers`],
        ];
        for (const [from, to] of cases) {
          await page.goto(from, { waitUntil: 'domcontentloaded' });
          await expect(page).toHaveURL(new RegExp(`${to.replace(/[?]/g, '\\?')}$`), { timeout: 60_000 });
        }
      });

      await test.step('the workspace menu opens Members with the invite form', async () => {
        await page.goto(`/workspaces/${project.id}`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: 'Switch workspace' }).click();
        await page.getByRole('menuitem', { name: 'Invite people', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}/admin/members\\?invite=1`), { timeout: 60_000 });
        await expect(page.getByText(`Invite people to Panel ${runId}`).first()).toBeVisible({ timeout: 60_000 });
        await expect(page.getByRole('combobox', { name: 'Role' }).last()).toContainText('Member');
      });
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => undefined);
      await deleteAuthUser(user.id, authOptions).catch(() => undefined);
    }
  });

  test('one sidebar opens and closes, and every page centers its column', async ({ page }) => {
    test.setTimeout(240_000);
    const env = loadEnv();
    if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
    const runId = Date.now().toString(36);
    const email = `e2e-ws-layout-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    let projectId: string | null = null;

    try {
      const session = await signIn(email, authOptions);
      const account = await ensureOwnedAccount(api, session.access_token);
      const project = await createDatabaseProject(env, { accountId: account, userId: user.id, name: `Layout ${runId}` });
      projectId = project.id;
      await page.setViewportSize({ width: 1440, height: 900 });
      await installBrowserSessionDirect(page, session, `/workspaces/${project.id}`, authOptions);
      await selectAccountForUi(page, account);
      await page.goto(`/workspaces/${project.id}`, { waitUntil: 'domcontentloaded' });
      await dismissOnboarding(page);

      // A settings page (General, Feature flags), a library page (Agents), an
      // account page (Roles), and Customize, which opens Agents.
      const pages = ['admin/general', 'admin/feature-flags', 'admin/agents', 'admin/roles', 'customize'];
      // `navs`: the settings navs on screen. The column has as much space
      // on its left as on its right.
      const expectLayout = async (state: string, navs: number) => {
        for (const path of pages) {
          await page.goto(`/workspaces/${project.id}/${path}`, { waitUntil: 'domcontentloaded' });
          if (path === 'customize') {
            await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}/admin/agents`), { timeout: 60_000 });
          }
          await expect(page.locator('main h1')).toBeVisible({ timeout: 60_000 });
          // Off the sidebar's edge, so a closed sidebar does not peek open.
          await page.mouse.move(900, 600);
          await expectSettingsLayout(page, navs, `${path}, ${state}`);
        }
      };

      await test.step('sidebar open: its settings nav is the only one, every column is centered', async () => {
        await page.goto(`/workspaces/${project.id}/admin/general`, { waitUntil: 'domcontentloaded' });
        const open = page.getByRole('button', { name: 'Open sidebar' });
        if (await open.isVisible()) await open.click();
        await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible({ timeout: 60_000 });
        await expectLayout('sidebar open', 1);
      });

      await test.step('sidebar closed: the page draws no second settings sidebar', async () => {
        await page.getByRole('button', { name: 'Collapse sidebar' }).click();
        await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeVisible();
        await expectLayout('sidebar closed', 0);
        // The one sidebar opens again and holds the settings nav.
        await page.getByRole('button', { name: 'Open sidebar' }).click();
        await expect(page.getByRole('navigation', { name: 'Workspace settings' })).toBeVisible();
      });

      await test.step('Repository: the toolbar names the page, no second heading or opener', async () => {
        await page.goto(`/workspaces/${project.id}/admin/repo`, { waitUntil: 'domcontentloaded' });
        const toolbarTitle = page.locator('main .kx-titlebar-row h1');
        await expect(toolbarTitle).toHaveText('Repository', { timeout: 60_000 });
        await expect(page.locator('main h1')).toHaveCount(1);
        await page.getByRole('button', { name: 'Collapse sidebar' }).click();
        await expect(page.getByRole('button', { name: 'Open sidebar' })).toHaveCount(1);
        await page.getByRole('button', { name: 'Open sidebar' }).click();
        await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
      });

      await test.step('phone width: one strip of sections, the column fills the pane', async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await expectLayout('phone', 1);
      });
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => undefined);
      await deleteAuthUser(user.id, authOptions).catch(() => undefined);
    }
  });
});
