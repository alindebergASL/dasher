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

test("an air-quality request produces an air dashboard in air vocabulary", async ({
  page,
}) => {
  // No database needed: this is the intake seam — router, catalog, planner,
  // compiler — visible in the page. The air chip is the product's own
  // suggestion, so the journey starts where a reader would.
  await page.goto("/");
  await page
    .getByRole("button", { name: "Air quality across Sacramento" })
    .click();

  await expect(
    page.getByRole("heading", { name: "Sacramento Air Quality" }),
  ).toBeVisible();
  await expect(page.getByText("Monitor map")).toBeVisible();
  // "Across Sacramento" narrows selection to the monitor whose locality the
  // request names, so the count is the fake planner's choice, not a constant.
  await expect(page.getByText(/\d+ monitors? monitored/u)).toBeVisible();
  // The whole visible dashboard, swept for the other domain's words. The
  // strict version of this lives in the compiler's prose-sweep unit test;
  // this is the same claim about what a reader actually sees.
  await expect(page.locator("main")).not.toContainText(/gauge|USGS/iu);
});

test("an explicit UCR enrollment request builds the official non-sensor dashboard", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Current student enrollment at UC Riverside" })
    .click();

  await expect(
    page.getByRole("heading", { name: "UC Riverside Enrollment — Fall 2025" }),
  ).toBeVisible();
  await expect(page.getByText("27,633", { exact: true })).toBeVisible();
  await expect(page.getByText("24,034", { exact: true })).toBeVisible();
  await expect(page.getByText("3,599", { exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(
    /gauge|monitor|station/iu,
  );
  await expect(page.getByLabel("Change this dashboard")).toHaveCount(0);
  await expect(
    page.getByText(/official snapshot has no refinement path yet/iu),
  ).toBeVisible();
});

test("the UCR no-plan notice survives the mobile cascade", async ({ page }) => {
  // The desktop test above cannot catch this. The mobile block hides every
  // `.request-note` to keep the pinned request strip out of the layout, and
  // this notice is the only thing standing in for the refinement form on the
  // official-snapshot path — so if the hide wins, a phone is told nothing at
  // all about why it cannot refine, visually or through the a11y tree.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .locator("#dashboard-request")
    .fill("Current student enrollment at UC Riverside");
  await page.getByRole("button", { name: "Build dashboard" }).click();

  await expect(
    page.getByRole("heading", { name: "UC Riverside Enrollment — Fall 2025" }),
  ).toBeVisible();

  const notice = page.locator(".request-workspace > .request-note");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/no refinement path yet/iu);
  const box = await notice.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThan(0);
  // Flush against the viewport edge is the specific way this rendered wrong
  // when the band's padding lived only on the refine form.
  expect(
    await notice.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingLeft),
    ),
  ).toBeGreaterThan(0);
});

test("a request naming neither domain is refused, not guessed at", async ({
  page,
}) => {
  await page.goto("/");
  const requestBox = page.getByRole("textbox", {
    name: "What do you want to monitor?",
  });

  await requestBox.fill("stock prices for tomorrow");
  await page.getByRole("button", { name: "Build dashboard" }).click();
  await expect(page.locator("p.request-error")).toContainText(
    "river conditions, air quality, and UC Riverside enrollment",
  );

  await requestBox.fill("compare river conditions and air quality");
  await page.getByRole("button", { name: "Build dashboard" }).click();
  await expect(page.locator("p.request-error")).toContainText(
    "one dashboard at a time",
  );
});
