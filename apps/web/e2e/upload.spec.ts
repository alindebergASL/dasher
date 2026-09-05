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
