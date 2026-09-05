import path from "node:path";

import { expect, test } from "@playwright/test";

const fixtures = path.resolve(process.cwd(), "..", "..", "fixtures", "sample");

test.describe("uploading a spreadsheet", () => {
  test("a transactions export becomes a dashboard", async ({ page }) => {
    await page.goto("/");
    await page
      .getByLabel("Choose a CSV data source")
      .setInputFiles(path.join(fixtures, "transactions.csv"));
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("Spending by category and what changed");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(
      page.getByRole("button", { name: "Build dashboard" }),
    ).toBeEnabled();
    await expect(page.locator(".request-error")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Dataset interpretation" }),
    ).toContainText(/Amount/);
    await expect(
      page.getByRole("status", { name: "Data source" }),
    ).toContainText("Using transactions.csv.");
    await expect(page.getByText(/Salaries and benefits/).first()).toBeVisible();
  });

  test("a wide budget export is unpivoted and built", async ({ page }) => {
    await page.goto("/");
    await page
      .getByLabel("Choose a CSV data source")
      .setInputFiles(path.join(fixtures, "operating-spend-wide.csv"));
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("Which lines are over budget?");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(
      page.getByRole("button", { name: "Build dashboard" }),
    ).toBeEnabled();
    await expect(page.locator(".request-error")).toHaveCount(0);
    await expect(page.getByText(/Cloud infrastructure/).first()).toBeVisible();
  });

  test("a named two-measure comparison renders relationship metrics", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByLabel("Choose a CSV data source").setInputFiles({
      name: "monthly-metrics.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        [
          "Month,Customers,Headcount",
          "2026-01,100,12",
          "2026-02,120,15",
          "2026-03,126,18",
        ].join("\n"),
      ),
    });
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("Compare customers vs headcount");
    await page.getByRole("button", { name: "Build dashboard" }).click();

    await expect(
      page.getByRole("button", { name: "Build dashboard" }),
    ).toBeEnabled();
    await expect(page.locator(".request-error")).toHaveCount(0);
    const relationship = page.locator("section.panel").filter({
      has: page.getByRole("heading", { name: "Customers vs Headcount" }),
    });
    await expect(relationship).toContainText("Customers, Mar 2026");
    await expect(relationship).toContainText("120 in Feb 2026 · +5.0%");
    await expect(relationship).toContainText("Headcount, Mar 2026");
    await expect(relationship).toContainText("15 in Feb 2026 · +20.0%");
    await expect(relationship).toContainText(
      "Customers per Headcount, Mar 2026",
    );
    await expect(relationship.getByText("7", { exact: true })).toBeVisible();
    await expect(relationship).toContainText("8 in Feb 2026 · -12.5%");
    const cards = relationship.locator(".metric-card");
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1);
  });

  test("a mixed-sign cash-flow upload renders safe directional shares", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByLabel("Choose a CSV data source").setInputFiles({
      name: "cash-flow.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        [
          "Month,Category,Amount,Description",
          "2026-08,Collections,600 USD,Invoice A",
          "2026-08,Sales,400 USD,Order B",
          "2026-08,Payroll,-300 USD,Payroll run",
          "2026-08,Vendors,-200 USD,Supplier bill",
        ].join("\n"),
      ),
    });
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("Analyze cash flow by category");
    await page.getByRole("button", { name: "Build dashboard" }).click();

    await expect(
      page.getByRole("button", { name: "Build dashboard" }),
    ).toBeEnabled();
    await expect(page.locator(".request-error")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { level: 1, name: "Cash flow by Category" }),
    ).toBeVisible();
    const metrics = page.locator(".metric-card");
    const grossInflow = metrics.filter({ hasText: "Gross inflow" });
    const grossOutflow = metrics.filter({ hasText: "Gross outflow" });
    const netMovement = metrics.filter({ hasText: "Net movement" });
    await expect(grossInflow).toBeVisible();
    await expect(grossOutflow).toBeVisible();
    await expect(netMovement).toBeVisible();
    await expect(grossInflow.locator("strong")).toHaveText("$1,000");
    await expect(grossOutflow.locator("strong")).toHaveText("$500");
    await expect(netMovement.locator("strong")).toHaveText("+$500");

    const shareLabels = page.locator(".ranking-list small");
    const inflowShares = shareLabels.filter({ hasText: "share of inflow" });
    const outflowShares = shareLabels.filter({ hasText: "share of outflow" });
    await expect(inflowShares).toHaveCount(2);
    await expect(outflowShares).toHaveCount(2);
    await expect(inflowShares.first()).toBeVisible();
    await expect(outflowShares.first()).toBeVisible();
    const renderedShares = await shareLabels.allTextContents();
    expect(renderedShares).toHaveLength(4);
    expect(
      renderedShares.every((label) => {
        const match = /^(\d+(?:\.\d+)?)% share of (?:inflow|outflow)$/u.exec(
          label,
        );
        if (match === null) return false;
        const share = Number(match[1]);
        return share >= 0 && share <= 100;
      }),
    ).toBe(true);

    const nextAction = page.getByRole("article", { name: "Next safe action" });
    await expect(nextAction).toBeVisible();
    await expect(nextAction).toContainText(
      "Review Payroll, the largest outflow driver",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test("a file that is not a table is refused with a reason", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("Choose a CSV data source").setInputFiles({
      name: "notes.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("just a sentence with no header or rows"),
    });
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("Anything");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(
      page.getByRole("button", { name: "Build dashboard" }),
    ).toBeEnabled();
    await expect(page.locator(".request-error")).toContainText(
      /could not be read/i,
    );
  });

  test("a refinement re-reads the uploaded file", async ({ page }) => {
    await page.goto("/");
    await page
      .getByLabel("Choose a CSV data source")
      .setInputFiles(path.join(fixtures, "transactions.csv"));
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("Spending by category");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(
      page.getByRole("button", { name: "Build dashboard" }),
    ).toBeEnabled();
    await page
      .getByRole("textbox", { name: "Change this dashboard" })
      .fill("Exclude Salaries and benefits");
    await page.getByRole("button", { name: "Apply change" }).click();
    await expect(
      page.getByRole("button", { name: "Apply change" }),
    ).toBeEnabled();
    await expect(page.locator(".request-error")).toHaveCount(0);
    await expect(page.getByText(/Salaries and benefits/)).toHaveCount(0);
  });
});
