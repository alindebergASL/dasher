import { expect, test } from "@playwright/test";

test("a plain-language request re-composes the dashboard", async ({ page }) => {
  await page.goto("/");

  // The default request renders the general overview.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Sacramento River Conditions",
  );
  await expect(
    page.getByRole("button", { name: /01\s+Overview/ }),
  ).toBeVisible();

  await page
    .getByLabel("What do you want to monitor?")
    .fill("I need a flood watch view for emergency response");
  await page.getByRole("button", { name: "Build dashboard" }).click();

  // Title, audience, and page structure are all planner decisions, and all move.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Sacramento Flood Watch",
  );
  await expect(page.getByText("Emergency management leads")).toBeVisible();
  const pageNav = page.locator(".sidebar, .page-nav").first();
  await expect(
    pageNav.getByRole("button", { name: /01\s+Watch/ }),
  ).toBeVisible();
  await expect(
    pageNav.getByRole("button", { name: /02\s+Movement/ }),
  ).toBeVisible();

  // The emergency framing leads with what needs attention rather than the
  // conditions summary.
  const firstPanelHeading = page.locator(".dashboard-grid .panel h2").first();
  await expect(firstPanelHeading).toHaveText("Needs attention");
});

test("a request naming an unavailable gauge is rejected and repaired", async ({
  page,
}) => {
  await page.goto("/");

  await page
    .getByLabel("What do you want to monitor?")
    .fill("Compare the Sacramento and Feather river gauges");
  await page.getByRole("button", { name: "Build dashboard" }).click();

  // The rejection is disclosed rather than hidden.
  await expect(
    page.getByText(/that plan was rejected and corrected/),
  ).toBeVisible();

  // The unavailable Feather River site never reaches the page.
  await expect(page.locator("body")).not.toContainText("11407000");

  // A dashboard still rendered, built only from gauges that exist.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("gauge selection follows the request", async ({ page }) => {
  await page.goto("/");

  await page
    .getByRole("button", { name: "How is the American river doing?" })
    .click();

  await expect(page.getByText("1 gauge monitored")).toBeVisible();
  await expect(page.getByText("3 gauges monitored")).toHaveCount(0);
});

test("an empty request is refused with a usable message", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("What do you want to monitor?").fill("   ");
  await page.getByRole("button", { name: "Build dashboard" }).click();

  await expect(page.locator("p.request-error")).toHaveText(
    "Type what you want to monitor to get started.",
  );
});
