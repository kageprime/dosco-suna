import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { installBrowserSessionDirect } from "../session-auth";
import { dismissOnboarding, selectAccountForUi } from "../ui";
import {
  api,
  authOptions,
  pinMacPlatform,
  provisionDesktopScene,
  resize,
  desktopDatabaseUrl,
  chooseAppearanceTheme,
  expectSeparateRows,
  test,
} from "./fixture";
import { defineFrameParity } from "./frame";
import { defineQueueParity } from "./queue";
import { defineShellParity } from "./shell";

/**
 * The 27 desktop parity journeys for one runtime: `web` (a browser user agent)
 * or `desktop` (the KortixDesktop user agent, or the real Electron shell with
 * E2E_DESKTOP_NATIVE=1). Two spec files call this, one per runtime, so the
 * browser shard planner places the halves on two lanes: as one file the
 * journeys took 655 s on one lane (browser-1, run 38777589705).
 */
export function defineDesktopParity(runtime: "web" | "desktop"): void {
  const desktop = runtime === "desktop";
  test.describe(`27 — desktop parity (${runtime})`, () => {
    test.use({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36" +
        (desktop ? " KortixDesktop/0.1.0" : ""),
    });
    defineSessionParity(desktop);
    defineQueueParity();
    defineShellParity();
    defineFrameParity(desktop);
  });
}

