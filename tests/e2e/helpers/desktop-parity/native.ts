import {
  expect,
  test as browserTest,
  type Locator,
  type ElectronApplication,
} from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runDatabaseSql } from "../database";
import { installBrowserSessionDirect } from "../session-auth";
import { dismissOnboarding, selectAccountForUi } from "../ui";
import {
  api,
  authOptions,
  provisionDesktopScene,
  openNativeDesktop,
  desktopDatabaseUrl,
  startBasicProxy,
} from "./fixture";

/** The journeys only the real Electron shell can run (E2E_DESKTOP_NATIVE=1). */
export function defineNativeDesktopParity(): void {
const nativeBrowserTest =
  process.env.E2E_DESKTOP_NATIVE === "1" ? browserTest : null;
nativeBrowserTest?.(
  "27 — desktop parity keeps the collapsed Customize header draggable",
  async ({ baseURL }) => {
    browserTest.setTimeout(120_000);
    const databaseUrl = desktopDatabaseUrl();
    const native = await openNativeDesktop(baseURL!, "drag");
    const { session, accounts, project, dispose } = await provisionDesktopScene({
      databaseUrl,
      emailPrefix: "e2e-desktop-drag",
      name: "Desktop drag region",
    });
    let app: ElectronApplication | undefined;
    try {
      app = await native.launch();
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");
      await installBrowserSessionDirect(
        main,
        session,
        `${baseURL}/workspaces/${project.id}/customize/agents`,
        authOptions,
      );
      await selectAccountForUi(main, accounts[0].account_id);
      await dismissOnboarding(main);
      await main.getByRole("button", { name: "Collapse sidebar" }).click();
      // The Agents index header (`CustomizeHeader`): the one title-bar row
      // every Customize page draws, now that Customize has no top bar.
      const row = main
        .locator("header.kx-titlebar-row[data-sidebar-collapsed='true']")
        .first();
      await expect(row).toBeVisible();
      const dragPoint = () =>
        row.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const y = Math.round(rect.top + rect.height / 2);
          for (let x = Math.round(rect.left + 120); x < rect.right - 8; x += 8) {
            const target = document.elementFromPoint(x, y);
            if (!target || !element.contains(target)) continue;
            if (target.closest("button,a,input,[role='button'],[role='tab']")) continue;
            for (let node: Element | null = target; node && element.contains(node); node = node.parentElement) {
              const region = getComputedStyle(node).webkitAppRegion;
              if (region === "no-drag") break;
              if (region === "drag") return { x, y };
            }
          }
          return null;
        });
      expect(await dragPoint()).not.toBeNull();
      const control = row.getByRole("button", { name: "New agent" });
      await expect(control).toBeVisible();
      expect(
        await control.evaluate((element) => getComputedStyle(element).webkitAppRegion),
      ).toBe("no-drag");
      const nativeWindow = await app.browserWindow(main);
      await nativeWindow.evaluate((window) => window.setContentSize(720, 480));
      await expect.poll(dragPoint).not.toBeNull();
      const opener = main.getByRole("button", { name: "Open sidebar" });
      await opener.hover();
      expect(await dragPoint()).not.toBeNull();
    } finally {
      await native.dispose();
      await dispose();
    }
  },
);
nativeBrowserTest?.(
  "27 — desktop parity guards reload, Home, close, and quit with an unsaved agent draft",
  async ({ baseURL }) => {
    browserTest.setTimeout(240_000);
    const databaseUrl = desktopDatabaseUrl();
    const native = await openNativeDesktop(baseURL!, "unsaved");
    const { session, accounts, project, dispose } = await provisionDesktopScene({
      databaseUrl,
      emailPrefix: "e2e-desktop-unsaved",
      name: "Desktop unsaved draft",
    });
    let app: ElectronApplication | undefined;
    try {
      app = await native.launch();
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");
      // Electron answers the native unload prompt. Prevent Playwright from
      // dismissing a Chromium dialog that Electron already consumed.
      main.on("dialog", () => {});
      const agentUrl = `${baseURL}/workspaces/${project.id}/customize/agents/kortix`;
      await installBrowserSessionDirect(main, session, agentUrl, authOptions);
      await selectAccountForUi(main, accounts[0].account_id);
      await dismissOnboarding(main);
      await main.goto(agentUrl);
      // The Overview's description is its text until clicked, then a field.
      await main.getByRole("button", { name: "Description", exact: true }).click({ timeout: 60_000 });
      const description = main.getByRole("textbox", { name: /Description/i });
      await expect(description).toBeVisible({ timeout: 60_000 });
      const original = await description.inputValue();
      const draft = `${original} Unsaved desktop draft`;

      await app.evaluate(({ dialog }) => {
        const state = {
          original: dialog.showMessageBoxSync,
          response: 1,
          calls: [] as string[],
        };
        const shared = globalThis as typeof globalThis & {
          __kortixUnloadProbe?: typeof state;
        };
        shared.__kortixUnloadProbe = state;
        dialog.showMessageBoxSync = (...args) => {
          const options = args.at(-1) as { message: string };
          state.calls.push(options.message);
          return state.response;
        };
      });
      const setResponse = (response: number) =>
        app!.evaluate((_, next) => {
          const shared = globalThis as typeof globalThis & {
            __kortixUnloadProbe?: { response: number };
          };
          if (!shared.__kortixUnloadProbe)
            throw new Error("unload probe missing");
          shared.__kortixUnloadProbe.response = next;
        }, response);
      const calls = () =>
        app!.evaluate(() => {
          const shared = globalThis as typeof globalThis & {
            __kortixUnloadProbe?: { calls: string[] };
          };
          return shared.__kortixUnloadProbe?.calls ?? [];
        });
      const agentState = () =>
        app!.evaluate(async ({ BrowserWindow }, origin) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().startsWith(origin),
          );
          if (!window) throw new Error("main window not found");
          return {
            url: window.webContents.getURL(),
            description: await window.webContents.executeJavaScript(
              "document.querySelector('textarea[aria-label=\"Description\"]')?.value ?? null",
            ),
          };
        }, baseURL!);

      await description.fill(draft);
      await expect(
        main.getByRole("button", { name: /Save/i }).last(),
      ).toBeVisible();
      await main.keyboard.press("Meta+R");
      await expect.poll(async () => (await calls()).length).toBe(1);
      expect(await calls()).toEqual(["Leave this page?"]);
      await expect
        .poll(agentState)
        .toEqual({ url: agentUrl, description: draft });

      await setResponse(0);
      await main.keyboard.press("Meta+R");
      await expect.poll(async () => (await calls()).length).toBe(2);
      await expect(description).toHaveValue(original, { timeout: 60_000 });
      await expect(
        main.getByRole("button", { name: /Save/i }).last(),
      ).toBeHidden();

      await Promise.all([
        main.waitForEvent("domcontentloaded"),
        main.keyboard.press("Meta+R"),
      ]);
      await expect(description).toHaveValue(original);
      expect(await calls()).toHaveLength(2);

      await description.fill(draft);
      await setResponse(1);
      const goHome = () =>
        app!.evaluate(({ BrowserWindow, Menu }) => {
          const item = Menu.getApplicationMenu()?.getMenuItemById("kx-go-home");
          const window = BrowserWindow.getAllWindows()[0];
          if (!item || !window) throw new Error("Home menu unavailable");
          item.click(undefined, window, undefined);
        });
      await goHome();
      await expect.poll(async () => (await calls()).length).toBe(3);
      await expect
        .poll(agentState)
        .toEqual({ url: agentUrl, description: draft });
      await setResponse(0);
      await goHome();
      await expect.poll(async () => (await calls()).length).toBe(4);
      await expect
        .poll(() => new URL(main.url()).pathname, { timeout: 60_000 })
        .toMatch(/^\/workspaces(?:\/[a-z0-9-]+)?$/);

      await main.goto(agentUrl);
      await expect(description).toBeVisible({ timeout: 60_000 });
      await description.fill(draft);
      await setResponse(1);
      await app.evaluate(({ app }) => {
        setImmediate(() => app.quit());
      });
      await expect.poll(async () => (await calls()).length).toBe(5);
      expect(main.isClosed()).toBe(false);
      await expect
        .poll(agentState)
        .toEqual({ url: agentUrl, description: draft });
      const closeWindow = () =>
        app!.evaluate(({ BrowserWindow }, origin) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().startsWith(origin),
          );
          if (!window) throw new Error("main window not found");
          setImmediate(() => window.close());
        }, baseURL!);
      await setResponse(1);
      await closeWindow();
      await expect.poll(async () => (await calls()).length).toBe(6);
      expect(main.isClosed()).toBe(false);
      await expect
        .poll(agentState)
        .toEqual({ url: agentUrl, description: draft });
      await setResponse(0);
      await closeWindow();
      await expect.poll(async () => (await calls()).length).toBe(7);
      await expect.poll(() => main.isClosed()).toBe(true);

      await app.evaluate(({ app }) => app.emit("activate"));
      await expect
        .poll(() =>
          app!.windows().some((window) => window.url().startsWith(baseURL!)),
        )
        .toBe(true);
      const reopened = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!reopened) throw new Error("reopened main window not found");
      reopened.on("dialog", () => {});
      await installBrowserSessionDirect(
        reopened,
        session,
        agentUrl,
        authOptions,
      );
      await selectAccountForUi(reopened, accounts[0].account_id);
      await dismissOnboarding(reopened);
      await reopened.goto(agentUrl);
      const reopenedDescription = reopened.getByRole("textbox", {
        name: /Description/i,
      });
      await expect(reopenedDescription).toBeVisible({ timeout: 60_000 });
      await reopenedDescription.fill(draft);
      await setResponse(0);
      const process = app.process();
      const appClosed = app.waitForEvent("close", { timeout: 15_000 });
      await app.evaluate(({ app }) => {
        setImmediate(() => app.quit());
      });
      await appClosed;
      expect(process.exitCode).toBe(0);
      app = undefined;
    } finally {
      if (app) {
        await app.evaluate(() => {
          const shared = globalThis as typeof globalThis & {
            __kortixUnloadProbe?: { response: number };
          };
          if (shared.__kortixUnloadProbe)
            shared.__kortixUnloadProbe.response = 0;
        });
      }
      await native.dispose();
      await dispose();
    }
  },
);
nativeBrowserTest?.(
  "27 — desktop parity clears native controls on Apps, Files, account hub, and admin",
  async ({ baseURL }) => {
    browserTest.setTimeout(180_000);
    const databaseUrl = desktopDatabaseUrl();
    const native = await openNativeDesktop(baseURL!, "geometry");
    const { user, session, accounts, project, dispose } = await provisionDesktopScene({
      databaseUrl,
      emailPrefix: "e2e-desktop-geometry",
      name: "Desktop header geometry",
    });
    let app: ElectronApplication | undefined;
    let adminRoleGranted = false;
    try {
      // The titlebar row below carries the notification bell, which every
      // project renders (KRTX-1742; the flag graduated on 2026-11-06).
      app = await native.launch();
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");
      await installBrowserSessionDirect(
        main,
        session,
        `${baseURL}/workspaces/${project.id}`,
        authOptions,
      );
      await selectAccountForUi(main, accounts[0].account_id);
      await dismissOnboarding(main);
      const nativeWindow = await app.browserWindow(main);
      await nativeWindow.evaluate((window) => window.setContentSize(1100, 700));
      const currentZoom = () =>
        nativeWindow.evaluate((window) => window.webContents.getZoomFactor());
      const centeredInBand = async (control: Locator) => {
        const box = (await control.boundingBox())!;
        const centerY = (box.y + box.height / 2) * (await currentZoom());
        expect(Math.abs(centerY - 20)).toBeLessThanOrEqual(1);
      };
      const clearsLights = async (control: Locator) => {
        const box = (await control.boundingBox())!;
        expect(box.x * (await currentZoom())).toBeGreaterThanOrEqual(71.5);
      };
      const projectRow = main.locator(".kx-project-sidebar-titlebar");
      await expect(projectRow).toBeVisible();
      const switcher = projectRow.locator("[data-sidebar='menu-button']");
      const projectSearch = projectRow.getByRole("button", { name: /Search/i });
      const projectCollapse = projectRow.getByRole("button", { name: "Collapse sidebar" });
      // The notification bell left this row: the Inbox is a sidebar item.
      for (const control of [projectRow, switcher, projectSearch, projectCollapse]) {
        await expect(control).toBeVisible();
        await centeredInBand(control);
      }
      await clearsLights(switcher);
      for (let index = 0; index < 3; index++) await main.keyboard.press("Meta+=");
      await expect.poll(currentZoom).toBeGreaterThan(1.2);
      for (const control of [switcher, projectSearch, projectCollapse]) {
        await centeredInBand(control);
        await clearsLights(control);
      }
      await main.keyboard.press("Meta+0");
      await expect.poll(currentZoom).toBe(0.94);
      await main.getByRole("button", { name: "Collapse sidebar" }).click();

      for (const route of ["apps", "files", "reminders"] as const) {
        await main.goto(`${baseURL}/workspaces/${project.id}/${route}`);
        const row = main
          .locator(".kx-titlebar-row[data-sidebar-collapsed='true']")
          .first();
        await expect(row).toBeVisible({ timeout: 60_000 });
        await expect(row).toHaveAttribute("data-sidebar-collapsed", "true");
        await expect
          .poll(
            async () => {
              const box = (await row.boundingBox())!;
              return (box.y + box.height / 2) * (await currentZoom());
            },
            { timeout: 15_000 },
          )
          .toBeCloseTo(20, 0);
        if (route === "apps") {
          await expect
            .poll(
              async () => {
                const box = (await row.locator("h1").boundingBox())!;
                return (box.y + box.height / 2) * (await currentZoom());
              },
              { timeout: 15_000 },
            )
            .toBeCloseTo(20, 0);
        }
        const dragRegion = await row.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const y = Math.round(rect.top + rect.height / 2);
          const appRegion = getComputedStyle(element).webkitAppRegion;
          for (
            let x = Math.round(rect.left + 160);
            x < rect.right - 160;
            x += 16
          ) {
            const target = document.elementFromPoint(x, y);
            if (!target || !element.contains(target)) continue;
            if (target.closest("button,a,input,[role='button'],[role='tab']"))
              continue;
            return { appRegion, emptyPoint: { x, y } };
          }
          throw new Error("no empty drag point in header");
        });
        expect(dragRegion.appRegion).toBe("drag");
        expect(dragRegion.emptyPoint.x).toBeGreaterThan(0);
        const control = row
          .locator("button,a,input,[role='button'],[role='tab']")
          .first();
        await expect(control).toBeVisible();
        expect(
          await control.evaluate(
            (element) => getComputedStyle(element).webkitAppRegion,
          ),
        ).toBe("no-drag");
      }

      // Apps share the web preview shell, including its native control inset.
      await api(session.access_token, "PATCH", `/projects/${project.id}/features`, {
        feature: "apps", enabled: true,
      });
      await api(session.access_token, "POST", `/projects/${project.id}/apps`, {
        slug: `desktop-preview-${Date.now()}`, name: "Desktop Preview",
      }, 201);
      await main.goto(`${baseURL}/workspaces/${project.id}/apps`);
      const previewCard = main.getByRole("button", { name: "Open Desktop Preview" });
      await previewCard.click();
      const preview = main.getByRole("dialog", { name: "Desktop Preview App" });
      await expect(preview).toBeVisible();
      const geometry = await preview.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const headerElement = element.querySelector("header");
        if (!headerElement) throw new Error("App preview header is missing");
        const header = headerElement.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height,
          viewportWidth: innerWidth, viewportHeight: innerHeight, headerTop: header.top };
      });
      expect(geometry.x).toBe(0);
      expect(geometry.y).toBe(0);
      expect(Math.abs(geometry.width - geometry.viewportWidth)).toBeLessThan(1);
      expect(Math.abs(geometry.height - geometry.viewportHeight)).toBeLessThan(1);
      expect(geometry.headerTop * await currentZoom()).toBeGreaterThanOrEqual(40);
      await preview.getByRole("button", { name: "Close", exact: true }).click();
      await expect(previewCard).toBeVisible();

      await nativeWindow.evaluate(async (window) => {
        await new Promise<void>((resolve) => {
          window.once("enter-full-screen", resolve);
          window.setFullScreen(true);
        });
      });
      await expect(main.locator("html")).toHaveAttribute(
        "data-desktop-fullscreen",
        "true",
      );
      await expect
        .poll(async () =>
          main
            .locator(".kx-titlebar-band-height")
            .first()
            .evaluate((element) => element.getBoundingClientRect().height),
        )
        .toBeGreaterThan(40);
      await nativeWindow.evaluate(async (window) => {
        await new Promise<void>((resolve) => {
          window.once("leave-full-screen", resolve);
          window.setFullScreen(false);
        });
      });
      await expect(main.locator("html")).not.toHaveAttribute(
        "data-desktop-fullscreen",
      );

      await main.goto(
        `${baseURL}/workspaces/${project.id}?accountId=${accounts[0].account_id}`,
      );
      const hub = main.getByRole("dialog");
      await expect(hub).toBeVisible({ timeout: 60_000 });
      await expect(hub.locator(".kx-titlebar-spacer")).toHaveCount(0);
      const sidebarRow = hub.locator(".kx-overlay-sidebar-titlebar");
      const breadcrumbRow = hub.locator(".kx-account-hub-header");
      await expect(sidebarRow).toBeVisible();
      await expect(breadcrumbRow).toBeVisible();
      await centeredInBand(sidebarRow);
      await centeredInBand(breadcrumbRow);
      await centeredInBand(breadcrumbRow.getByRole("navigation", { name: "breadcrumb" }));
      // Since #9750 the hub titlebar carries no search button.
      const back = sidebarRow.getByRole("button", { name: /Back to app/i });
      const collapse = sidebarRow.getByRole("button", { name: "Toggle Sidebar" });
      for (const control of [back, collapse]) {
        await expect(control).toBeVisible();
        await centeredInBand(control);
        await clearsLights(control);
      }
      await collapse.click();
      await expect(breadcrumbRow).toHaveAttribute("data-sidebar-collapsed", "");
      const reopen = breadcrumbRow.getByRole("button", { name: "Toggle Sidebar" });
      const breadcrumb = breadcrumbRow.getByRole("navigation", { name: "breadcrumb" });
      await clearsLights(reopen);
      await centeredInBand(reopen);
      await centeredInBand(breadcrumb);
      const reopenBox = (await reopen.boundingBox())!;
      const breadcrumbBox = (await breadcrumb.boundingBox())!;
      expect(breadcrumbBox.x).toBeGreaterThanOrEqual(reopenBox.x + reopenBox.width);

      for (let index = 0; index < 3; index++) await main.keyboard.press("Meta+=");
      await expect
        .poll(currentZoom)
        .toBeGreaterThan(1.2);
      await clearsLights(reopen);
      await centeredInBand(reopen);
      await centeredInBand(breadcrumb);
      await nativeWindow.evaluate((window) => window.setContentSize(720, 480));
      await expect
        .poll(async () => nativeWindow.evaluate((window) => window.getContentSize()))
        .toEqual([720, 480]);
      await clearsLights(reopen);
      await centeredInBand(reopen);
      await centeredInBand(breadcrumb);
      await nativeWindow.evaluate((window) => window.setContentSize(1100, 700));
      await main.keyboard.press("Meta+0");
      await expect.poll(currentZoom).toBe(0.94);

      await nativeWindow.evaluate(async (window) => {
        await new Promise<void>((resolve) => {
          window.once("enter-full-screen", resolve);
          window.setFullScreen(true);
        });
      });
      await expect(main.locator("html")).toHaveAttribute("data-desktop-fullscreen", "true");
      expect((await reopen.boundingBox())!.x * (await currentZoom())).toBeLessThan(24);
      await nativeWindow.evaluate(async (window) => {
        await new Promise<void>((resolve) => {
          window.once("leave-full-screen", resolve);
          window.setFullScreen(false);
        });
      });
      await expect(main.locator("html")).not.toHaveAttribute("data-desktop-fullscreen");
      await reopen.click();
      await expect(sidebarRow).toBeVisible();
      await back.click();
      await expect(hub).not.toBeVisible();

      await main.keyboard.press("Meta+,");
      const settings = main.getByRole("dialog");
      await expect(settings).toBeVisible();
      await expect(settings.locator(".kx-titlebar-spacer")).toHaveCount(0);
      const settingsBack = settings.getByRole("button", { name: /Back to app/i });
      const settingsBreadcrumb = settings.getByRole("navigation", { name: "breadcrumb" });
      await centeredInBand(settingsBack);
      await centeredInBand(settingsBreadcrumb);
      await clearsLights(settingsBack);
      await nativeWindow.evaluate((window) => window.setContentSize(720, 480));
      for (let index = 0; index < 3; index++) await main.keyboard.press("Meta+=");
      await expect.poll(currentZoom).toBeGreaterThan(1.2);
      // Narrow Settings opens on its section list; its header shares the band.
      const mobileSettingsRow = settings.locator(".kx-settings-mobile-titlebar");
      const mobileSettingsClose = mobileSettingsRow.locator(".kx-settings-mobile-close");
      await expect(mobileSettingsRow).toBeVisible();
      await expect(settings.getByRole("tab").first()).toBeVisible();
      await centeredInBand(mobileSettingsRow);
      await centeredInBand(mobileSettingsClose);
      const mobileRowBox = (await mobileSettingsRow.boundingBox())!;
      const mobileCloseBox = (await mobileSettingsClose.boundingBox())!;
      expect(mobileCloseBox.y).toBeGreaterThanOrEqual(mobileRowBox.y - 1);
      expect(mobileCloseBox.y + mobileCloseBox.height).toBeLessThanOrEqual(
        mobileRowBox.y + mobileRowBox.height + 1,
      );
      await main.keyboard.press("Meta+0");
      await nativeWindow.evaluate((window) => window.setContentSize(1100, 700));
      await expect(settingsBack).toBeVisible();
      await settingsBack.click();
      await expect(settings).not.toBeVisible();

      await runDatabaseSql(
        `INSERT INTO kortix.platform_user_roles (account_id, role)
         VALUES ($1::uuid, 'super_admin'::kortix.platform_role)
         ON CONFLICT (account_id) DO UPDATE SET role = EXCLUDED.role`,
        [user.id],
        databaseUrl,
      );
      adminRoleGranted = true;
      await main
        .context()
        .addCookies([
          { name: "admin_sidebar_state", value: "false", url: baseURL! },
        ]);
      await main.goto(`${baseURL}/admin`);
      await expect(
        main.getByRole("heading", { name: "Overview" }).first(),
      ).toBeVisible({
        timeout: 60_000,
      });
      const adminRow = main.locator(".kx-titlebar-row").first();
      await expect(adminRow).toHaveAttribute("data-sidebar-collapsed", "");
      const adminToggle = adminRow.getByRole("button").first();
      await expect(adminToggle).toBeVisible();
      const toggleBox = (await adminToggle.boundingBox())!;
      const adminZoom = await currentZoom();
      expect(toggleBox.x * adminZoom).toBeGreaterThanOrEqual(72);
      expect((toggleBox.y + toggleBox.height / 2) * adminZoom).toBeCloseTo(
        20,
        0,
      );
    } finally {
      if (adminRoleGranted)
        await runDatabaseSql(
          "DELETE FROM kortix.platform_user_roles WHERE account_id = $1::uuid",
          [user.id],
          databaseUrl,
        );
      await native.dispose();
      await dispose();
    }
  },
);
nativeBrowserTest?.(
  "27 — desktop parity restores the native theme before the first window and matches popups",
  async ({ baseURL }) => {
    browserTest.setTimeout(180_000);
    const native = await openNativeDesktop(baseURL!, "theme");
    let app: ElectronApplication | undefined;
    try {
      await writeFile(
        join(native.profile, "theme.json"),
        JSON.stringify({ theme: "light" }),
        "utf8",
      );
      app = await native.launch();
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");

      const launchTheme = await app.evaluate(
        ({ BrowserWindow, nativeTheme }, origin) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().startsWith(origin),
          );
          return {
            source: nativeTheme.themeSource,
            dark: nativeTheme.shouldUseDarkColors,
            background: window?.getBackgroundColor(),
          };
        },
        baseURL!,
      );
      expect(launchTheme).toMatchObject({ source: "light", dark: false });
      expect(launchTheme.background?.toUpperCase().startsWith("#FFFFFF")).toBe(
        true,
      );
      expect(
        await main.evaluate(
          () => matchMedia("(prefers-color-scheme: dark)").matches,
        ),
      ).toBe(false);

      await main.evaluate(() =>
        window.open("", "theme-popup", "width=520,height=720"),
      );
      await expect
        .poll(
          () =>
            app!.windows().filter((window) => window.url() === "about:blank")
              .length,
        )
        .toBe(1);
      const lightPopupBackground = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "about:blank")
          ?.getBackgroundColor(),
      );
      expect(lightPopupBackground?.toUpperCase().startsWith("#FFFFFF")).toBe(
        true,
      );

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "about:blank")
          ?.close();
      });
      await main.evaluate(() =>
        window.__TAURI__?.core.invoke("set_native_theme", { theme: "dark" }),
      );
      await main.evaluate(() =>
        window.open("", "theme-popup-dark", "width=520,height=720"),
      );
      await expect
        .poll(
          () =>
            app!.windows().filter((window) => window.url() === "about:blank")
              .length,
        )
        .toBe(1);
      const darkPopupBackground = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "about:blank")
          ?.getBackgroundColor(),
      );
      expect(darkPopupBackground?.toUpperCase().startsWith("#0A0A0A")).toBe(
        true,
      );
    } finally {
      await native.dispose();
    }
  },
);
nativeBrowserTest?.(
  "27 — desktop parity recovers when Supabase authentication does not answer",
  async ({ baseURL }) => {
    browserTest.setTimeout(180_000);
    const databaseUrl = desktopDatabaseUrl();
    const native = await openNativeDesktop(baseURL!, "auth-timeout");
    const { session, project, dispose } = await provisionDesktopScene({
      databaseUrl,
      emailPrefix: "e2e-desktop-auth-timeout",
      name: "Desktop auth timeout",
    });
    let app: ElectronApplication | undefined;
    try {
      app = await native.launch();
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");

      let blockedUserReads = 0;
      await main.route("**/auth/v1/user", async () => {
        blockedUserReads += 1;
        await new Promise(() => {});
      });
      await installBrowserSessionDirect(
        main,
        session,
        `${baseURL}/workspaces/${project.id}`,
        authOptions,
      );

      const alert = main
        .getByRole("alert")
        .filter({ hasText: "Authentication is not responding" });
      await expect(alert).toContainText("Authentication is not responding", {
        timeout: 25_000,
      });
      await expect(
        alert.getByRole("button", { name: "Retry", exact: true }),
      ).toBeVisible();
      await expect(
        alert.getByRole("button", { name: "Sign out", exact: true }),
      ).toBeVisible();

      await alert.getByRole("button", { name: "Retry", exact: true }).click();
      await expect
        .poll(() => blockedUserReads, { timeout: 10_000 })
        .toBeGreaterThan(1);
      await alert
        .getByRole("button", { name: "Sign out", exact: true })
        .click();
      await expect(main).toHaveURL(/\/auth(?:\?|$)/, { timeout: 15_000 });
    } finally {
      await native.dispose();
      await dispose();
    }
  },
);
nativeBrowserTest?.(
  "27 — desktop parity authenticates an HTTP proxy and recovers from cancel",
  async ({ baseURL }) => {
    browserTest.setTimeout(240_000);
    const native = await openNativeDesktop(baseURL!, "proxy");
    const firstProxy = await startBasicProxy(baseURL!);
    const secondProxy = await startBasicProxy(baseURL!);
    let app: ElectronApplication | undefined;
    try {
      app = await native.launch();
      const main = app
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!main) throw new Error("native main window not found");
      const routeThrough = async (proxyRules: string) => {
        await app!.evaluate(async ({ session }, rules) => {
          await session.defaultSession.setProxy({
            proxyRules: rules,
            proxyBypassRules: "<-loopback>",
          });
        }, proxyRules);
        // The proxy challenge aborts the in-flight navigation while Electron
        // opens its modal sign-in window. That abort is the expected signal.
        await main.reload().catch(() => null);
      };
      const authWindow = async () => {
        await expect
          .poll(
            () =>
              app!
                .windows()
                .find((window) => window.url().endsWith("/basic-auth.html"))
                ?.url() || "",
            { timeout: 60_000 },
          )
          .toContain("basic-auth.html");
        const window = app!
          .windows()
          .find((candidate) => candidate.url().endsWith("/basic-auth.html"));
        if (!window) throw new Error("proxy sign-in window not found");
        return window;
      };

      await routeThrough(firstProxy.url);
      let auth = await authWindow();
      await expect(auth.locator("#host")).toHaveText("127.0.0.1");
      await auth.locator("#user").fill("proxy-user");
      await auth.locator("#pass").fill("wrong");
      await auth.locator("#submit").click();

      auth = await authWindow();
      await expect(auth.locator("#error")).toContainText(
        "rejected the username or password",
      );
      await auth.locator("#user").fill("proxy-user");
      await auth.locator("#pass").fill("proxy-pass");
      await auth.locator("#submit").click();
      await expect
        .poll(
          () =>
            app!.windows().some((window) => window.url().startsWith(baseURL!)),
          { timeout: 120_000 },
        )
        .toBe(true);
      expect(firstProxy.stats().challenges).toBeGreaterThanOrEqual(2);
      expect(firstProxy.stats().authorizedRequests).toBeGreaterThan(0);

      await routeThrough(secondProxy.url);
      auth = await authWindow();
      await auth.locator("#cancel").click();
      await expect
        .poll(
          () =>
            app!
              .windows()
              .find((window) => window.url().endsWith("/instance-chooser.html"))
              ?.url() || "",
          { timeout: 60_000 },
        )
        .toContain("instance-chooser.html");
      const chooser = app
        .windows()
        .find((window) => window.url().endsWith("/instance-chooser.html"));
      if (!chooser) throw new Error("proxy recovery window not found");
      await expect(chooser.locator("#title")).toContainText("Can’t reach");
      await expect(chooser.locator("#primary")).toHaveText("Try Again");
      await expect(chooser.locator("#error")).toContainText(
        "Proxy sign-in for 127.0.0.1 was cancelled",
      );
    } finally {
      await native.dispose();
      await Promise.allSettled([firstProxy.close(), secondProxy.close()]);
    }
  },
);

