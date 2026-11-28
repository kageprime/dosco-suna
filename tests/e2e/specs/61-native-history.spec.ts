import { expect, test } from "@playwright/test";

test("Back without a prior history entry keeps the page usable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/auth", { waitUntil: "domcontentloaded" });
  const initialURL = page.url();
  const email = page.getByRole("textbox", { name: "Email", exact: true });
  await expect(email).toBeVisible();
  // Auth initialization can add an entry. Model opening this route directly.
  const session = await page.context().newCDPSession(page);
  await session.send("Page.resetNavigationHistory");
  await session.detach();
  expect(await page.evaluate(() => window.history.length)).toBe(1);

  expect(await page.goBack()).toBeNull();
  await expect(page).toHaveURL(initialURL);
  await expect(email).toBeVisible();
  await email.fill("history-check@example.test");
  await expect(email).toHaveValue("history-check@example.test");
  expect(errors).toEqual([]);
});

// Wheel automation cannot generate macOS's native swipe-between-pages gesture.
// Assert its CSS prerequisite on the rendered root, not the stylesheet text.
test("native horizontal history remains enabled while vertical overscroll stays suppressed", async ({
  page,
}) => {
  await page.goto("/auth");
  await expect(page.locator("html")).toHaveCSS("overscroll-behavior-x", "auto");
  await expect(page.locator("html")).toHaveCSS("overscroll-behavior-y", "none");
  await page.goto("/");
  await page.goBack();
  await expect(page).toHaveURL(/\/auth/);
  await page.goForward();
  await expect(page).toHaveURL(/\/$/);
});
