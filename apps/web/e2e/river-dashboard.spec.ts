import { expect, test } from "@playwright/test";

const briefLabels = ["Known", "Changed", "Important", "Next safe action"];
const briefHeadlines = [
  "3 gauges monitored",
  "Sacramento River rose fastest",
  "3 items need attention",
  "Review American River gauge",
];

test("river dashboard interactions, evidence, and architecture", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByText("Demo dashboard")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sacramento River Conditions" }),
  ).toBeVisible();

  const brief = page.getByRole("region", { name: "Executive brief" });
  await expect(brief).toBeVisible();
  for (const label of briefLabels) {
    await expect(brief.getByText(label, { exact: true })).toBeVisible();
  }
  for (const headline of briefHeadlines) {
    await expect(brief.getByText(headline, { exact: true })).toBeVisible();
  }
  expect(
    await brief.evaluate((element) =>
      Boolean(
        element.compareDocumentPosition(
          document.querySelector(".dashboard-grid")!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ),
  ).toBe(true);
  expect(
    await brief.locator(".executive-brief-list").evaluate((element) => {
      return getComputedStyle(element).gridTemplateColumns.split(" ").length;
    }),
  ).toBe(4);
  expect(
    await page.evaluate(() => ({
      document:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      body: document.body.scrollWidth > document.body.clientWidth,
    })),
  ).toEqual({ document: false, body: false });

  await brief.getByRole("button", { name: "Evidence for Changed" }).click();
  const changedEvidence = page.getByRole("dialog", {
    name: "Sources and evidence",
  });
  await expect(changedEvidence).toBeVisible();
  await expect(
    changedEvidence.getByRole("link", {
      name: /Open U\.S\. Geological Survey source/i,
    }),
  ).toBeVisible();
  await expect(
    changedEvidence.getByText(/One-, six-, and 24-hour changes are calculated/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close evidence" }).click();

  await brief
    .getByRole("button", { name: "Evidence for Next safe action" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Sources and evidence" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close evidence" }).click();

  await page.getByRole("button", { name: /02\s+Gauge details/i }).click();
  await expect(
    page.getByRole("heading", { name: "Current readings", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /01\s+Overview/i }).click();

  await page
    .getByRole("button", {
      name: /SACRAMENTO R A FREEPORT CA, station 11447650/i,
    })
    .click();
  await expect(page.getByText("Station 11447650")).toBeVisible();
  await expect(page.getByText("38.4566, -121.5019")).toBeVisible();

  await page
    .getByRole("button", { name: /Evidence for:/ })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Sources and evidence" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("link", { name: /Open U\.S\. Geological Survey source/i })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close evidence" }).click();
  await page
    .getByRole("button", { name: "Evidence for Sacramento River ranking" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Sources and evidence" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close evidence" }).click();

  const architectureButton = page.getByRole("button", {
    name: /Architecture/i,
  });
  await architectureButton.click();
  const architecture = page.getByRole("dialog", {
    name: "How this dashboard works",
  });
  await expect(architecture).toBeVisible();
  await expect(
    architecture.getByText("optional planning context"),
  ).toBeVisible();
  const closeArchitecture = page.getByRole("button", {
    name: "Close architecture",
  });
  await expect(closeArchitecture).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeArchitecture).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(architecture).toBeHidden();
  await expect(architectureButton).toBeFocused();
});

test("mobile keeps the two-column brief, freshness, and contained scrolling reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const brief = page.getByRole("region", { name: "Executive brief" });
  await expect(brief).toBeVisible();
  for (const label of briefLabels) {
    await expect(brief.getByText(label, { exact: true })).toBeVisible();
  }
  for (const headline of briefHeadlines) {
    await expect(brief.getByText(headline, { exact: true })).toBeVisible();
  }
  expect(
    await brief.locator(".executive-brief-list").evaluate((element) => {
      return getComputedStyle(element).gridTemplateColumns.split(" ").length;
    }),
  ).toBe(2);
  await expect(page.locator(".mobile-next")).toHaveCount(0);
  await expect(page.locator(".mobile-status .freshness")).toContainText(
    "1 gauge needs attention",
  );
  await expect(page.locator(".mobile-status")).toContainText(
    "Latest observation",
  );
  await expect(
    page.getByRole("button", { name: /Architecture/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /02\s+Gauge details/i }),
  ).toBeVisible();

  const overflow = await page.evaluate(() => ({
    document:
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
    body: document.body.scrollWidth > document.body.clientWidth,
  }));
  expect(overflow).toEqual({ document: false, body: false });

  await page.getByRole("button", { name: /02\s+Gauge details/i }).click();
  const table = page.locator(".table-wrap");
  await expect(table).toBeVisible();
  expect(
    await table.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
});
