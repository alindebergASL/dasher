import { expect, test } from "@playwright/test";

const briefLabels = ["Known", "Changed", "Important", "Next safe action"];
const statementTypeLabels = [
  "Observed · Calculated",
  "Calculated",
  "Interpreted",
  "Recommended",
];
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
  for (const label of statementTypeLabels) {
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

  const changedEvidenceButton = brief.getByRole("button", {
    name: "Evidence for Changed",
  });
  await changedEvidenceButton.focus();
  expect(
    await changedEvidenceButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineColor: style.outlineColor,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    }),
  ).toEqual({
    outlineColor: "rgb(255, 255, 255)",
    outlineWidth: "3px",
    boxShadow: "rgb(23, 108, 82) 0px 0px 0px 6px",
  });
  await changedEvidenceButton.click();
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

  await page
    .getByRole("button", { name: "Session feedback · not saved" })
    .click();
  let feedback = page.getByRole("dialog", { name: "Session feedback" });
  await expect(feedback.getByLabel("Evidence opens this session")).toHaveText(
    "2",
  );
  await expect(
    feedback.getByLabel("Next action reviewed this session"),
  ).toHaveText("Yes");
  await feedback.getByLabel("Requested evidence").selectOption("next-action");
  const startEvidenceTask = feedback.locator(".evidence-task-controls button");
  await expect(startEvidenceTask).toHaveAccessibleName("Start evidence task");
  await startEvidenceTask.focus();
  await startEvidenceTask.click();
  await expect(startEvidenceTask).toBeFocused();
  await expect(startEvidenceTask).toBeEnabled();
  await expect(startEvidenceTask).toHaveText("Task armed");
  await expect(feedback.getByLabel("Evidence task status")).toHaveText(
    "Starts when this dialog closes",
  );
  await page.keyboard.press("Escape");
  await expect(feedback).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Session feedback · not saved" }),
  ).toBeFocused();

  await brief.getByRole("button", { name: "Evidence for Changed" }).click();
  await page.getByRole("button", { name: "Close evidence" }).click();
  await brief
    .getByRole("button", { name: "Evidence for Next safe action" })
    .click();
  await page.getByRole("button", { name: "Close evidence" }).click();

  await page
    .getByRole("button", { name: "Session feedback · not saved" })
    .click();
  feedback = page.getByRole("dialog", { name: "Session feedback" });
  await expect(feedback.getByLabel("Evidence opens this session")).toHaveText(
    "4",
  );
  await expect(feedback.getByLabel("Evidence task interactions")).toHaveText(
    "3",
  );
  await expect(feedback.getByLabel("Evidence task status")).toHaveText(
    "Complete",
  );

  const rating = feedback.getByRole("radio", { name: "5" });
  await rating.focus();
  await rating.check();
  await expect(rating).toBeFocused();
  const missingContext = feedback.getByRole("checkbox", {
    name: "Missing context",
  });
  await missingContext.focus();
  await missingContext.check();
  await expect(missingContext).toBeFocused();
  const missingNeed = feedback.getByLabel(
    "Missing information or workflow need",
  );
  await missingNeed.focus();
  await missingNeed.selectOption("More historical comparison");
  await expect(missingNeed).toBeFocused();
  await page.getByRole("button", { name: "Close session feedback" }).click();

  await page
    .getByRole("button", { name: "Session feedback · not saved" })
    .click();
  feedback = page.getByRole("dialog", { name: "Session feedback" });
  await expect(feedback.getByRole("radio", { name: "5" })).toBeChecked();
  await expect(
    feedback.getByRole("checkbox", { name: "Missing context" }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Close session feedback" }).click();

  await page.reload();
  await page
    .getByRole("button", { name: "Session feedback · not saved" })
    .click();
  feedback = page.getByRole("dialog", { name: "Session feedback" });
  await expect(feedback.getByLabel("Evidence opens this session")).toHaveText(
    "0",
  );
  await expect(
    feedback.getByLabel("Next action reviewed this session"),
  ).toHaveText("No");
  await expect(feedback.getByLabel("Evidence task interactions")).toHaveText(
    "0",
  );
  await expect(feedback.getByLabel("Evidence task status")).toHaveText(
    "Not started",
  );
  await expect(feedback.getByRole("radio", { name: "5" })).not.toBeChecked();
  await page.getByRole("button", { name: "Close session feedback" }).click();

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
  for (const label of statementTypeLabels) {
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
  await expect(page.locator(".sidebar-next")).toBeHidden();
  expect(
    await page
      .getByText("Review American River gauge", { exact: true })
      .evaluateAll(
        (elements) =>
          elements.filter((element) =>
            Boolean((element as HTMLElement).offsetParent),
          ).length,
      ),
  ).toBe(1);
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

  const briefBounds = await brief.boundingBox();
  expect(briefBounds).not.toBeNull();
  expect(briefBounds!.y + briefBounds!.height).toBeLessThanOrEqual(844);
  const evidenceTargetMetrics = await brief
    .getByRole("button")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
        height: element.getBoundingClientRect().height,
      })),
    );
  for (const metric of evidenceTargetMetrics) {
    expect(metric.fontSize).toBeGreaterThanOrEqual(11);
    expect(metric.height).toBeGreaterThanOrEqual(28);
  }

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
  const architectureBounds = await architecture.boundingBox();
  expect(architectureBounds).not.toBeNull();
  expect(architectureBounds!.x).toBeGreaterThanOrEqual(0);
  expect(architectureBounds!.x + architectureBounds!.width).toBeLessThanOrEqual(
    390,
  );
  expect(architectureBounds!.y).toBeGreaterThanOrEqual(0);
  expect(
    architectureBounds!.y + architectureBounds!.height,
  ).toBeLessThanOrEqual(844);
  expect(
    await architecture.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Close architecture" }).click();

  await page
    .getByRole("button", { name: "Session feedback · not saved" })
    .click();
  const feedback = page.getByRole("dialog", { name: "Session feedback" });
  await expect(feedback).toBeVisible();
  const feedbackBounds = await feedback.boundingBox();
  expect(feedbackBounds).not.toBeNull();
  expect(feedbackBounds!.x).toBeGreaterThanOrEqual(0);
  expect(feedbackBounds!.x + feedbackBounds!.width).toBeLessThanOrEqual(390);
  expect(feedbackBounds!.y).toBeGreaterThanOrEqual(0);
  expect(feedbackBounds!.y + feedbackBounds!.height).toBeLessThanOrEqual(844);
  expect(
    await feedback.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  const needSelector = feedback.getByLabel(
    "Missing information or workflow need",
  );
  await needSelector.scrollIntoViewIfNeeded();
  await expect(needSelector).toBeVisible();
  await page.getByRole("button", { name: "Close session feedback" }).click();

  await page.getByRole("button", { name: /02\s+Gauge details/i }).click();
  const table = page.locator(".table-wrap");
  await expect(table).toBeVisible();
  expect(
    await table.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
});
