import path from "node:path";

import { expect, test } from "@playwright/test";

const fixtures = path.resolve(process.cwd(), "..", "..", "fixtures", "sample");
const persistenceConfigured =
  (process.env["DASHER_DATABASE_URL"] ?? "").trim() !== "";

test.describe("a saved dashboard", () => {
  test.skip(!persistenceConfigured, "No database configured");

  test("is saved when signed in, reopens by link, and is listed", async ({
    page,
  }) => {
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    expect(bootstrap.ok()).toBe(true);

    await page.goto("/");
    await page
      .getByLabel("Choose a spreadsheet or CSV data source")
      .setInputFiles(path.join(fixtures, "transactions.csv"));
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("Spending by category for the finance review");
    await page.getByRole("button", { name: "Build dashboard" }).click();

    const permalink = page.getByRole("link", {
      name: "Open this dashboard by link",
    });
    await expect(permalink).toBeVisible();
    const href = await permalink.getAttribute("href");
    expect(href).toMatch(/^\/d\/[0-9a-f-]{36}$/u);
    const title = await page
      .getByRole("heading", { level: 1 })
      .first()
      .textContent();

    await page.goto(href!);
    await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText(
      title ?? "",
    );
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText(
      title ?? "",
    );

    await page.goto("/dashboards");
    await expect(
      page.getByRole("link", { name: title ?? "" }).first(),
    ).toBeVisible();
  });

  test("is changed by asking, at the same link, keeping what was there", async ({
    page,
  }) => {
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    expect(bootstrap.ok()).toBe(true);

    await page.goto("/");
    await page
      .getByLabel("Choose a spreadsheet or CSV data source")
      .setInputFiles(path.join(fixtures, "transactions.csv"));
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("Spending by category");
    await page.getByRole("button", { name: "Build dashboard" }).click();

    const href = await page
      .getByRole("link", { name: "Open this dashboard by link" })
      .getAttribute("href");
    expect(href).toMatch(/^\/d\/[0-9a-f-]{36}$/u);

    await page.goto(href!);
    // The category the refinement will remove is there to begin with.
    await expect(page.getByText(/Salaries and benefits/).first()).toBeVisible();

    const refine = page.getByRole("region", {
      name: "Change this dashboard",
    });
    await expect(refine).toBeVisible();
    await refine
      .getByRole("textbox", { name: "Change this dashboard" })
      .fill("Exclude Salaries and benefits");
    await refine.getByRole("button", { name: "Apply change" }).click();

    // Same link, changed dashboard: a successor version was written and the
    // head moved to it, rather than a second dashboard appearing.
    await expect(page.getByText(/Salaries and benefits/)).toHaveCount(0, {
      timeout: 15_000,
    });
    expect(page.url()).toContain(href!);
    await page.reload();
    await expect(page.getByText(/Salaries and benefits/)).toHaveCount(0);

    // And it is still one dashboard in the list, not two. Matched by link
    // target rather than by title: a refinement may retitle the dashboard, and
    // the property under test is that no second one was created.
    await page.goto("/dashboards");
    await expect(page.locator('a[href^="/d/"]')).toHaveCount(1);
  });

  test("archiving removes it from the list", async ({ page }) => {
    await page.context().request.post("/dev/bootstrap");
    await page.goto("/");
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("Largest transactions to archive");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(
      page.getByRole("link", { name: "Open this dashboard by link" }),
    ).toBeVisible();
    const title = await page
      .getByRole("heading", { level: 1 })
      .first()
      .textContent();

    await page.goto("/dashboards");
    const link = page.getByRole("link", { name: title ?? "" }).first();
    await expect(link).toBeVisible();
    await page
      .getByRole("button", { name: `Archive ${title ?? ""}` })
      .first()
      .click();
    await expect(page.getByRole("link", { name: title ?? "" })).toHaveCount(0);
  });

  test("does not serve another organization's dashboard", async ({ page }) => {
    await page.context().request.post("/dev/bootstrap");
    await page.goto("/");
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("A private dashboard");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    const href = await page
      .getByRole("link", { name: "Open this dashboard by link" })
      .getAttribute("href");

    await page.context().clearCookies();
    const anonymous = await page.goto(href!);
    expect(anonymous?.status()).toBe(404);

    await page.context().request.post("/dev/bootstrap");
    const other = await page.goto(href!);
    expect(other?.status()).toBe(404);
  });

  test("the landing sample is not saved", async ({ page }) => {
    await page.context().request.post("/dev/bootstrap");
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: "Open this dashboard by link" }),
    ).toHaveCount(0);
  });

  test("a malformed id is a miss, not a server error", async ({ page }) => {
    await page.context().request.post("/dev/bootstrap");
    const response = await page.goto("/d/not-a-uuid");
    expect(response?.status()).toBe(404);
  });
});
