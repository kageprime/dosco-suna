import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../../../src/core/env";
import { createDatabaseSession } from "../../../src/fixtures/database-project";
import { seedSessionTranscript } from "../../../src/fixtures/session-transcript";
import { runDatabaseSql } from "../database";
import { isDeployedTarget } from "../manifest-project";
import { installBrowserSessionDirect } from "../session-auth";
import {
  SESSION_READY_TIMEOUT_MS,
  waitForSessionReady,
} from "../session-ready";
import { dismissOnboarding, dismissWelcomeCard } from "../ui";
import {
  api,
  authOptions,
  provisionDesktopScene,
  resize,
  desktopDatabaseUrl,
  chooseAppearanceTheme,
  expectThinkingMatchesStop,
  test,
} from "./fixture";

export function defineQueueParity(): void {
    test("Enter steers the running turn and Command+Enter queues behind it", async ({
      page,
      baseURL,
      desktopApp,
    }) => {
      // A deployed target provisions a real sandbox first (see below).
      test.setTimeout(
        isDeployedTarget() ? 180_000 + SESSION_READY_TIMEOUT_MS : 180_000,
      );
      const databaseUrl = desktopDatabaseUrl();
      const {
        user,
        session: auth,
        accounts,
        project,
        dispose,
      } = await provisionDesktopScene({
        databaseUrl,
        emailPrefix: "e2e-queue",
        name: "Queue placement",
      });
      let projectDisposed = false;
      let sessionId = "";
      let bootSessionId = "";
      const deliveryFixtureId = randomUUID();
      try {
        if (!isDeployedTarget()) {
          // A saved test credential makes a real catalog model selectable.
          // This journey verifies pending submission, not model execution.
          const base = `/projects/${project.id}`;
          await api(
            auth.access_token,
            "POST",
            `${base}/secrets`,
            {
              name: "OPENAI_API_KEY",
              value: "sk-e2e-unused-queue-placement",
              strategy: "broker",
              consumer: "llm_gateway",
            },
            [200, 201],
          );
          await api(auth.access_token, "PUT", `${base}/model-access`, {
            target: "model",
            id: "openai/gpt-5.5",
            enabled: true,
          });
          await api(auth.access_token, "PUT", `${base}/model-defaults`, {
            scope: "project",
            model: "openai/gpt-5.5",
          });
        }
        if (!isDeployedTarget()) {
          // A persisted conversation is the real offline submission surface.
          // The local profile deliberately has no cloud session provisioning.
          sessionId = await createDatabaseSession(loadEnv(), {
            projectId: project.id,
            accountId: accounts[0].account_id,
            userId: user.id,
          });
          const rootId = `ses_${sessionId.replaceAll("-", "")}`;
          const now = Date.now() - 60_000;
          // The history is in the session log, journaled as a box writes it.
          await seedSessionTranscript(loadEnv(), {
            projectId: project.id,
            accountId: accounts[0].account_id,
            sessionId,
            messages: () =>
              (["user", "assistant"] as const).map((role) => {
                const id =
                  role === "user"
                    ? "msg_000000000000000000000001"
                    : "msg_000000000000000000000002";
                const info = {
                  id,
                  sessionID: rootId,
                  role,
                  agent: "kortix",
                  time: {
                    created: now,
                    ...(role === "assistant" ? { completed: now + 1 } : {}),
                  },
                  ...(role === "user"
                    ? { model: { providerID: "kortix", modelID: "openai/gpt-5.5" } }
                    : {
                        parentID: "msg_000000000000000000000001",
                        providerID: "kortix",
                        modelID: "openai/gpt-5.5",
                        mode: "build",
                        cost: 0,
                        tokens: {
                          input: 0,
                          output: 0,
                          reasoning: 0,
                          cache: { read: 0, write: 0 },
                        },
                        finish: "stop",
                        path: { cwd: "/workspace", root: "/workspace" },
                      }),
                };
                const parts = [
                  {
                    id: `prt_queue_${role}`,
                    sessionID: rootId,
                    messageID: id,
                    type: "text",
                    text: role === "user" ? "Previous prompt" : "Previous response",
                  },
                ];
                return { info, parts };
              }),
            bearer: auth.access_token,
          });
          // Keep the cached conversation mounted. The local test sandbox has
          // no provider behind it, so a real /start eventually marks it stopped.
          // Prompt acceptance and read-back still use the real API below.
          await page.route(`**/sessions/${sessionId}/start?*`, async (route) => {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                stage: "ready",
                agent_name: "kortix",
                retriable: false,
                runtime_session_id: rootId,
                sandbox: {
                  sandbox_id: sessionId,
                  session_id: sessionId,
                  project_id: project.id,
                  account_id: accounts[0].account_id,
                  provider: "platinum",
                  external_id: sessionId,
                  base_url: "http://127.0.0.1:1",
                  status: "active",
                  config: {},
                  metadata: {},
                  last_used_at: null,
                  created_at: new Date(now).toISOString(),
                  updated_at: new Date(now).toISOString(),
                },
              }),
            });
          });
        }
        await installBrowserSessionDirect(
          page,
          auth,
          `${baseURL}/workspaces/${project.id}${sessionId ? `/sessions/${sessionId}` : ""}`,
          authOptions,
        );
        await dismissOnboarding(page);
        const input = page.getByRole("textbox", { name: "Message input" });
        await expect(input).toBeVisible({ timeout: 60_000 });
        if (isDeployedTarget()) {
          await input.fill("Run sleep 45 in the terminal, then reply READY.");
          await input.press("Enter");
          await expect(page).toHaveURL(/\/sessions\/[^/?]+/, {
            timeout: 60_000,
          });
          sessionId = new URL(page.url()).pathname.split("/").at(-1)!;
          // Stop is enabled only while a turn runs, and the turn starts only
          // once the sandbox is ready. A fresh preview builds the default
          // image for ~9 min first, so a flat 60 s wait on Stop failed 11 of
          // 13 previews with the session still in `provisioning`.
          await waitForSessionReady(api, auth.access_token, project.id, sessionId);
          await expect(page.getByRole("button", { name: "Stop", exact: true }))
            .toBeEnabled({ timeout: 60_000 });
          await expect(input).toBeEmpty();
        } else {
          await expect(
            page.getByText("Previous response", { exact: true }),
          ).toBeVisible();
        }
        await runDatabaseSql(
          `INSERT INTO kortix.session_lifecycle_commands
           (command_id, command_type, source, status, project_id, session_id,
            account_id, actor_user_id, payload, locked_by, locked_until)
           VALUES ($1, 'continue_session', 'ui', 'running', $2, $3, $4, $5,
             $6::jsonb, 'browser-queue-fixture', now() + interval '10 minutes')`,
          [deliveryFixtureId, project.id, sessionId, accounts[0].account_id, user.id,
            JSON.stringify({ text: "Pending delivery fixture", clientMessageId: `msg_${deliveryFixtureId.replaceAll("-", "")}` })],
          databaseUrl,
        );
        const promptRequest = () => page.waitForRequest(
          (request) =>
            request.method() === "POST" &&
            new URL(request.url()).pathname.endsWith(`/sessions/${sessionId}/prompts`),
        );
        const verifySend = async (
          request: Promise<import("@playwright/test").Request>,
          text: string,
          placement: string,
          delivery: string,
        ) => {
          const sent = await request;
          const outgoing = sent.postDataJSON();
          expect(outgoing.placement).toBe(placement);
          expect(outgoing.delivery).toBe(delivery);
          expect(outgoing.parts).toContainEqual(
            expect.objectContaining({ type: "text", text }),
          );
          await expect(input).toBeEmpty();
          expect([200, 202]).toContain((await sent.response())?.status());
        };
        // #9260 (R10): Enter while a turn runs steers it. The row waits in the
        // Queue List as "Read at next step" until the turn reads it.
        // Cmd/Ctrl+Enter is a plain Queue List row behind the turn.
        const transcriptText = "Enter steers the running turn";
        const composerText = "Command queues behind the turn";
        const pending = page
          .locator("[data-queued-prompt-id]")
          .filter({ hasText: transcriptText });
        // Keep the first real API acceptance in flight. A second Enter must
        // paint at once. Its POST leaves after the first POST settles: the
        // session's delivery chain keeps POSTs in Enter order, because an idle
        // session admits whichever prompt lands first (`delivery-chain.ts`).
        let releaseAcceptance!: () => void;
        const acceptanceGate = new Promise<void>((resolve) => { releaseAcceptance = resolve; });
        const postOrder: string[] = [];
        const promptsUrl = `**/sessions/${sessionId}/prompts`;
        await page.route(promptsUrl, async (route) => {
          const request = route.request();
          const body = request.postData() ?? "";
          if (request.method() === "POST") {
            postOrder.push(body.includes(transcriptText) ? "steer" : body.includes(composerText) ? "queue" : "other");
          }
          if (request.method() !== "POST" || !body.includes(transcriptText)) {
            await route.continue();
            return;
          }
          const response = await route.fetch();
          await acceptanceGate;
          await route.fulfill({ response });
        });
        const firstRequest = promptRequest();
        await input.fill(transcriptText);
        await input.press("Enter");
        const firstSend = verifySend(firstRequest, transcriptText, "composer", "steer");
        let nextRequest: Promise<import("@playwright/test").Request> | undefined;
        try {
          await expect(pending).toBeVisible({ timeout: 1_000 });
          await input.fill(composerText);
          nextRequest = page.waitForRequest((request) =>
            request.method() === "POST" && request.url().endsWith(`/sessions/${sessionId}/prompts`) &&
            Boolean(request.postData()?.includes(composerText)), { timeout: 30_000 });
          await input.press("Meta+Enter");
          await expect(page.locator("[data-queued-prompt-id]").filter({ hasText: composerText }))
            .toBeVisible({ timeout: 1_000 });
          // Painted, and still waiting behind the first POST.
          expect(postOrder).toEqual(["steer"]);
        } finally {
          releaseAcceptance();
          await firstSend;
        }
        expect(nextRequest).toBeDefined();
        expect((await nextRequest!).postDataJSON()).toMatchObject({ placement: "composer", delivery: "queue" });
        // The request event resolves `waitForRequest` before the route handler
        // records the POST, so wait for the handler.
        await expect.poll(() => postOrder).toEqual(["steer", "queue"]);
        await page.unroute(promptsUrl);
        // The local box reports no active turn, so the steer waits and stays a
        // steer (`admitSteer` → turn_active), drawn as "Read at next step".
        // A real deployed box is mid-turn and may read the steer before this
        // check: then it has left the Queue List and is in the transcript
        // (gate 37963866893 read it first; gate 37953042131 saw it waiting).
        if (isDeployedTarget()) {
          await expect(
            pending
              .locator("[data-queued-delivery]")
              .filter({ hasText: "Read at next step" })
              .or(page.getByRole("log").getByText(transcriptText, { exact: true })),
          ).toBeVisible();
        } else {
          await expect(pending.locator("[data-queued-delivery]")).toHaveText("Read at next step");
        }
        await expectThinkingMatchesStop(page);
        if (!isDeployedTarget()) {
          await expect(page.getByText(/This session is idle/)).toHaveCount(0);
        }
        const row = page
          .locator("[data-queued-prompt-id]")
          .filter({ hasText: composerText });
        await expect(row).toBeVisible();
        // A Queue List row carries no steer note.
        await expect(row.locator("[data-queued-delivery]")).toHaveCount(0);
        // Row actions live in one "Message actions" menu since #9993.
        const rowActions = row.getByRole("button", { name: "Message actions", exact: true });
        await expect(rowActions).toBeEnabled();
        await dismissWelcomeCard(page);
        await row.hover();
        await rowActions.click();
        await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
        await expect(input).toHaveText(composerText);
        await expect(row).toHaveCount(0);
        await input.press("End");
        const codeLines = [
          "```ts",
          "const values = [1, 2, 3];",
          "for (const value of values) {",
          "  console.log(value);",
          "}",
          "```",
        ];
        for (const line of codeLines) {
          await input.press("Shift+Enter");
          await input.pressSequentially(line);
        }
        await expect(input).toContainText("console.log(value)");
        const editedText = `${composerText}\n${codeLines.join("\n")}`;
        // Editing a queued prompt saves it in place (#8753): the row keeps its
        // place in the queue and any Stop hold, so submit PATCHes that row and
        // never re-POSTs it. A re-POST would run at once on an idle session.
        const reposts: string[] = [];
        const countRepost = (request: import("@playwright/test").Request) => {
          if (
            request.method() === "POST" &&
            new URL(request.url()).pathname.endsWith(`/sessions/${sessionId}/prompts`)
          ) reposts.push(request.url());
        };
        page.on("request", countRepost);
        const saveRequest = page.waitForRequest(
          (request) =>
            request.method() === "PATCH" &&
            new URL(request.url()).pathname.includes(`/sessions/${sessionId}/prompts/`),
        );
        await input.press("Control+Enter");
        const saved = await saveRequest;
        expect(saved.postDataJSON()).toEqual({ text: editedText });
        expect((await saved.response())?.status()).toBe(200);
        await expect(input).toBeEmpty();
        await expect(row).toBeVisible();
        await expect(row).toContainText("console.log(value)");
        page.off("request", countRepost);
        expect(reposts).toEqual([]);
        const persisted = await api<{
          prompts: Array<{ placement: string; delivery?: string; full_text: string }>;
        }>(
          auth.access_token,
          "GET",
          `/projects/${project.id}/sessions/${sessionId}/prompts`,
        );
        // A deployed box reads the steer at the running turn's next step, so
        // only the local profile still holds that row here.
        expect(persisted.prompts).toEqual(
          expect.arrayContaining([
            ...(isDeployedTarget()
              ? []
              : [
                  expect.objectContaining({
                    placement: "composer",
                    delivery: "steer",
                    full_text: transcriptText,
                  }),
                ]),
            expect.objectContaining({
              placement: "composer",
              full_text: editedText,
            }),
          ]),
        );
        for (const theme of ["Dark", "Light"]) {
          await page
            .getByRole("button", { name: "Switch workspace", exact: true })
            .click();
          await page.getByRole("menuitem", { name: /^Settings/ }).click();
          const settings = page.getByRole("dialog");
          await settings
            .getByRole("tab", { name: "Appearance", exact: true })
            .click();
          await chooseAppearanceTheme(page, settings, theme);
          await settings.getByRole("button", { name: "Back to app" }).click();
          await expect(page.locator("html")).toHaveClass(
            new RegExp(theme.toLowerCase()),
          );
          await expect(row).toBeVisible();
          await page.screenshot({
            path: test.info().outputPath(`queue-${theme.toLowerCase()}.png`),
            scale: "css",
          });
        }
        await page.reload();
        if (!isDeployedTarget()) await expect(pending).toBeVisible({ timeout: 60_000 });
        await expect(row).toBeVisible();
        await row.locator("summary").click();
        await expect(row.locator("pre")).toHaveText(editedText);
        await row.locator("summary").click();
        if (desktopApp) {
          const window = await desktopApp.browserWindow(page);
          await window.evaluate((window) =>
            window.webContents.setZoomFactor(2),
          );
          await expect(input).toBeInViewport();
          await expect(row).toBeInViewport();
          await row.hover();
          await row
            .getByRole("button", { name: "Message actions", exact: true })
            .click({ trial: true });
          await window.evaluate((window) => {
            window.webContents.setZoomFactor(1);
          });
        }
        await resize(page, desktopApp, 720, 480);
        await expect(input).toBeInViewport();
        await expect(
          page
            .locator("[data-queued-prompt-id]")
            .filter({ hasText: composerText }),
        ).toBeInViewport();
        await page.screenshot({
          path: test.info().outputPath("queue-placements.png"),
          scale: "css",
        });
        if (!isDeployedTarget()) {
          // Stop must persist the queue hold, including after navigation.
          const heldRequest = page.waitForResponse((response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname.endsWith(`/sessions/${sessionId}/prompts/hold`),
          );
          await page.getByRole("button", { name: "Stop", exact: true }).click();
          expect((await heldRequest).ok()).toBe(true);
          await page.reload();
          await expect(pending).toBeVisible({ timeout: 60_000 });
          await expectThinkingMatchesStop(page);
          const held = await api<{ prompts: Array<{ prompt_id: string; state: string; reason: string }> }>(
            auth.access_token, "GET", `/projects/${project.id}/sessions/${sessionId}/prompts`,
          );
          expect(held.prompts.length).toBeGreaterThan(0);
          expect(held.prompts.every((prompt) => prompt.state === "waiting" && prompt.reason === "held")).toBe(true);
          await runDatabaseSql(
            "UPDATE kortix.session_lifecycle_commands SET status = 'dead_lettered', last_error = 'delivery outcome: pending' WHERE command_id = $1",
            [held.prompts[0].prompt_id], databaseUrl,
          );
          await page.reload();
          await expect(page.getByText(/the session was not ready in time/)).toBeVisible({ timeout: 60_000 });
          await expectThinkingMatchesStop(page);
          bootSessionId = await createDatabaseSession(loadEnv(), {
            projectId: project.id,
            accountId: accounts[0].account_id,
            userId: user.id,
          });
          await api(
            auth.access_token,
            "POST",
            `/projects/${project.id}/sessions/${bootSessionId}/prompts`,
            {
              client_message_id: `start_${bootSessionId}`,
              message_id: `msg_${(Date.now() * 0x1000).toString(16).slice(-12)}AbCdEfGhIjKlMn`,
              parts: [{ type: "text", text: "First prompt still starting" }],
              placement: "transcript",
            },
            202,
          );
          await page.goto(
            `${baseURL}/workspaces/${project.id}/sessions/${bootSessionId}`,
          );
          await expect(input).toBeVisible({ timeout: 30_000 });
          await expect(
            page
              .getByRole("paragraph")
              .getByText("First prompt still starting", { exact: true }),
          ).toBeVisible();
          await expectThinkingMatchesStop(page);
          await page.reload();
          await expect(input).toBeVisible({ timeout: 30_000 });
          await expectThinkingMatchesStop(page);
          await expect(
            page
              .getByRole("paragraph")
              .getByText("First prompt still starting", { exact: true }),
          ).toBeVisible();

          if (desktopApp) {
            const clickNativeMenu = (id: string) =>
              desktopApp.evaluate(({ Menu, BrowserWindow }, itemId) => {
                const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
                item?.click(
                  undefined,
                  BrowserWindow.getAllWindows()[0],
                  undefined,
                );
              }, id);
            const menuState = (id: string) =>
              desktopApp.evaluate(({ Menu }, itemId) => {
                const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
                return item
                  ? { enabled: item.enabled, accelerator: item.accelerator }
                  : null;
              }, id);
            await clickNativeMenu("kx-file-new-session");
            await expect(page).toHaveURL(
              new RegExp(`/workspaces/${project.id}(?:\\?|$)`),
              { timeout: 60_000 },
            );
            await page.goto(
              `${baseURL}/workspaces/${project.id}/customize/connectors`,
            );
            await expect(
              page.getByRole("tab", { name: "Connected", exact: true }),
            ).toBeVisible();
            await expect
              .poll(() => menuState("kx-file-close-tab"))
              .toMatchObject({ enabled: true });
            await clickNativeMenu("kx-file-close-tab");
            await expect(page).toHaveURL(
              new RegExp(`/workspaces/${project.id}(?:\\?|$)`),
              { timeout: 60_000 },
            );

            await page.goto(`${baseURL}/settings`);
            await expect(page).toHaveURL(/\/settings(?:\?|$)/, {
              timeout: 60_000,
            });
            await expect
              .poll(() => menuState("kx-file-new-session"))
              .toMatchObject({ enabled: false });
            await expect
              .poll(() => menuState("kx-file-close-tab"))
              .toMatchObject({ enabled: false });
            await clickNativeMenu("kx-app-settings");
            await expect(page).toHaveURL(/\/settings(?:\?|$)/, {
              timeout: 60_000,
            });

            const unloadAllowed = (response: number) =>
              desktopApp.evaluate(
                ({ BrowserWindow, dialog }, options) => {
                  const main = BrowserWindow.getAllWindows().find((window) =>
                    window.webContents.getURL().startsWith(options.origin),
                  );
                  if (!main) throw new Error("main window not found");
                  const original = dialog.showMessageBoxSync;
                  let allowed = false;
                  dialog.showMessageBoxSync = () => options.response;
                  try {
                    main.webContents.emit("will-prevent-unload", {
                      preventDefault: () => {
                        allowed = true;
                      },
                    });
                    return allowed;
                  } finally {
                    dialog.showMessageBoxSync = original;
                  }
                },
                { origin: baseURL!, response },
              );
            expect(await unloadAllowed(1)).toBe(false);
            expect(await unloadAllowed(0)).toBe(true);

            await project.dispose();
            projectDisposed = true;
            await desktopApp.evaluate(
              async ({ BrowserWindow, Menu, dialog }, itemId) => {
                const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
                const window = BrowserWindow.getAllWindows()[0];
                const original = dialog.showMessageBoxSync;
                dialog.showMessageBoxSync = () => 0;
                try {
                  await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(
                      () => reject(new Error("Native Close Window timed out")),
                      10_000,
                    );
                    window.once("closed", () => {
                      clearTimeout(timeout);
                      resolve();
                    });
                    item?.click(undefined, window, undefined);
                  });
                } finally {
                  dialog.showMessageBoxSync = original;
                }
              },
              "kx-file-close-window",
            );
          }
        }
      } finally {
        if (!projectDisposed && bootSessionId)
          await api(
            auth.access_token,
            "DELETE",
            `/projects/${project.id}/sessions/${bootSessionId}`,
          ).catch(() => undefined);
        if (!projectDisposed && sessionId)
          await api(
            auth.access_token,
            "DELETE",
            `/projects/${project.id}/sessions/${sessionId}`,
          ).catch(() => undefined);
        await runDatabaseSql(
          "DELETE FROM kortix.session_lifecycle_commands WHERE command_id = $1",
          [deliveryFixtureId], databaseUrl,
        );
        await dispose();
      }
    });
}
