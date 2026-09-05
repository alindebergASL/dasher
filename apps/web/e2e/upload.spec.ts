import path from "node:path";

import { expect, test } from "@playwright/test";

const fixtures = path.resolve(process.cwd(), "..", "..", "fixtures", "sample");

test.describe("uploading a spreadsheet", () => {
  test("a transactions export becomes a dashboard", async ({ page }) => {
    await page.goto("/");
    await page
      .getByLabel("Your spreadsheet (CSV)")
      .setInputFiles(path.join(fixtures, "transactions.csv"));
    await page
      .getByRole("textbox", { name: "What do you want to see?" })
      .fill("Spending by category and what changed");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(
      page.getByRole("button", { name: "Build dashboard" }),
    ).toBeEnabled();
    await expect(page.locator(".request-error")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Dataset interpretation" }),
    ).toContainText(/Amount/);
    await expect(page.getByText(/Salaries and benefits/).first()).toBeVisible();
  });

  test("a wide budget export is unpivoted and built", async ({ page }) => {
    await page.goto("/");
    await page
      .getByLabel("Your spreadsheet (CSV)")
      .setInputFiles(path.join(fixtures, "operating-spend-wide.csv"));
    await page
      .getByRole("textbox", { name: "What do you want to see?" })
      .fill("Which lines are over budget?");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(
      page.getByRole("button", { name: "Build dashboard" }),
    ).toBeEnabled();
    await expect(page.locator(".request-error")).toHaveCount(0);
    await expect(page.getByText(/Cloud infrastructure/).first()).toBeVisible();
  });

  test("a file that is not a table is refused with a reason", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("Your spreadsheet (CSV)").setInputFiles({
      name: "notes.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("just a sentence with no header or rows"),
    });
    await page
      .getByRole("textbox", { name: "What do you want to see?" })
      .fill("Anything");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(page.locator(".request-error")).toContainText(
      /could not be read/i,
    );
  });

  test("a refinement re-reads the uploaded file", async ({ page }) => {
    await page.goto("/");
    await page
      .getByLabel("Your spreadsheet (CSV)")
      .setInputFiles(path.join(fixtures, "transactions.csv"));
    await page
      .getByRole("textbox", { name: "What do you want to see?" })
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
