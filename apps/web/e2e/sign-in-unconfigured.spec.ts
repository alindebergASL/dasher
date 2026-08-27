import { expect, test } from "@playwright/test";

/**
 * Sign-in on a deployment that cannot sign anyone in.
 *
 * WHY THIS IS ITS OWN FILE. It can only run WITHOUT a database, and the
 * persistence job asserts that every test in the report it names actually ran —
 * no skips. Living in `sign-in.spec.ts`, this case skipped on every persistence
 * run and turned that assertion permanently red, which is how it was found: the
 * gate was added and its own checker was never run against a real report.
 *
 * So the two files split along the axis the jobs split on. Everything here
 * needs no database; everything in `sign-in.spec.ts` either needs one or does
 * not care.
 */

test.describe("without a database", () => {
  test.skip(
    process.env["DASHER_DATABASE_URL"] !== undefined,
    "A database is configured, so sign-in is available",
  );

  test("says sign-in is unavailable rather than accepting an address", async ({
    page,
  }) => {
    // The honest failure. Accepting the address and answering "a link is on its
    // way" would be the one sentence this product must not say falsely — and it
    // is the sentence a correctly configured deployment gives to an address it
    // will not mail, so the two must not be confusable.
    await page.goto("/sign-in");
    await expect(page.locator("#sign-in-email")).toBeVisible();
    await page.getByLabel("Your email address").fill("someone@example.com");
    await page.getByRole("button", { name: "Email me a link" }).click();

    await expect(page.locator(".sign-in-form p.request-error")).toContainText(
      "Sign-in is unavailable",
    );
    await expect(page.locator(".sign-in-sent")).toHaveCount(0);
  });
});
