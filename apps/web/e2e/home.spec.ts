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
    await expect(page.getByRole("status").first()).toContainText(
      /computed from the dataset/i,
    );
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
      .getByRole("textbox", { name: "What do you want to see?" })
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
      .getByRole("textbox", { name: "What do you want to see?" })
      .fill("");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(page.locator(".request-error")).toContainText(/say what/i);
  });
});
