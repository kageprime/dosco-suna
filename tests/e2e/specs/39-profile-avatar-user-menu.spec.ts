import { expect, test, type Page } from '@playwright/test';

import { loadEnv } from '../../src/core/env';
import { createDatabaseProject, deleteDatabaseProject } from '../../src/fixtures/database-project';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import { dismissOnboarding } from '../helpers/ui';
import { ensureOwnedAccount } from '../helpers/accounts';
import { createApiJsonClient } from '../helpers/http';

/**
 * KRTX-4492: a profile picture uploaded on /settings/profile reached the auth
 * metadata but never any identity surface — the "Logged in as" trigger on
 * /workspaces and /workspaces/new rendered text-only (0 <img> in the page).
 * The write path is Supabase Storage + `auth.updateUser` (profile-tab.tsx);
 * this journey runs THAT path and asserts the rendered avatar where the
 * person sees themselves. The account top bar is that surface on every
 * account-level page (/workspaces, /workspaces/new, /inbox); the shell's
 * workspace switcher is a workspace menu, not a user menu, and carries no
 * signed-in identity line (flattened in the shorter-workspace-menu change).
 */

const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || 'http://localhost:13740',
  password: 'E2eProfileAvatar123!',
};
const apiBase = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const api = createApiJsonClient(apiBase);

/** One 1×1 red PNG, under the upload size cap — the bitmap itself is the fixture. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPhfDwADhQGALosnPQAAAABJRU5ErkJggg==';

/**
 * The deterministic web dev server restarts itself when the runner's warm-up
 * compile race kills it (local.ts: restart budget 3); a goto in that window
 * answers net::ERR_CONNECTION_REFUSED. Give each goto a short retry instead of
 * failing the journey on the server's own restart.
 */
async function gotoStable(page: Page, path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      return;
    } catch (error) {
      const retryable =
        !(error instanceof Error) ||
        error.message.includes('ERR_CONNECTION_REFUSED') ||
        error.message.includes('ERR_SOCKET_NOT_CONNECTED') ||
        error.message.includes('Timeout 120000ms exceeded');
      if (!retryable || attempt >= 5) throw error;
      await page.waitForTimeout(10_000);
    }
  }
}

test.describe('39 — The profile picture shows where the person sees themselves', () => {
  test('the uploaded avatar renders in the Logged in as trigger on every account page', async ({
    page,
  }) => {
    // Recorded local run: 419.5s (tests/e2e/shard-durations.json); gotoStable
    // can add ~50s more. Cap 420s left 0.5s of headroom — 600s covers a slow lane.
    test.setTimeout(600_000);
    const env = loadEnv();
    if (!env.databaseUrl) throw new Error('KE2E_DATABASE_URL is required');
    const runId = Date.now().toString(36);
    const email = `e2e-profile-avatar-${runId}@example.test`;
    const user = await createAuthUser(email, authOptions);
    let projectId: string | null = null;

    try {
      const session = await signIn(email, authOptions);
      const account = await ensureOwnedAccount(api, session.access_token);
      const project = await createDatabaseProject(env, {
        accountId: account,
        userId: user.id,
        name: `Avatar ${runId}`,
      });
      projectId = project.id;

      await installBrowserSessionDirect(page, session, `/workspaces/${project.id}`, authOptions);
      await dismissOnboarding(page);

      await test.step('upload a picture on /settings/profile (the real write path)', async () => {
        // A cold route compiles on first hit in the dev web (30-60 s+): every
        // goto here gets a one-shot timeout above the default.
        await gotoStable(page, `/workspaces`);
        await expect(page.getByRole('button', { name: /Logged in as/ })).toBeVisible({ timeout: 60_000 });
        await gotoStable(page, `/settings/profile`);
        await page.setInputFiles('input[type=file]', {
          name: 'avatar.png',
          mimeType: 'image/png',
          buffer: Buffer.from(PNG_BASE64, 'base64'),
        });
        // The upload round-trips through Supabase Storage + auth.updateUser
        // before the Remove affordance appears.
        await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible({ timeout: 30_000 });
      });

      await test.step('the account top bar shows the avatar on /workspaces', async () => {
        await gotoStable(page, `/workspaces`);
        const trigger = page.getByRole('button', { name: /Logged in as/ });
        await expect(trigger).toBeVisible();
        await expect(trigger.locator('img[src*="/storage/v1/object/public/avatars/"]')).toBeVisible({
          timeout: 15_000,
        });
      });

      await test.step('the account top bar shows the avatar on /inbox too', async () => {
        await gotoStable(page, `/inbox`);
        const trigger = page.getByRole('button', { name: /Logged in as/ });
        await expect(trigger).toBeVisible({ timeout: 60_000 });
        await expect(trigger.locator('img[src*="/storage/v1/object/public/avatars/"]')).toBeVisible({
          timeout: 15_000,
        });
      });
    } finally {
      if (projectId) await deleteDatabaseProject(env, projectId).catch(() => undefined);
      await deleteAuthUser(user.id, authOptions).catch(() => undefined);
    }
  });
});