function defineSessionParity(desktop: boolean): void {
    test("settings and account exits use the correct host alignment", async ({
      page,
      baseURL,
      desktopApp,
    }) => {
      test.setTimeout(120_000);
      await resize(page, desktopApp, 1100, 700);
      const databaseUrl = desktopDatabaseUrl();
      // The macOS row rule keys on `data-desktop-platform`, which the app reads
      // from `navigator.platform`, not from the user agent. Pin it, or a Linux
      // CI runner renders the Linux desktop layout and the row stays left.
      await pinMacPlatform(page);
      const { session, accounts, project, dispose } = await provisionDesktopScene({
        databaseUrl,
        emailPrefix: "e2e-desktop-exit",
        name: "Desktop exit alignment",
      });
      try {
        await installBrowserSessionDirect(
          page,
          session,
          `${baseURL}/workspaces/${project.id}`,
          authOptions,
        );
        await selectAccountForUi(page, accounts[0].account_id);
        await dismissOnboarding(page);
        // Mod+, is bound by `SettingsPanel`, which `ProjectShell` mounts only
        // after auth hydrates (until then the shell renders an empty div). A
        // keystroke sent before that has no listener. The local stack hydrates
        // before `dismissOnboarding` returns; a deployed origin does not, so
        // this step failed 4 of 4 attempts on staging and on the #7579 preview
        // while passing locally. Wait for the shell's own sidebar, then press
        // until the effect has bound — the dialog must still come from Mod+,.
        await expect(
          page.getByRole("button", { name: "Switch workspace", exact: true }),
        ).toBeVisible({ timeout: 60_000 });
        const settings = page.getByRole("dialog");
        await expect(async () => {
          await page.keyboard.press("Meta+,");
          await expect(settings).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 45_000 });
        const settingsRow = settings.locator(".kx-overlay-sidebar-titlebar");
        const settingsBack = settingsRow.getByRole("button", { name: /Back to app/i });
        await expect(settingsBack).toBeVisible();
        expect(
          await settingsRow.evaluate((row) => getComputedStyle(row).justifyContent),
        ).toBe(desktop ? "flex-end" : "flex-start");
        if (!desktop) {
          const rowBox = (await settingsRow.boundingBox())!;
          const backBox = (await settingsBack.boundingBox())!;
          expect(backBox.x - rowBox.x).toBeLessThan(24);
        }
        await settingsBack.click();

        await page.goto(
          `${baseURL}/workspaces/${project.id}?accountId=${accounts[0].account_id}`,
        );
        // Workspaces: the account hub is no longer a modal. An old
        // `?accountId=` link opens the workspace's settings page in the shell.
        await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}/admin`), {
          timeout: 30_000,
        });
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByText("General", { exact: true }).first()).toBeVisible();
      } finally {
        await dispose();
      }
    });

    // The shipped shell (KortixDesktop/0.1.0) opens /projects/start at launch
    // and /projects/<id> for a workspace, never /workspaces. On prod every one
    // of those answered 404 for a signed-in user (2026-11-10, v0.15.3): the
    // middleware rewrote /projects/… onto /en/projects/…, which no page serves.
    test("a signed-in shell opens its legacy /projects paths in place", async ({
      page,
      baseURL,
    }) => {
      test.skip(!desktop, "only the desktop shell keeps the /projects paths");
      test.setTimeout(120_000);
      const databaseUrl = desktopDatabaseUrl();
      const { session, project, dispose } = await provisionDesktopScene({
        databaseUrl,
        emailPrefix: "e2e-desktop-legacy",
        name: "Desktop legacy paths",
      });
      try {
        const opened = await installBrowserSessionDirect(
          page,
          session,
          `${baseURL}/projects/${project.id}`,
          authOptions,
        );
        // Served in place (no redirect the shell would open in a browser),
        // then DesktopLegacyPathSync shows the canonical /workspaces URL.
        expect(opened?.status()).toBe(200);
        expect(opened?.request().redirectedFrom()).toBeNull();
        await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}`), {
          timeout: 30_000,
        });
        await expect(page.getByText("404 Page not found")).toHaveCount(0);

        const start = await page.goto(`${baseURL}/projects/start`);
        expect(start?.status()).toBe(200);
        await expect(page.getByText("404 Page not found")).toHaveCount(0);
      } finally {
        await dispose();
      }
    });

    test("sidebar, settings, agents and connectors remain aligned and clickable", async ({
      page,
      baseURL,
      desktopApp,
    }) => {
      // 3.9-5.1 min on the 4 vCPU CI runners (runs 38913477440, 38919869428):
      // every route it visits compiles cold. 300 s timed out 1 of 4 attempts.
      test.setTimeout(480_000);
      await resize(page, desktopApp, 1440, 900);
      const databaseUrl = desktopDatabaseUrl();
      await pinMacPlatform(page);
      const { session, accounts, project, dispose } = await provisionDesktopScene({
        databaseUrl,
        emailPrefix: "e2e-desktop",
        name: "Desktop parity",
      });
      const accountId = accounts[0].account_id;
      let pooledResource: { accountId: string; secretId: string } | undefined;
      try {
        await installBrowserSessionDirect(
          page,
          session,
          `${baseURL}/workspaces/${project.id}`,
          authOptions,
        );
        await selectAccountForUi(page, accountId);
        await page.goto(`${baseURL}/workspaces/${project.id}`);
        await dismissOnboarding(page);
        if (desktop)
          await expect(page.locator("html")).toHaveAttribute(
            "data-desktop-platform",
            "macos",
          );
        else
          await expect(page.locator("html")).not.toHaveAttribute(
            "data-desktop",
            "true",
          );

        const switcher = page.getByRole("button", {
          name: "Switch workspace",
          exact: true,
        });
        await expect(switcher).toBeVisible();
        // The project shell navigates and owns the band's corner, so the
        // window's Back (root layout) steps aside on every project view.
        await expect(
          page.getByRole("button", { name: "Back", exact: true }),
        ).toHaveCount(0);
        const box = await switcher.boundingBox();
        expect(
          box!.x,
          "workspace selector must clear native window controls",
        ).toBeGreaterThanOrEqual(desktop ? 62 : 0);
        if (desktop) {
          expect(box!.y, "workspace selector shares the traffic-light row").toBeLessThan(40);
        }
        // The Download app row sits in the sidebar footer, never in the
        // desktop app (it is the download).
        await expect(
          page.getByRole("button", { name: "Download app", exact: true }),
        ).toHaveCount(desktop ? 0 : 1);
        await switcher.click();
        await page.getByRole("menuitem", { name: /^Settings/ }).click();
        const dialog = page.getByRole("dialog");
        await expect(
          dialog.getByRole("button", { name: "Back to app" }),
        ).toBeVisible();
        const backBox = (await dialog
          .getByRole("button", { name: "Back to app" })
          .boundingBox())!;
        if (desktop) {
          expect(backBox.y, "Back to app shares the traffic-light row").toBeLessThan(40);
          expect(backBox.x, "Back to app clears the native window controls").toBeGreaterThanOrEqual(62);
        }
        await expectSeparateRows(
          dialog.locator(
            '[role="tablist"][aria-orientation="vertical"] [role="tab"]',
          ),
        );
        for (const name of [
          "Security",
          "Appearance",
          "Notifications",
          "Language & shortcuts",
          // Personal access keys moved to Workspace settings › API keys.
          "Profile",
        ]) {
          const tab = dialog.getByRole("tab", { name, exact: true });
          await tab.click();
          await expect(tab).toHaveAttribute("aria-selected", "true");
          await expect(dialog.getByRole("tabpanel")).toBeVisible();
          await expect(dialog.getByRole("tabpanel")).toContainText(/\S/);
        }
        await dialog
          .getByRole("tab", { name: "Appearance", exact: true })
          .click();
        for (const theme of ["Light", "Dark", "System"]) {
          await chooseAppearanceTheme(page, dialog, theme);
          const expectedTheme =
            theme === "System"
              ? (await page.evaluate(
                  () => matchMedia("(prefers-color-scheme: dark)").matches,
                ))
                ? "dark"
                : "light"
              : theme.toLowerCase();
          await expect(page.locator("html")).toHaveClass(
            new RegExp(expectedTheme),
          );
          if (desktopApp) {
            await expect
              .poll(() =>
                desktopApp.evaluate(
                  ({ nativeTheme }) => nativeTheme.themeSource,
                ),
              )
              .toBe(theme.toLowerCase());
          }
          await expectSeparateRows(
            dialog.locator(
              '[role="tablist"][aria-orientation="vertical"] [role="tab"]',
            ),
          );
          // Cold dev routes can load the mono font after the dialog appears.
          // Finish font loading within the journey deadline before capture.
          await page.evaluate(async () => {
            await document.fonts.ready;
          });
          await page.screenshot({
            path: test.info().outputPath(`settings-${theme.toLowerCase()}.png`),
            scale: "css",
          });
        }
        await dialog.getByRole("button", { name: "Back to app" }).click();
        await page
          .getByRole("link", { name: "Customize", exact: true })
          .click();
        await expect(page).toHaveURL(/\/customize\/agents/);
        // By href, not by a /Kortix/i name: before the agent list renders, the
        // last link matching that name can be the Skills tab, and the click
        // lands on /customize/skills.
        await page
          .locator('a[href$="/customize/agents/kortix"]')
          .first()
          .click();
        await expect(page).toHaveURL(/\/customize\/agents\/kortix/);
        // The agent page's left rail: General, Access and Runtime rows.
        // By test id: the Triggers row's name carries its count.
        for (const key of ["basics", "skills", "connectors", "model", "triggers", "overview"]) {
          const tab = page.getByTestId(`agent-rail-${key}`);
          await tab.click();
          await expect(tab).toHaveAttribute("aria-current", "page");
          await expect(page.locator("main main")).toBeVisible();
          await expect(page.locator("main main")).toContainText(/\S/);
        }
        await page.screenshot({
          path: test.info().outputPath("agent-sections.png"),
          scale: "css",
        });
        // The capability bar's tab, not the agent editor's "Connectors"
        // section tab of the same name, which does not change the route.
        const connectors = page
          .locator(".kx-titlebar-tabs")
          .getByRole("tab", { name: "Connectors", exact: true });
        const isConnectorList = (response: import("@playwright/test").Response) =>
          new URL(response.url()).pathname ===
            `/v1/connectors/projects/${project!.id}/connectors` &&
          response.request().method() === "GET";
        // The page just mounted fetches its connectors too. Let that request
        // finish before the reload: one that starts in the few ms between
        // `reloadStartedAt` and the reload's own document passes the start-time
        // filter below, and the reload then discards its body (gate 37548429782:
        // "Response body is not available for a response that was navigated away").
        const mountedFetch = page
          .waitForResponse(isConnectorList, { timeout: 10_000 })
          .catch(() => undefined);
        await connectors.click();
        await expect(page).toHaveURL(/\/customize\/connectors/);
        await mountedFetch;
        // A fresh document must also load real data, independent of the agent
        // editor's cached connector query. Do not accept a Next.js page GET.
        // Only a request the RELOADED document started counts: the page just
        // mounted may still be revalidating its cached connectors (and the
        // Customize prefetch warms that entry), and that response arrives after
        // the reload with its body already discarded.
        // Read the body in a route handler: a response object loses its body
        // when the document navigates, and a start-time filter still lets one
        // through (gates 37548429782 and 37953042131).
        const listPath = `/v1/connectors/projects/${project!.id}/connectors`;
        const reloadedLists: Array<{ status: number; body: unknown }> = [];
        let reloaded = false;
        const captureList = async (route: import("@playwright/test").Route) => {
          if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== listPath) {
            return route.fallback();
          }
          const fetched = await route.fetch();
          const body = await fetched.json().catch(() => undefined);
          if (reloaded) reloadedLists.push({ status: fetched.status(), body });
          await route.fulfill({ response: fetched, json: body }).catch(() => {});
        };
        await page.route(`**${listPath}*`, captureList);
        reloaded = true;
        await page.reload();
        await expect.poll(() => reloadedLists.length, { timeout: 30_000 }).toBeGreaterThan(0);
        await page.unroute(`**${listPath}*`, captureList);
        expect(reloadedLists[0].status).toBe(200);
        expect(reloadedLists[0].body).toMatchObject({
          connectors: expect.any(Array),
        });
        await expect(
          page.getByRole("tab", { name: "Connected", exact: true }),
        ).toBeVisible();
        await page.getByRole("tab", { name: "Connected", exact: true }).click();
        await expect(
          page.getByRole("tab", { name: "Connected", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        await page.screenshot({
          path: test.info().outputPath("desktop-connectors.png"),
          scale: "css",
        });
        if (desktopApp) {
          await page
            .getByRole("button", { name: "Collapse sidebar", exact: true })
            .click();
          const edgePeek = page.locator('[data-slot="sidebar-edge-peek"]');
          await expect(edgePeek).toBeVisible();
          await edgePeek.hover();
          await expect(switcher).toBeVisible();
          const peekingSidebar = page.locator(
            '[data-slot="sidebar"][data-peek]',
          );
          const peekHeader = peekingSidebar.locator(
            '[data-slot="sidebar-header"]',
          );
          await expect(peekHeader).toBeVisible();
          const peekPadding = await peekHeader.evaluate((header) => {
            const style = getComputedStyle(header);
            return {
              top: Number.parseFloat(style.paddingTop),
              left: Number.parseFloat(style.paddingLeft),
            };
          });
          expect(peekPadding.top).toBeCloseTo(peekPadding.left, 2);
          await expect(
            page.getByRole("button", { name: "Pin sidebar", exact: true }),
          ).toHaveCount(1);
          await page.mouse.move(1300, 850);
        }
        await resize(page, desktopApp, 720, 480);
        // The sidebar is hidden at this width on both shells, so the toggle
        // reads "Open sidebar" (#9566: the mobile Sheet's own state names it,
        // not the desktop dock cookie).
        const opener = page.getByRole("button", {
          name: "Open sidebar",
          exact: true,
        });
        await expect(opener).toBeVisible();
        await opener.click();
        await expect(switcher).toBeVisible();
        await page.screenshot({
          path: test.info().outputPath("desktop-narrow-sidebar.png"),
          scale: "css",
        });
        await page.keyboard.press("Escape");
        await expect(switcher).toBeHidden();
        const settingsTab = page
          .locator(".kx-titlebar-tabs")
          .getByRole("tab", { name: "Settings", exact: true });
        await settingsTab.click();
        await expect(page).toHaveURL(/\/customize\/settings/);
        await expect(settingsTab).toBeInViewport();
        await page.screenshot({
          path: test.info().outputPath("desktop-narrow-settings.png"),
          scale: "css",
        });
        await resize(page, desktopApp, 1440, 900);
        if (desktopApp) {
          const window = await desktopApp.browserWindow(page);
          const originalZoom = await window.evaluate((window) =>
            window.webContents.getZoomFactor(),
          );
          await page.keyboard.press("Meta+=");
          await expect
            .poll(() =>
              window.evaluate((window) => window.webContents.getZoomFactor()),
            )
            .toBeGreaterThan(originalZoom);
          await page.keyboard.press("Meta+-");
          await page.keyboard.press("Meta+0");
          await expect
            .poll(() =>
              window.evaluate((window) => window.webContents.getZoomFactor()),
            )
            .toBe(originalZoom);
          const clickNativeMenu = (id: string) =>
            desktopApp.evaluate(({ Menu, BrowserWindow }, itemId) => {
              const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
              item?.click(
                undefined,
                BrowserWindow.getAllWindows()[0],
                undefined,
              );
            }, id);
          await clickNativeMenu("kx-view-zoom-in");
          await expect
            .poll(() =>
              window.evaluate((window) => window.webContents.getZoomFactor()),
            )
            .toBeGreaterThan(originalZoom);
          await clickNativeMenu("kx-view-actual-size");
          await expect
            .poll(() =>
              window.evaluate((window) => window.webContents.getZoomFactor()),
            )
            .toBe(originalZoom);

          await window.evaluate(async (window) => {
            if (window.isFullScreen()) return;
            await new Promise<void>((resolve) => {
              window.once("enter-full-screen", resolve);
              window.setFullScreen(true);
            });
          });
          await expect(page.locator("html")).toHaveAttribute(
            "data-desktop-fullscreen",
            "true",
          );
          await expect
            .poll(() =>
              page
                .locator("html")
                .evaluate((html) =>
                  getComputedStyle(html)
                    .getPropertyValue("--kx-titlebar-inset")
                    .trim(),
                ),
            )
            .toBe("0px");
          await page.reload();
          await expect(page.locator("html")).toHaveAttribute(
            "data-desktop-fullscreen",
            "true",
          );
          await window.evaluate(async (window) => {
            if (!window.isFullScreen()) return;
            await new Promise<void>((resolve) => {
              window.once("leave-full-screen", resolve);
              window.setFullScreen(false);
            });
          });
          await expect(page.locator("html")).not.toHaveAttribute(
            "data-desktop-fullscreen",
          );

          const windowsBeforePopup = desktopApp.windows().length;
          await page.evaluate(() => {
            window.open("", "connector-auth", "width=520,height=720");
          });
          await expect
            .poll(() => desktopApp.windows().length)
            .toBe(windowsBeforePopup + 1);
          const popup = desktopApp
            .windows()
            .find((candidate) => candidate !== page);
          expect(popup?.url()).toBe("about:blank");
          await popup?.close();

          const menuState = (id: string) =>
            desktopApp.evaluate(({ Menu }, itemId) => {
              const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
              return item
                ? { enabled: item.enabled, accelerator: item.accelerator }
                : null;
            }, id);
          await expect
            .poll(() => menuState("kx-file-new-session"))
            .toMatchObject({
              enabled: true,
              accelerator: "CommandOrControl+N",
            });
          await expect
            .poll(() => menuState("kx-file-close-tab"))
            .toMatchObject({
              enabled: true,
              accelerator: "CommandOrControl+W",
            });
          // KRTX-48: a production build (the shipped channel) shows one
          // "Change Kortix Instance…" entry and hides the developer presets.
          const frontendMenu = await desktopApp.evaluate(({ Menu }) => {
            const menu = Menu.getApplicationMenu();
            return {
              changeLabel:
                menu?.getMenuItemById("kx-change-instance")?.label ?? null,
              hasDevPresets: Boolean(menu?.getMenuItemById("kx-frontend-url")),
            };
          });
          expect(frontendMenu).toEqual({
            changeLabel: "Change Kortix Instance…",
            hasDevPresets: false,
          });
          await clickNativeMenu("kx-app-settings");
          await expect(page.getByRole("dialog")).toBeVisible();
          await page
            .getByRole("dialog")
            .getByRole("button", { name: "Back to app" })
            .click();
          await page
            .getByRole("button", { name: "Open sidebar", exact: true })
            .click();
          await expect(switcher).toBeInViewport();
          await switcher.click();
          await expect(
            page.getByRole("menuitem", { name: /^Settings/ }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
          // Full document navigation also stays in the explicitly configured
          // frontend. SPA routing alone does not exercise Electron's gate.
          await page.evaluate(
            (url) => window.location.assign(url),
            `${baseURL}/workspaces/${project.id}/customize/connectors`,
          );
          await expect(page).toHaveURL(/\/customize\/connectors/);
          await expect(
            page.getByRole("tab", { name: "Connected", exact: true }),
          ).toBeVisible();
          const denied = await desktopApp.evaluate(
            async ({ BrowserWindow }, options) => {
              const other = new BrowserWindow({
                show: false,
                webPreferences: {
                  contextIsolation: true,
                  preload: options.preload,
                },
              });
              try {
                await other.webContents.loadURL(options.url);
                return await other.webContents.executeJavaScript(
                  "window.__TAURI__.core.invoke('get_frontend_url').then(() => 'allowed', error => error.message)",
                );
              } finally {
                other.destroy();
              }
            },
            {
              url: `${baseURL}/favicon.png`,
              preload: fileURLToPath(
                new URL(
                  "../../../../apps/desktop-electron/src/preload.js",
                  import.meta.url,
                ),
              ),
            },
          );
          expect(denied).toContain("Unauthorized IPC sender");

          await resize(page, desktopApp, 720, 480);
          await page.goto(`${baseURL}/workspaces/${project.id}/settings/repositories`);
          const changeRepository = page.getByRole('button', { name: 'Change', exact: true });
          await expect(changeRepository).toBeVisible();
          await changeRepository.click();
          const repositoryDialog = page.getByRole('dialog', { name: 'Change repository' });
          await expect(repositoryDialog.getByRole('textbox', { name: 'New GitHub repository URL' })).toBeVisible();
          const confirmRepository = repositoryDialog.getByRole('button', { name: 'Change repository', exact: true });
          await expect(confirmRepository).toBeVisible();
          await expect.poll(() => confirmRepository.evaluate((button) => {
            const bounds = button.getBoundingClientRect();
            return bounds.bottom <= window.innerHeight;
          })).toBe(true);
          const cancelRepository = repositoryDialog.getByRole('button', { name: 'Cancel' });
          await expect.poll(() => cancelRepository.evaluate((button) => {
            const bounds = button.getBoundingClientRect();
            const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
            return hit === button || button.contains(hit);
          })).toBe(true);
          await page.screenshot({ path: test.info().outputPath('desktop-repository-change.png'), scale: 'css' });
          await cancelRepository.click();
          await expect(repositoryDialog).toBeHidden();
        }
        const key = await api<{ secret_id: string }>(
          session.access_token, 'POST', `/accounts/${accountId}/secret-resources`, {
            label: 'Desktop pooled key', provider_id: 'anthropic', name: 'ANTHROPIC_API_KEY',
            value: 'fake-desktop-key', consumer: 'llm_gateway', strategy: 'broker',
          }, 201,
        );
        pooledResource = { accountId, secretId: key.secret_id };
        await resize(page, desktopApp, 720, 480);
        await page.goto(`${baseURL}/workspaces/${project.id}/customize/models`);
        // Since #9801 a provider's keys open in its sheet; below 48rem it covers the list.
        await page.locator('[data-provider-row="anthropic"]').click();
        const providerKeys = page.getByRole('region', { name: 'Anthropic API keys' });
        await expect(providerKeys.getByText('Desktop pooled key')).toBeVisible();
        const welcome = page.getByRole('complementary', { name: 'Welcome from Marko' });
        if (await welcome.isVisible().catch(() => false)) {
          await welcome.getByRole('button', { name: 'Dismiss' }).click();
        }
        await providerKeys.getByRole('button', { name: 'Actions for Desktop pooled key' }).click();
        await expect(page.getByRole('menuitem', { name: 'Manage access' })).toBeVisible();
        await page.keyboard.press('Escape');
        await page.goto(`${baseURL}/workspaces/${project.id}`);
        await page.getByRole('button', { name: 'Session overrides' }).click();
        await page.getByRole('button', { name: /Provider keys/ }).click();
        await expect(page.getByRole('checkbox', { name: 'Desktop pooled key' })).toBeVisible();
      } finally {
        if (pooledResource) {
          await api(session.access_token, 'DELETE', `/accounts/${pooledResource.accountId}/secret-resources/${pooledResource.secretId}`).catch(() => {});
        }
        await dispose();
      }
    });
}
