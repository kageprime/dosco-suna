import { expect } from "@playwright/test";
import { installBrowserSessionDirect } from "../session-auth";
import { dismissOnboarding, selectAccountForUi } from "../ui";
import {
  authOptions,
  pinMacPlatform,
  provisionDesktopScene,
  resize,
  desktopDatabaseUrl,
  test,
} from "./fixture";

export function defineFrameParity(desktop: boolean): void {
    test("a frame without product navigation keeps a way back", async ({
      page,
      baseURL,
      desktopApp,
    }) => {
      test.setTimeout(180_000);
      await pinMacPlatform(page);
      const { session, dispose } = await provisionDesktopScene({
        emailPrefix: "e2e-desktop-back",
      });
      try {
        // No request_id: the OAuth consent page resolves to a status screen
        // with no action. The desktop shell has no browser toolbar, so before
        // the frame drew Back this screen was a dead end there.
        const deadEnd = `${baseURL}/oauth/authorize`;
        const heading = (target: typeof page) =>
          target.getByRole("heading", {
            name: "Invalid authorization request",
          });
        await installBrowserSessionDirect(page, session, deadEnd, authOptions);
        await page.goto(`${baseURL}/dashboard`, { waitUntil: "domcontentloaded" });
        await page.goto(deadEnd, { waitUntil: "domcontentloaded" });
        await expect(heading(page)).toBeVisible({ timeout: 60_000 });
        const back = page.getByRole("button", { name: "Back", exact: true });
        if (!desktop) {
          // The web keeps the browser's own Back. The frame draws none.
          await expect(back).toHaveCount(0);
          return;
        }
        await expect(back).toBeVisible();
        const box = await back.boundingBox();
        expect(
          box!.x,
          "Back must clear the macOS traffic lights",
        ).toBeGreaterThanOrEqual(62);
        expect(
          box!.y + box!.height,
          "Back must sit inside the title-bar band",
        ).toBeLessThanOrEqual(43);
        // installBrowserSessionDirect lands on /favicon.png first, so an entry
        // is behind the dead end. The browser steps back onto it. The desktop
        // shell cancels a renderer history.back() into it (not an app path) and
        // steps over it instead, to /auth, which sends a signed-in user on.
        await back.click();
        await expect(page).not.toHaveURL(/\/oauth\/authorize/, {
          timeout: 60_000,
        });
        if (desktopApp) return;
        // A window opened straight onto the dead end has no in-app entry
        // behind it (about:blank is another origin), so Back goes home.
        const fresh = await page.context().newPage();
        try {
          await fresh.goto(deadEnd);
          await expect(heading(fresh)).toBeVisible({ timeout: 60_000 });
          await fresh
            .getByRole("button", { name: "Back", exact: true })
            .click();
          await expect(fresh).not.toHaveURL(/\/oauth\/authorize/, {
            timeout: 60_000,
          });
        } finally {
          await fresh.close();
        }
      } finally {
        await dispose();
      }
    });

    test("Create a workspace keeps a way back to the workspace it opened from", async ({
      page,
      baseURL,
      desktopApp,
    }) => {
      test.setTimeout(300_000);
      const databaseUrl = desktopDatabaseUrl();
      await pinMacPlatform(page);
      const { email, session, accounts, project, dispose } = await provisionDesktopScene({
        databaseUrl,
        emailPrefix: "e2e-desktop-new",
        name: "Desktop back",
      });
      const accountId = accounts[0].account_id;
      try {
        const projectUrl = `${baseURL}/workspaces/${project.id}`;
        await installBrowserSessionDirect(
          page,
          session,
          projectUrl,
          authOptions,
        );
        await selectAccountForUi(page, accountId);
        await page.goto(projectUrl);
        await dismissOnboarding(page);

        // The reported soft lock: the switcher opens /new, and /new has no
        // navigation of its own — only an account menu.
        await page
          .getByRole("button", { name: "Switch workspace", exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: "Switch workspace", exact: true })
          .click();
        await page.getByRole("menuitem", { name: "Create workspace" }).click();
        await expect(page).toHaveURL(/\/workspaces\/new(\?|$)/, { timeout: 60_000 });
        await expect(
          page.getByRole("heading", { name: "Create a workspace" }),
        ).toBeVisible({ timeout: 60_000 });

        const back = page.getByRole("button", { name: "Back", exact: true });
        if (!desktop) {
          // The web keeps the browser's own Back and draws none.
          await expect(back).toHaveCount(0);
          return;
        }
        await expect(back).toBeVisible();
        const backBox = (await back.boundingBox())!;
        expect(
          backBox.x,
          "Back must clear the macOS traffic lights",
        ).toBeGreaterThanOrEqual(62);
        expect(
          backBox.y + backBox.height,
          "Back must sit inside the title-bar band",
        ).toBeLessThanOrEqual(43);
        // The page's own top row drops below the band. Log out lives in the
        // account menu (AccountTopBar, #8286); its trigger is the row's control.
        const accountMenu = page.getByRole("button", {
          name: `Logged in as ${email}`,
          exact: true,
        });
        await expect(accountMenu).toBeVisible();
        expect(
          (await accountMenu.boundingBox())!.y,
          "the account menu must sit below the title-bar band",
        ).toBeGreaterThanOrEqual(backBox.y + backBox.height);

        // `/new` has no titlebar owner, so the root strip is its only drag
        // area and covers the whole band (#7568). The strip paints above Back,
        // so it must not take Back's click: Back is the topmost box at its
        // own center.
        const strip = await page
          .locator(".kx-desktop-chrome")
          .evaluate((element) => ({
            bottom: element.getBoundingClientRect().bottom,
            region: getComputedStyle(element).webkitAppRegion,
          }));
        expect(
          strip.bottom,
          "the drag strip must cover the title-bar band",
        ).toBeGreaterThanOrEqual(backBox.y + backBox.height);
        expect(strip.region, "the band must stay a window drag region").toBe(
          "drag",
        );
        expect(
          await back.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return hit !== null && element.contains(hit);
          }),
          "the drag strip must not cover Back",
        ).toBe(true);

        await back.click();
        await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}`), {
          timeout: 60_000,
        });

        if (!desktopApp) {
          // Windows and Linux keep Electron's OS-native frame. The web content
          // must reserve no duplicate control cluster.
          for (const platform of ["Win32", "Linux x86_64"]) {
            const other = await page.context().newPage();
            try {
              await pinMacPlatform(other, platform);
              await resize(other, null, 1440, 900);
              await other.goto(projectUrl);
              await expect(
                other.getByRole("button", {
                  name: "Switch workspace",
                  exact: true,
                }),
              ).toBeVisible({ timeout: 60_000 });
              await other.goto(`${baseURL}/workspaces/new`);
              await expect(
                other.getByRole("heading", { name: "Create a workspace" }),
              ).toBeVisible({ timeout: 60_000 });
              const otherBack = other.getByRole("button", {
                name: "Back",
                exact: true,
              });
              await expect(otherBack, `${platform}: Back`).toBeVisible();
              const b = (await otherBack.boundingBox())!;
              expect(
                b.x,
                `${platform}: Back starts at the band's left edge`,
              ).toBeLessThan(24);
              expect(
                b.y + b.height,
                `${platform}: Back sits inside the band`,
              ).toBeLessThanOrEqual(42);
              await expect(other.locator(".kx-desktop-controls")).toHaveCount(
                0,
              );
              expect(
                await other
                  .locator("html")
                  .evaluate((html) =>
                    getComputedStyle(html)
                      .getPropertyValue("--kx-titlebar-controls-width")
                      .trim(),
                  ),
                `${platform}: no web-drawn control reservation`,
              ).toBe("0px");
              await otherBack.click();
              await expect(other).toHaveURL(
                new RegExp(`/workspaces/${project.id}`),
                {
                  timeout: 60_000,
                },
              );
            } finally {
              await other.close();
            }
          }
          return;
        }
        // The mouse side buttons step the same history. Real DOM buttons 3/4
        // through CDP, caught by the preload and resolved by the shell.
        const cdp = await page.context().newCDPSession(page);
        const sideButton = async (button: "back" | "forward") => {
          for (const type of ["mousePressed", "mouseReleased"] as const) {
            await cdp.send("Input.dispatchMouseEvent", {
              type,
              x: 400,
              y: 400,
              button,
              buttons: 0,
              clickCount: 1,
            });
          }
        };
        await sideButton("forward");
        await expect(page).toHaveURL(/\/workspaces\/new(\?|$)/, { timeout: 60_000 });
        await sideButton("back");
        await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}`), {
          timeout: 60_000,
        });
        await cdp.detach();

        // The shell's Go menu reaches the same history on any page, including
        // pages the web app does not render.
        const menuItem = (id: string) =>
          desktopApp.evaluate(({ Menu }, itemId) => {
            const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
            return item ? { enabled: item.enabled } : null;
          }, id);
        const clickMenu = (id: string) =>
          desktopApp.evaluate(({ Menu, BrowserWindow }, itemId) => {
            const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
            item?.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
          }, id);
        await expect
          .poll(() => menuItem("kx-go-forward"))
          .toEqual({ enabled: true });
        await clickMenu("kx-go-forward");
        await expect(page).toHaveURL(/\/workspaces\/new(\?|$)/, { timeout: 60_000 });
        await expect
          .poll(() => menuItem("kx-go-back"))
          .toEqual({ enabled: true });
        await clickMenu("kx-go-back");
        await expect(page).toHaveURL(new RegExp(`/workspaces/${project.id}`), {
          timeout: 60_000,
        });
        await clickMenu("kx-go-home");
        await expect(page).not.toHaveURL(/\/workspaces\/new(\?|$)/, { timeout: 60_000 });
      } finally {
        await dispose();
      }
    });
}
