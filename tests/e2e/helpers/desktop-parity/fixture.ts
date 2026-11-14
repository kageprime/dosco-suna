import {
  expect,
  test as browserTest,
  _electron,
  type Locator,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  request as requestHttp,
  type Server as HttpServer,
} from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiJsonClient } from "../http";
import {
  createManifestProject,
  fundAccount,
  type ManifestProject,
} from "../manifest-project";
import { createAuthUser, deleteAuthUser, signIn } from "../session-auth";

const desktopRoot = fileURLToPath(
  new URL("../../../../apps/desktop-electron", import.meta.url),
);
const requireDesktop = createRequire(join(desktopRoot, "package.json"));

export async function launchDesktop(baseURL: string, profile: string) {
  const app = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: [desktopRoot],
    env: {
      ...process.env,
      KORTIX_DESKTOP_USER_DATA: profile,
      KORTIX_DESKTOP_URL: `${baseURL}/workspaces`,
    },
  });
  await expect
    .poll(
      () => app.windows().some((window) => window.url().startsWith(baseURL)),
      { timeout: 120_000 },
    )
    .toBe(true);
  return app;
}

export async function startBasicProxy(baseURL: string) {
  const origin = new URL(baseURL);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    throw new Error("The desktop proxy test requires a loopback HTTP origin");
  }
  const expected = `Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`;
  let challenges = 0;
  let authorizedRequests = 0;
  const server: HttpServer = createServer((incoming, outgoing) => {
    if (incoming.headers["proxy-authorization"] !== expected) {
      challenges += 1;
      outgoing.writeHead(407, {
        "Content-Type": "text/plain; charset=utf-8",
        "Proxy-Authenticate": 'Basic realm="Kortix proxy test"',
      });
      outgoing.end("Proxy authentication required");
      return;
    }

    authorizedRequests += 1;
    let target: URL;
    try {
      target = new URL(incoming.url || "");
    } catch {
      outgoing.writeHead(400).end("Invalid proxy target");
      return;
    }
    if (target.origin !== origin.origin) {
      outgoing.writeHead(403).end("Proxy target not allowed");
      return;
    }
    const headers = { ...incoming.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = requestHttp(
      {
        hostname: origin.hostname,
        port: Number(origin.port || 80),
        path: `${target.pathname}${target.search}`,
        method: incoming.method,
        headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode || 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end(String(error.message || error));
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Basic proxy did not bind to a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stats: () => ({ challenges, authorizedRequests }),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** A profile directory and the apps launched on it, closed and removed by one `dispose`. */
export async function openNativeDesktop(baseURL: string, prefix: string) {
  const profile = await mkdtemp(join(tmpdir(), `kortix-desktop-${prefix}-`));
  const apps: ElectronApplication[] = [];
  return {
    profile,
    launch: async () => {
      const app = await launchDesktop(baseURL, profile);
      apps.push(app);
      return app;
    },
    dispose: async () => {
      try {
        for (const app of apps) await app.close();
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    },
  };
}

export const test = browserTest.extend<{ desktopApp: ElectronApplication | null }>({
  desktopApp: async ({ baseURL }, use) => {
    if (process.env.E2E_DESKTOP_NATIVE !== "1") return use(null);
    const native = await openNativeDesktop(baseURL!, "parity");
    try {
      await use(await native.launch());
    } finally {
      await native.dispose();
    }
  },
  page: async ({ page, desktopApp, baseURL }, use) => {
    await use(
      desktopApp
        ?.windows()
        .find((window) => window.url().startsWith(baseURL!)) ?? page,
    );
  },
});

export const api = createApiJsonClient(
  process.env.E2E_API_URL || "http://localhost:8008/v1",
);
export const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "DesktopParity123!",
};

/** Size the Electron window when the journey runs in the shell, else the browser viewport. */
export async function resize(
  page: Page,
  desktopApp: ElectronApplication | null,
  width: number,
  height: number,
) {
  if (desktopApp) {
    const window = await desktopApp.browserWindow(page);
    await window.evaluate(
      (window, size) => window.setContentSize(size.width, size.height),
      { width, height },
    );
  } else {
    await page.setViewportSize({ width, height });
  }
}

/**
 * One signed-in test user with an account and a manifest project, and the
 * single teardown that removes both. A failure while provisioning removes the
 * user too. Without a `name` only the user is created.
 */
export async function provisionDesktopScene(options: {
  databaseUrl: string;
  emailPrefix: string;
  name: string;
  fund?: boolean;
}): Promise<DesktopScene>;
export async function provisionDesktopScene(options: {
  emailPrefix: string;
}): Promise<Omit<DesktopScene, "accounts" | "project">>;
export async function provisionDesktopScene(options: {
  emailPrefix: string;
  databaseUrl?: string;
  name?: string;
  fund?: boolean;
}) {
  const email = `${options.emailPrefix}-${randomUUID()}@example.test`;
  const user = await createAuthUser(email, authOptions);
  const session = await signIn(email, authOptions);
  let project: ManifestProject | undefined;
  const dispose = async () => {
    await project?.dispose();
    await deleteAuthUser(user.id, authOptions);
  };
  if (!options.name || !options.databaseUrl) return { email, user, session, dispose };
  try {
    const accounts = await accountsOf(session.access_token);
    if (options.fund)
      await fundAccount(options.databaseUrl, accounts[0].account_id);
    const created = await createManifestProject({
      api,
      accessToken: session.access_token,
      accountId: accounts[0].account_id,
      userId: user.id,
      name: options.name,
      databaseUrl: options.databaseUrl,
    });
    let projectDisposed = false;
    project = {
      id: created.id,
      dispose: async () => {
        if (projectDisposed) return;
        projectDisposed = true;
        await created.dispose();
      },
    };
    return { email, user, session, accounts, project, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export interface DesktopScene {
  email: string;
  user: Awaited<ReturnType<typeof createAuthUser>>;
  session: Awaited<ReturnType<typeof signIn>>;
  accounts: { account_id: string }[];
  project: ManifestProject;
  dispose: () => Promise<void>;
}

/** The macOS row rule reads `navigator.platform`, which a Linux CI runner would report as Linux. */
export async function pinMacPlatform(page: Page, platform = "MacIntel") {
  await page.addInitScript(
    (value) =>
      Object.defineProperty(navigator, "platform", { get: () => value }),
    platform,
  );
}

/** The test database every journey provisions its project in. */
export function desktopDatabaseUrl(): string {
  const databaseUrl =
    process.env.KE2E_DATABASE_URL || process.env.E2E_DATABASE_URL;
  if (!databaseUrl)
    throw new Error("Desktop parity requires the configured test database");
  return databaseUrl;
}

/**
 * The caller's accounts. Sign-up creates no account (Workspaces), so a fresh
 * test user creates one first, the way the product's "Create workspace" does.
 */
export async function accountsOf(accessToken: string): Promise<{ account_id: string }[]> {
  const accounts = await api<{ account_id: string }[]>(accessToken, "GET", "/accounts");
  if (accounts.length > 0) return accounts;
  await api<{ account_id: string }>(accessToken, "POST", "/accounts", { name: "Desktop parity" }, 201);
  return api<{ account_id: string }[]>(accessToken, "GET", "/accounts");
}

/** Check rendered geometry: a source-string assertion cannot detect collapsed flex lists. */
/** Stop and Thinking read one busy value: exactly one row while Stop shows, none otherwise. */
export async function expectThinkingMatchesStop(page: Page) {
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  const rows = page.getByTestId("session-busy-indicator");
  await expect
    .poll(async () => {
      const stopVisible = await stop.isVisible();
      return (await rows.count()) === (stopVisible ? 1 : 0);
    })
    .toBe(true);
}

/**
 * Settings → Appearance picks the mode from the searchable Theme combobox
 * (#9904). Its rows render in a portal outside the settings dialog, so the
 * row is found on the page. The trigger then names the chosen row.
 */
export async function chooseAppearanceTheme(
  page: Page,
  settings: Locator,
  theme: string,
) {
  const picker = settings.getByRole("button", { name: "Theme", exact: true });
  await picker.click();
  await page.getByRole("option", { name: theme, exact: true }).click();
  await expect(picker).toContainText(theme);
}

export async function expectSeparateRows(rows: Locator) {
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  const boxes = await rows.evaluateAll((elements) =>
    elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.textContent,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
        };
      })
      .filter((rect) => rect.height > 0),
  );
  expect(boxes.length).toBeGreaterThan(1);
  for (let index = 1; index < boxes.length; index++) {
    expect(
      boxes[index].top,
      `${boxes[index - 1].label} overlaps ${boxes[index].label}`,
    ).toBeGreaterThanOrEqual(boxes[index - 1].bottom - 1);
  }
}
