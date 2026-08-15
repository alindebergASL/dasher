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
    page.getByText(/first plan was rejected by Dasher and corrected/),
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

test("a change instruction edits the dashboard on screen", async ({ page }) => {
  await page.goto("/");

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Sacramento River Conditions");
  await expect(page.getByRole("heading", { name: "Gauge map" })).toBeVisible();

  await page.getByLabel("Change this dashboard").fill("Drop the map");
  await page.getByRole("button", { name: "Apply change" }).click();

  await expect(page.getByRole("heading", { name: "Gauge map" })).toHaveCount(0);

  // Refinement edits the plan rather than re-composing it: the title and the
  // sections the reader did not mention are still there.
  await expect(heading).toHaveText("Sacramento River Conditions");
  await expect(
    page.getByRole("heading", { name: "Conditions summary" }),
  ).toBeVisible();
});

test("a change it cannot interpret says so instead of redrawing", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByLabel("Change this dashboard").fill("Make it more upbeat");
  await page.getByRole("button", { name: "Apply change" }).click();

  await expect(page.getByText(/did not understand that change/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gauge map" })).toBeVisible();
});

test("a change survives a fresh request replacing the dashboard", async ({
  page,
}) => {
  await page.goto("/");

  // Refine, then re-plan. The second request must compose from scratch rather
  // than carry the earlier edit, or the reader can never get the map back.
  await page.getByRole("button", { name: "Drop the map" }).click();
  await expect(page.getByRole("heading", { name: "Gauge map" })).toHaveCount(0);

  await page
    .getByLabel("What do you want to monitor?")
    .fill("I need a flood watch view for emergency response");
  await page.getByRole("button", { name: "Build dashboard" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Sacramento Flood Watch",
  );
  await expect(page.getByRole("heading", { name: "Gauge map" })).toBeVisible();
});
