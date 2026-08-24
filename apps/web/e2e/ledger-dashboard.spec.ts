// @ts-nocheck
import { expect, test } from "@playwright/test";

/**
 * The first planned dashboard that is not built from stations.
 *
 * Every dashboard before this one either came from `compilePlan`, which takes
 * `readonly Station[]`, or was a hand-written `DashboardSpec` literal with no
 * plan behind it at all. This journey is the first that is planned, validated,
 * compiled and evidenced without a site, a coordinate, or a sensor anywhere in
 * it — which is the claim the slice exists to make, checked in a browser rather
 * than in a unit test.
 */

test("an operating-spend request builds a dashboard with no station in it", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("What do you want to monitor?")
    .fill("Operating spend by category");
  await page.getByRole("button", { name: "Build dashboard" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Operating Spend",
  );

  // The dashboard itself, not the page around it. The example chips offer a
  // river request by name — that is the product's menu, and it would make a
  // whole-body assertion pass or fail for reasons that have nothing to do with
  // this dashboard.
  const dashboard = page.locator("main");
  await expect(dashboard).not.toContainText(
    /siteId|latitude|longitude|gauge|river|station/iu,
  );
  await expect(page.locator(".sidebar")).not.toContainText(
    /gauge|river|station/iu,
  );

  // Built from the neutral components, and demonstrably not from the two that
  // are not: a ledger has nowhere to put a map.
  await expect(
    page.getByRole("heading", { name: "Spending summary" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "At a glance" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Largest movers" }),
  ).toBeVisible();
  await expect(page.locator(".map-panel")).toHaveCount(0);
  await expect(page.locator("table")).toHaveCount(0);

  // Figures Dasher computed, not figures a planner wrote.
  await expect(dashboard).toContainText("$474,855");
  await expect(dashboard).toContainText("Contractors");
});

test("every figure on the ledger dashboard has evidence behind it", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("What do you want to monitor?")
    .fill("Operating spend by category");
  await page.getByRole("button", { name: "Build dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // The same contract the river dashboard is held to: a reader can get from
  // any number to what produced it.
  const panels = page.locator(".dashboard-grid > .panel");
  expect(await panels.count()).toBeGreaterThan(2);
  for (let index = 0; index < (await panels.count()); index += 1) {
    await expect(
      panels.nth(index).getByRole("button", { name: /View \d+ sources?/u }),
    ).toBeVisible();
  }

  await page.locator(".dashboard-grid .sources-button").first().click();
  const evidence = page.getByRole("dialog");
  await expect(evidence).toContainText("Operating ledger export");
  await expect(evidence).toContainText("Ledger calculations");
});

test("the architecture panel explains the ledger path without a sensor in it", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("What do you want to monitor?")
    .fill("Operating spend by category");
  await page.getByRole("button", { name: "Build dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.getByRole("button", { name: /Architecture/u }).click();
  const dialog = page.getByRole("dialog");

  await expect(dialog).toContainText("Ledger export");
  await expect(dialog).toContainText("Dasher calculations");
  // No model ran, and the panel whose job is explaining how the dashboard was
  // made is the one place claiming otherwise would mislead.
  await expect(dialog).toContainText("fake-ledger-planner-v1");
  await expect(dialog).not.toContainText(/gauge|river|station/iu);
});
