import { expect, test } from "@playwright/test";

/**
 * The slice: a generated dashboard survives a reload.
 *
 * Everything below this test is already proven without a browser — the
 * repository's integration tests save in one transaction and read in another,
 * which is what a reload is at the data layer. What only a browser can show is
 * that the product actually joins those pieces: a session cookie issued by the
 * bootstrap, carried by the browser, read by a server action, and honoured by a
 * route that renders bytes nobody recompiled.
 *
 * It is skipped when no database is configured, and that is deliberate rather
 * than convenient: the fixture demo is a supported way to run this app, so the
 * suite must pass without PostgreSQL. CI's e2e job sets `DASHER_DATABASE_URL`,
 * so the skip is a local affordance and not a hole in the gate.
 */

const persistenceConfigured =
  process.env["DASHER_DATABASE_URL"] !== undefined &&
  process.env["DASHER_DEV_SEED_DSN"] !== undefined;

test.describe("a saved dashboard", () => {
  test.skip(
    !persistenceConfigured,
    "No database configured; running in fixture-only mode",
  );

  test("survives a reload at its own URL", async ({ page }) => {
    // The development stand-in for sign-in. It sets the same cookie real
    // sign-in will, through the same seam, so nothing downstream knows the
    // difference.
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    expect(bootstrap.ok()).toBe(true);

    await page.goto("/");
    await page
      .getByRole("textbox", { name: "What do you want to monitor?" })
      .fill("Show me river conditions near Sacramento");
    await page.getByRole("button", { name: "Build dashboard" }).click();

    const permalink = page.getByRole("link", {
      name: "Open this dashboard by link",
    });
    await expect(permalink).toBeVisible();

    const href = await permalink.getAttribute("href");
    expect(href).toMatch(/^\/d\/[0-9a-f-]{36}$/u);

    // The reload. A fresh navigation to the id, with no client state carried
    // over — if the spec were being recomposed rather than read, this is where
    // it would differ.
    await page.goto(href!);
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();

    // And again, to make the point that it is durable rather than cached in
    // whatever produced it the first time.
    await page.reload();
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
  });

  test("does not serve another session's dashboard", async ({ page }) => {
    await page.context().request.post("/dev/bootstrap");
    await page.goto("/");
    await page
      .getByRole("textbox", { name: "What do you want to monitor?" })
      .fill("Show me river conditions near Sacramento");
    await page.getByRole("button", { name: "Build dashboard" }).click();

    const href = await page
      .getByRole("link", { name: "Open this dashboard by link" })
      .getAttribute("href");
    expect(href).not.toBeNull();

    // A second bootstrap is a different organization, because the seed creates
    // one per call. The first dashboard must be invisible to it — the tenant
    // boundary, reached the way a real user would reach it.
    await page.context().request.post("/dev/bootstrap");
    const response = await page.goto(href!);
    expect(response?.status()).toBe(404);
  });
});
