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

  // Still refused, and for the reason that survived the multi-source slice:
  // river + air is now a supported pair, but river + enrollment is not a pair
  // at all -- one is sensor readings, the other an official snapshot with no
  // shared notion of freshness. Naming both leaves nothing to build.
  await requestBox.fill("compare river conditions and UC Riverside enrollment");
  await page.getByRole("button", { name: "Build dashboard" }).click();
  await expect(page.locator("p.request-error")).toContainText(
    "one dashboard at a time",
  );
});

test("a request naming both sensor domains builds one dashboard with both halves", async ({
  page,
}) => {
  // The multi-source journey, in fixture mode: no database, no live upstream,
  // just intake -> two loads -> two compilations -> one composition -> render.
  // This is the request the slice was scoped to and the only one it supports.
  await page.goto("/");
  await page
    .getByLabel("What do you want to monitor?")
    .fill("Compare river conditions and air quality near Sacramento");
  await page.getByRole("button", { name: "Build dashboard" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "River and Air quality — combined conditions",
  );

  // Four pages, each attributed. Both domains title their first page
  // "Overview", so an unattributed nav would show the reader two of them.
  const pageNav = page.locator(".sidebar, .page-nav").first();
  await expect(
    pageNav.getByRole("button", { name: /01\s+River — Overview/ }),
  ).toBeVisible();
  await expect(
    pageNav.getByRole("button", { name: /03\s+Air quality — Overview/ }),
  ).toBeVisible();

  // Each half in its own vocabulary, on screen, on its own page. Scoped to the
  // panel grid rather than `main`, because the SHARED surfaces around it — the
  // freshness line and the footer notice — name both subjects on purpose, and
  // that attribution is a feature of this dashboard rather than leakage.
  const panels = page.locator(".dashboard-grid");
  await expect(page.getByRole("heading", { name: "Gauge map" })).toBeVisible();
  // `\bmonitors?\b`, not `monitor`. The river half says "Gauges monitored",
  // which a substring match flags as air vocabulary -- it did, the first time
  // this test ran, exactly as it did in the compiler's own prose sweep.
  await expect(panels).not.toContainText(/\bmonitors?\b|pm2\.5|µg\/m³/iu);

  await pageNav
    .getByRole("button", { name: /03\s+Air quality — Overview/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Monitor map" }),
  ).toBeVisible();
  await expect(panels).not.toContainText(/gauge|USGS|water[\s-]level/iu);

  // The executive brief is the one place both halves are attributed together,
  // and it is on the landing page. Its page id is namespaced, which is exactly
  // what stopped it rendering before the gate stopped matching on a literal.
  await pageNav.getByRole("button", { name: /01\s+River — Overview/ }).click();
  const brief = page.getByRole("region", { name: "Executive brief" });
  await expect(brief).toBeVisible();
  await expect(brief).toContainText("River:");
  await expect(brief).toContainText("Air quality:");

  // Freshness is the pair's, and says so.
  await expect(page.locator(".freshness").first()).toContainText("River:");
  await expect(page.locator(".freshness").first()).toContainText(
    "Air quality:",
  );
});

test("a combined dashboard cannot be refined yet, and says so", async ({
  page,
}) => {
  // Refinement edits a single plan. There are two plans behind this dashboard
  // and no rule yet for which one an instruction addresses, so the honest
  // answer is a refusal rather than a guess at the reader's intent.
  await page.goto("/");
  await page
    .getByLabel("What do you want to monitor?")
    .fill("Compare river conditions and air quality near Sacramento");
  await page.getByRole("button", { name: "Build dashboard" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "River and Air quality — combined conditions",
  );

  // Not an error after a failed attempt: the form is not offered at all, and
  // the reason is stated where the form would have been.
  await expect(page.getByLabel("Change this dashboard")).toHaveCount(0);
  const notice = page.locator(".request-workspace > .request-note");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/combined dashboard/iu);
  await expect(notice).toContainText(/which of its two sources/iu);
  // And NOT the enrollment wording. Both cases reach this notice through the
  // same missing plan, and both read it from the same element, so the only
  // thing separating them is the reason the action reported.
  await expect(notice).not.toContainText(/official snapshot/iu);

  // The dashboard it declined to edit is still whole.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "River and Air quality — combined conditions",
  );
});