nativeBrowserTest?.(
  "27 — desktop parity persists window state across a process relaunch",
  async ({ baseURL }) => {
    browserTest.setTimeout(240_000);
    const native = await openNativeDesktop(baseURL!, "relaunch");
    let first: ElectronApplication | undefined;
    let second: ElectronApplication | undefined;
    try {
      first = await native.launch();
      const firstPage = first
        .windows()
        .find((window) => window.url().startsWith(baseURL!));
      if (!firstPage) throw new Error("first native page not found");
      await expect(firstPage.locator("html")).toHaveAttribute(
        "data-desktop",
        "true",
      );
      await expect
        .poll(() =>
          first!.evaluate(({ BrowserWindow }, origin) => {
            const main = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().startsWith(origin),
            );
            return main?.webContents.getZoomFactor() ?? 0;
          }, baseURL!),
        )
        .toBeCloseTo(0.94);
      const initialZoom = await first.evaluate(({ BrowserWindow }, origin) => {
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith(origin),
        );
        if (!main) throw new Error("first native main window not found");
        return main.webContents.getZoomFactor();
      }, baseURL!);
      await firstPage.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("kortix-desktop-command", { detail: "zoom-in" }),
        );
      });
      await expect
        .poll(() =>
          first!.evaluate(({ BrowserWindow }, origin) => {
            const main = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().startsWith(origin),
            );
            return main?.webContents.getZoomFactor() ?? 0;
          }, baseURL!),
        )
        .toBeGreaterThan(initialZoom);
      const expectedZoom = await first.evaluate(({ BrowserWindow }, origin) => {
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith(origin),
        );
        if (!main) throw new Error("first native main window not found");
        return main.webContents.getZoomFactor();
      }, baseURL!);
      const expectedBounds = await first.evaluate(
        async ({ BrowserWindow, screen }, origin) => {
          const main = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().startsWith(origin),
          );
          if (!main) throw new Error("first native main window not found");
          const area = screen.getPrimaryDisplay().workArea;
          const bounds = {
            x: area.x + 90,
            y: area.y + 80,
            width: Math.min(960, area.width - 180),
            height: Math.min(660, area.height - 160),
          };
          main.unmaximize();
          main.setBounds(bounds);
          await new Promise((resolve) => setTimeout(resolve, 350));
          main.maximize();
          await new Promise((resolve) => setTimeout(resolve, 350));
          return bounds;
        },
        baseURL!,
      );
      await first.close();
      first = undefined;

      second = await native.launch();
      await expect
        .poll(() =>
          second!.evaluate(({ BrowserWindow }, origin) => {
            const main = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().startsWith(origin),
            );
            return main?.isMaximized() ?? false;
          }, baseURL!),
        )
        .toBe(true);
      const restored = await second.evaluate(({ BrowserWindow }, origin) => {
        const main = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith(origin),
        );
        if (!main) throw new Error("restarted native main window not found");
        return {
          maximized: main.isMaximized(),
          normalBounds: main.getNormalBounds(),
          zoom: main.webContents.getZoomFactor(),
        };
      }, baseURL!);
      expect(restored.maximized).toBe(true);
      expect(restored.normalBounds).toEqual(expectedBounds);
      expect(restored.zoom).toBe(expectedZoom);
    } finally {
      await native.dispose();
    }
  },
);
}
