import { expect, test } from "@playwright/test";

test.describe("the sample dashboard", () => {
  test("keeps top navigation first in visual and keyboard order", async ({
    page,
  }) => {
    await page.goto("/");

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Dasher" })).toBeFocused();
  });

  test("renders a brief, pages, and evidence on load", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(
      page.getByText("Known", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /architecture/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Planning status" }),
    ).toContainText(/trusted code computes every number/i);
  });

  test("the composer is source-aware, keyboard reachable, and width-safe", async ({
    page,
  }) => {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 768, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await expect(
        page.getByRole("heading", { level: 2, name: "Ask Dasher" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth === window.innerWidth,
        ),
      ).toBe(true);
    }

    const fileInput = page.getByLabel("Choose a CSV data source");
    await fileInput.focus();
    await expect(fileInput).toBeFocused();
    await fileInput.setInputFiles({
      name: "operations.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Date,Amount\n2026-01-01,25"),
    });
    await expect(
      page.getByRole("status", { name: "Data source" }),
    ).toContainText("Next build: uploaded file operations.csv");
    await expect(
      page.getByText("Displayed dashboard: sample data."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Use sample data" }).click();
    await expect(
      page.getByRole("status", { name: "Data source" }),
    ).toContainText("Next build: sample data");

    const question = page.getByRole("textbox", {
      name: "What should this dashboard answer?",
    });
    const longQuestion =
      "Compare customer growth with headcount by quarter, explain where the relationship changed, and identify the one segment an operator should investigate next without hiding any part of this question.";
    await question.fill(longQuestion);
    await expect(question).toHaveValue(longQuestion);
  });

  test("builds a different dashboard for a different request", async ({
    page,
  }) => {
    await page.goto("/");
    const before = await page
      .getByRole("heading", { level: 1 })
      .first()
      .textContent();
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("Largest transactions and the biggest movers");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(
      page.getByRole("button", { name: "Build dashboard" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("heading", { level: 1 }).first(),
    ).not.toHaveText(before ?? "");
    await expect(
      page.getByRole("heading", { name: "Largest rows" }).first(),
    ).toBeVisible();
  });

  test("a refinement changes the plan and leaves the rest", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByRole("textbox", { name: "Change this dashboard" })
      .fill("Just the overview");
    await page.getByRole("button", { name: "Apply change" }).click();
    await expect(
      page.getByRole("button", { name: "Apply change" }),
    ).toBeEnabled();
    await expect(page.locator(".request-error")).toHaveCount(0);
    await expect(
      page
        .getByRole("navigation", { name: "Dashboard pages" })
        .getByRole("button"),
    ).toHaveCount(1);
  });

  test("refuses an empty request with a sentence", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("textbox", { name: "What should this dashboard answer?" })
      .fill("");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(page.locator(".request-error")).toContainText(/say what/i);
  });
});
