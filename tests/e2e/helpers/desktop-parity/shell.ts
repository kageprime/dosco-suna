import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../../../src/core/env";
import { createDatabaseSession } from "../../../src/fixtures/database-project";
import { isDeployedTarget } from "../manifest-project";
import { installBrowserSessionDirect } from "../session-auth";
import { dismissOnboarding } from "../ui";
import {
  api,
  authOptions,
  provisionDesktopScene,
  desktopDatabaseUrl,
  test,
} from "./fixture";

export function defineShellParity(): void {

    const nativeTest = process.env.E2E_DESKTOP_NATIVE === "1" ? test : null;
    nativeTest?.(
      "connector authorization popup keeps its opener callback",
      async ({ page, desktopApp }) => {
        if (!desktopApp)
          throw new Error("native Electron application is required");
        const windowsBeforePopup = desktopApp.windows().length;
        const hasPopupHandle = await page.evaluate(() => {
          let popup: Window | null = null;
          window.addEventListener("message", (event) => {
            if (event.source !== popup || event.data !== "connector-auth-reply")
              return;
            document.documentElement.dataset.connectorAuthReply = event.data;
          });
          popup = window.open("", "connector-auth", "width=520,height=720");
          return popup !== null;
        });
        expect(hasPopupHandle).toBe(true);
        await expect
          .poll(() => desktopApp.windows().length)
          .toBe(windowsBeforePopup + 1);
        const popup = desktopApp
          .windows()
          .find(
            (candidate) =>
              candidate !== page && candidate.url() === "about:blank",
          );
        if (!popup) throw new Error("connector popup not found");
        try {
          expect(popup.url()).toBe("about:blank");
          expect(await popup.evaluate(() => Boolean(window.opener))).toBe(true);
          await popup.evaluate(() => {
            window.opener?.postMessage("connector-auth-reply", "*");
          });
          await expect(page.locator("html")).toHaveAttribute(
            "data-connector-auth-reply",
            "connector-auth-reply",
          );
        } finally {
          await popup.close();
        }
      },
    );
    nativeTest?.(
      "the Dock badge counts finished turns the user has not seen (KRTX-2520)",
      async ({ page, desktopApp }) => {
        if (!desktopApp)
          throw new Error("native Electron application is required");
        test.skip(
          process.platform !== "darwin",
          "app.getBadgeCount reads the Dock count on macOS; Windows uses an overlay icon",
        );
        const badge = () => desktopApp.evaluate(({ app }) => app.getBadgeCount());
        // A completion relayed from another tab, the same message the session
        // page publishes. Re-posting is idempotent (the store keeps one entry
        // per session), so the poll also waits out hydration.
        const finishTurn = (sessionId: string) =>
          page.evaluate((id) => {
            const channel = new BroadcastChannel("kortix-turn-complete");
            channel.postMessage({ sessionId: id, at: Date.now() });
            channel.close();
          }, sessionId);
        const first = `badge-${randomUUID()}`;
        const second = `badge-${randomUUID()}`;
        await expect.poll(badge).toBe(0);
        await expect
          .poll(async () => (await finishTurn(first), badge()), { timeout: 30_000 })
          .toBe(1);
        await expect
          .poll(async () => (await finishTurn(second), badge()))
          .toBe(2);
        // Opening a session marks it seen: the count drops by one.
        await page.evaluate(
          (id) => history.pushState(null, "", `/workspaces/badge/sessions/${id}`),
          first,
        );
        await expect.poll(badge).toBe(1);
        // A new document starts with nothing unseen.
        await page.reload();
        await expect.poll(badge).toBe(0);
      },
    );
    nativeTest?.(
      "right-click shows the platform menu: spelling, edit and link (KRTX-2555)",
      async ({ page, desktopApp }) => {
        if (!desktopApp)
          throw new Error("native Electron application is required");
        // Record each menu the shell builds instead of showing it: a native
        // popup runs its own event loop and waits for a person.
        await desktopApp.evaluate(({ Menu }) => {
          const state = globalThis as unknown as {
            menus: string[][];
            realBuild: typeof Menu.buildFromTemplate;
          };
          state.menus = [];
          state.realBuild = Menu.buildFromTemplate;
          Menu.buildFromTemplate = ((template: Electron.MenuItemConstructorOptions[]) => {
            state.menus.push(
              template.map((item) =>
                item.type === "separator" ? "-" : String(item.role ?? item.label),
              ),
            );
            return { popup: () => undefined } as unknown as Electron.Menu;
          }) as typeof Menu.buildFromTemplate;
        });
        const menus = () =>
          desktopApp.evaluate(
            () => (globalThis as unknown as { menus: string[][] }).menus,
          );
        try {
          // The app window may still be loading its first document.
          await page.waitForFunction(() => document.body !== null, undefined, { timeout: 60_000 });
          await page.evaluate(() => {
            const box = document.createElement("div");
            box.style.cssText =
              "position:fixed;left:40px;top:40px;z-index:2147483647;background:#fff;padding:8px";
            box.innerHTML = [
              '<textarea id="ctx-field" spellcheck="true" style="width:320px;height:40px;font-size:16px">recieve</textarea>',
              '<a id="ctx-link" href="https://example.com/docs" style="display:block;padding:4px">docs</a>',
              '<div id="ctx-plain" style="width:200px;height:24px"></div>',
              '<div id="ctx-own" style="width:200px;height:24px">own menu</div>',
            ].join("");
            document.body.appendChild(box);
            document
              .getElementById("ctx-own")
              ?.addEventListener("contextmenu", (event) => event.preventDefault());
          });
          const field = page.locator("#ctx-field");
          await field.focus();
          // The spell checker marks the word a moment after focus.
          await expect
            .poll(
              async () => {
                await field.click({ button: "right", position: { x: 24, y: 14 } });
                return (await menus()).at(-1) ?? [];
              },
              { timeout: 20_000 },
            )
            .toEqual(
              expect.arrayContaining([
                "receive",
                "Add to Dictionary",
                "undo",
                "cut",
                "copy",
                "paste",
                "pasteAndMatchStyle",
                "selectAll",
              ]),
            );
          // macOS also selects the word under a right-click, so Copy for the
          // link's text can follow, as in a browser.
          await page.locator("#ctx-link").click({ button: "right" });
          await expect
            .poll(async () => ((await menus()).at(-1) ?? []).slice(0, 2))
            .toEqual(["Open Link in Browser", "Copy Link"]);
          // An empty area offers nothing, and an element with its own menu
          // (the page calls preventDefault) gets no shell menu on top.
          const shown = (await menus()).length;
          await page.locator("#ctx-plain").click({ button: "right" });
          await page.locator("#ctx-own").click({ button: "right" });
          await page.waitForTimeout(500);
          expect((await menus()).length).toBe(shown);
        } finally {
          await desktopApp.evaluate(({ Menu }) => {
            Menu.buildFromTemplate = (
              globalThis as unknown as { realBuild: typeof Menu.buildFromTemplate }
            ).realBuild;
          });
        }
      },
    );
    nativeTest?.(
      "Quick Entry starts a session in the open project from the prompt bar",
      async ({ page, desktopApp, baseURL }) => {
        if (!desktopApp)
          throw new Error("native Electron application is required");
        test.setTimeout(240_000);
        const databaseUrl = desktopDatabaseUrl();
        const { session, project, dispose } = await provisionDesktopScene({
          databaseUrl,
          emailPrefix: "e2e-desktop-quick-entry",
          name: "Quick Entry target",
          fund: true,
        });
        try {
          const projectId = project.id;
          const { resolvedForCaller: modelId } = await api<{
            resolvedForCaller: string | null;
          }>(session.access_token, "GET", `/projects/${projectId}/model-defaults`);
          expect(modelId).toBeTruthy();
          const picker = await api<Record<string, unknown>>(
            session.access_token,
            "GET",
            `/projects/${projectId}/model-picker`,
          );
          const creates: { pending_prompt?: { text?: string } }[] = [];
          await page.route("**/*", async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            // The local profile has no managed model catalog: serve its
            // resolved default so the composer can send (as in spec 28).
            if (
              !isDeployedTarget() &&
              request.method() === "GET" &&
              path === `/v1/projects/${projectId}/model-picker`
            ) {
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                  ...picker,
                  models: {
                    [modelId!]: {
                      id: modelId,
                      name: "E2E managed model",
                      provider: "openai",
                      enabled: true,
                      tool_call: true,
                      attachment: true,
                      limit: { context: 128_000, output: 8_000 },
                    },
                  },
                  defaultModel: modelId,
                }),
              });
              return;
            }
            if (
              request.method() === "POST" &&
              path === `/v1/projects/${projectId}/sessions`
            ) {
              creates.push(request.postDataJSON());
            }
            await route.continue();
          });
          // Electron windows have no Playwright baseURL: pass an absolute URL.
          await installBrowserSessionDirect(
            page,
            session,
            `${baseURL}/workspaces/${projectId}`,
            authOptions,
          );
          await dismissOnboarding(page);
          await expect(
            page.getByRole("textbox", { name: "Message input" }),
          ).toBeVisible({ timeout: 60_000 });

          // The default shortcut is registered for the whole OS. Linux under
          // Wayland has no global shortcuts, so only macOS and Windows assert it.
          if (process.platform === "darwin" || process.platform === "win32") {
            expect(
              await desktopApp.evaluate(({ globalShortcut }) =>
                globalShortcut.isRegistered("CommandOrControl+Shift+Space"),
              ),
            ).toBe(true);
          }

          // File ▸ Open Quick Entry runs the same show() as the shortcut.
          await desktopApp.evaluate(({ Menu }) => {
            Menu.getApplicationMenu()
              ?.getMenuItemById("kx-file-quick-entry")
              ?.click();
          });
          await expect
            .poll(() =>
              desktopApp
                .windows()
                .some((window) => window.url().endsWith("/quick-entry.html")),
            )
            .toBe(true);
          const bar = desktopApp
            .windows()
            .find((window) => window.url().endsWith("/quick-entry.html"))!;
          await expect(bar.locator("#pick-label")).toHaveText("New session");
          await expect(bar.locator("#pick")).toHaveAttribute(
            "title",
            "New session in Quick Entry target",
          );
          // The new session's agent, resolved as project home does. The model
          // and effort stay the composer's own: the bar has no control for them.
          await expect(bar.locator("#agent")).toBeVisible({ timeout: 30_000 });
          await expect(bar.locator("#model, #effort")).toHaveCount(0);
          const prompt = `Quick Entry prompt ${randomUUID()}`;
          const created = page.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              new URL(response.url()).pathname ===
                `/v1/projects/${projectId}/sessions`,
            { timeout: 60_000 },
          );
          await bar.locator("#prompt").fill(prompt);
          await bar.locator("#prompt").press("Enter");

          // The project home composer submitted the prompt: one create, and it
          // carries the text as the session's first prompt.
          const response = await created;
          expect(creates).toHaveLength(1);
          expect(creates[0]?.pending_prompt?.text).toBe(prompt);
          if (isDeployedTarget()) {
            expect(response.ok()).toBe(true);
            await expect(page).toHaveURL(
              new RegExp(`/workspaces/${projectId}/sessions/[^/?#]+`),
              { timeout: 60_000 },
            );
            await expect(page.getByText(prompt).first()).toBeVisible();
          } else {
            // The local profile has no tunnel, so the API refuses every
            // create (503 KORTIX_URL_UNREACHABLE, as in spec 28). The prompt
            // is not lost: the composer keeps it.
            expect(response.status()).toBe(503);
            await expect(
              page.getByRole("textbox", { name: "Message input" }),
            ).toHaveText(prompt, { timeout: 15_000 });
          }
          // The bar hid itself, and the prompt was taken exactly once.
          expect(
            await desktopApp.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()
                .find((window) =>
                  window.webContents.getURL().endsWith("/quick-entry.html"),
                )
                ?.isVisible(),
            ),
          ).toBe(false);
          expect(
            await page.evaluate(() =>
              (
                window as unknown as {
                  __TAURI__: { core: { invoke: (cmd: string) => Promise<unknown> } };
                }
              ).__TAURI__.core.invoke("quick_entry_take"),
            ),
          ).toBeNull();
        } finally {
          await page.unrouteAll({ behavior: "ignoreErrors" });
          await dispose();
        }
      },
    );
    nativeTest?.(
      "Quick Entry sends to a recent session picked in the bar",
      async ({ page, desktopApp, baseURL }) => {
        if (!desktopApp)
          throw new Error("native Electron application is required");
        test.setTimeout(240_000);
        const databaseUrl = desktopDatabaseUrl();
        const { user, session, accounts, project, dispose } = await provisionDesktopScene({
          databaseUrl,
          emailPrefix: "e2e-desktop-quick-entry-pick",
          name: "Quick Entry picker",
          fund: true,
        });
        type PickerMenu = {
          items: { label: string; click: () => void }[];
          closePopup: () => void;
        };
        type PickerHolder = { quickEntryPicker?: PickerMenu };
        try {
          const projectId = project.id;
          const pickedId = await createDatabaseSession(loadEnv(), {
            projectId,
            accountId: accounts[0].account_id,
            userId: user.id,
            metadata: { session_name: "Picked session target" },
          });
          await installBrowserSessionDirect(
            page,
            session,
            `${baseURL}/workspaces/${projectId}`,
            authOptions,
          );
          await dismissOnboarding(page);
          await expect(
            page.getByRole("textbox", { name: "Message input" }),
          ).toBeVisible({ timeout: 60_000 });

          // Playwright cannot click an OS menu: keep the menu the bar pops up,
          // read its real items, and choose one through its own click handler.
          await desktopApp.evaluate(({ Menu }) => {
            const popup = Menu.prototype.popup;
            Menu.prototype.popup = function (options) {
              (globalThis as unknown as PickerHolder).quickEntryPicker =
                this as unknown as PickerMenu;
              return popup.call(this, options);
            };
          });
          await desktopApp.evaluate(({ Menu }) => {
            Menu.getApplicationMenu()
              ?.getMenuItemById("kx-file-quick-entry")
              ?.click();
          });
          await expect
            .poll(() =>
              desktopApp
                .windows()
                .some((window) => window.url().endsWith("/quick-entry.html")),
            )
            .toBe(true);
          const bar = desktopApp
            .windows()
            .find((window) => window.url().endsWith("/quick-entry.html"))!;
          await expect(bar.locator("#pick-label")).toHaveText("New session");

          // The list arrives with the sidebar's session query.
          const readPicker = async () => {
            await bar.locator("#pick").click();
            const labels = await desktopApp.evaluate(() => {
              const menu = (globalThis as unknown as PickerHolder).quickEntryPicker;
              menu?.closePopup();
              return menu?.items.map((item) => item.label) ?? [];
            });
            return labels;
          };
          await expect(async () => {
            expect(await readPicker()).toEqual([
              "New session",
              "",
              "Recent sessions",
              "Picked session target",
            ]);
          }).toPass({ timeout: 30_000 });
          await bar.locator("#pick").click();
          await desktopApp.evaluate(() => {
            const menu = (globalThis as unknown as PickerHolder).quickEntryPicker!;
            menu.closePopup();
            menu.items[3].click();
          });
          await expect(bar.locator("#pick-label")).toHaveText(
            "Picked session target",
          );
          await expect(bar.locator("#dot")).toBeVisible();

          await bar.locator("#prompt").fill("Follow-up from Quick Entry");
          await bar.locator("#prompt").press("Enter");
          // The picked session's page opens; its composer sends once the chat
          // resolves (a deployed target runs it; the local profile has no box).
          await expect(page).toHaveURL(
            new RegExp(`/workspaces/${projectId}/sessions/${pickedId}`),
            { timeout: 60_000 },
          );
          // The next open keeps the pick while the session is live (running,
          // starting, needs you); any other status starts a new session.
          await desktopApp.evaluate(({ Menu }) => {
            Menu.getApplicationMenu()
              ?.getMenuItemById("kx-file-quick-entry")
              ?.click();
          });
          await expect(bar.locator("#prompt")).toBeFocused();
          const live =
            (await bar.locator("#dot").isVisible()) &&
            ["running", "starting", "needs-you"].includes(
              (await bar.locator("#dot").getAttribute("data-status")) ?? "",
            );
          await expect(bar.locator("#pick-label")).toHaveText(
            live ? "Picked session target" : "New session",
          );
          await bar.locator("#prompt").press("Escape");
        } finally {
          await dispose();
        }
      },
    );
    nativeTest?.(
      "dock activation recreates the main window with its persisted native state",
      async ({ desktopApp, baseURL }) => {
        if (!desktopApp)
          throw new Error("native Electron application is required");
        test.setTimeout(180_000);

        const restored = await desktopApp.evaluate(
          async ({ BrowserWindow, app, screen }, origin) => {
            const delay = (ms: number) =>
              new Promise((resolve) => setTimeout(resolve, ms));
            const main = BrowserWindow.getAllWindows().find((window) =>
              window.webContents.getURL().startsWith(origin),
            );
            if (!main) throw new Error("main window not found");
            main.minimize();
            await delay(100);
            app.emit("activate");
            for (
              let attempt = 0;
              attempt < 80 && main.isMinimized();
              attempt += 1
            ) {
              await delay(50);
            }
            const restoredFromMinimized =
              !main.isMinimized() && main.isVisible();
            const area = screen.getPrimaryDisplay().workArea;
            const expected = {
              x: area.x + 80,
              y: area.y + 70,
              width: Math.min(980, area.width - 160),
              height: Math.min(680, area.height - 140),
            };
            main.unmaximize();
            main.setBounds(expected);
            await delay(350);
            main.maximize();
            for (
              let attempt = 0;
              attempt < 80 && !main.isMaximized();
              attempt += 1
            ) {
              await delay(50);
            }
            if (!main.isMaximized())
              throw new Error("main window did not maximize");
            await delay(350);

            const popup = new BrowserWindow({ show: false });
            await popup.loadURL("about:blank");
            main.destroy();
            await delay(100);
            app.emit("activate");

            let replacement = BrowserWindow.getAllWindows().find(() => false);
            for (let attempt = 0; attempt < 240; attempt += 1) {
              replacement = BrowserWindow.getAllWindows().find(
                (window) =>
                  window !== popup &&
                  window.webContents.getURL().startsWith(origin),
              );
              if (replacement?.isVisible() && replacement.isMaximized()) break;
              await delay(250);
            }
            if (!replacement)
              throw new Error("replacement main window not found");
            const result = {
              expected,
              normalBounds: replacement.getNormalBounds(),
              maximized: replacement.isMaximized(),
              popupAlive: !popup.isDestroyed(),
              restoredFromMinimized,
            };
            popup.destroy();
            return result;
          },
          baseURL!,
        );

        expect(restored.popupAlive).toBe(true);
        expect(restored.restoredFromMinimized).toBe(true);
        expect(restored.maximized).toBe(true);
        expect(restored.normalBounds).toEqual(restored.expected);
      },
    );
}
