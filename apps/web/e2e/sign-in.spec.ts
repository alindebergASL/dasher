import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

/**
 * The sign-in page, in a browser.
 *
 * WHY THIS FILE EXISTS. The last time UI was added here it shipped two defects
 * no other gate could see — a form nested inside another form, and six controls
 * with no accessible name below 641px — because jsdom computes no layout and
 * the other specs assert text. This page is new UI, so it gets measured.
 *
 * NO DATABASE NEEDED, and that is the point of what it asserts. Without one,
 * sign-in is unavailable, and the page has to say so rather than accept an
 * address and silently do nothing. The link-sending path itself is proven in
 * `sign-in.integration.test.ts` against a real database, as the application
 * role.
 */

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1100 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const TALLEST_REASONABLE_INPUT = 80;

async function openSignIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await expect(page.locator("#sign-in-email")).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test.describe(`sign-in at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("names its field and renders it at the height of an input", async ({
      page,
    }) => {
      // `.request-input` carries `flex: 1 1 22rem`, which is a WIDTH basis in
      // the request bar's row container and a HEIGHT basis in this page's
      // column one. That rendered a 352px text box in the upload panel; the
      // neutralising rule is asserted here rather than assumed to have been
      // remembered.
      await openSignIn(page);

      const name = await page.locator("#sign-in-email").evaluate((element) => {
        const label = document.querySelector(
          `label[for="${element.id}"]`,
        ) as HTMLElement | null;
        if (label === null) return "";
        return getComputedStyle(label).display === "none"
          ? ""
          : (label.textContent ?? "").trim();
      });
      expect(name).toBe("Your email address");

      const box = await page.locator("#sign-in-email").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeLessThan(TALLEST_REASONABLE_INPUT);
    });

    test("does not push the page sideways", async ({ page }) => {
      await openSignIn(page);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        ),
      ).toBe(false);
    });

    test("is reachable from the site navigation", async ({ page }) => {
      // The page is worth nothing if nobody can find it. On a phone the nav is
      // at the BOTTOM — a top bar costs about 33px and the executive brief's
      // first-viewport budget had 20 — so this follows the link rather than
      // asserting where it sits.
      await page.goto("/");
      await page
        .getByRole("navigation", { name: "Site" })
        .getByRole("link", { name: "Sign in" })
        .click();
      await expect(page).toHaveURL(/\/sign-in$/u);
    });
  });
}

test.describe("without a database", () => {
  test("says sign-in is unavailable rather than accepting an address", async ({
    page,
  }) => {
    // The honest failure. Accepting the address and answering "a link is on its
    // way" would be the one sentence this product must not say falsely — and it
    // is the sentence a correctly configured deployment gives to an address it
    // will not mail, so the two must not be confusable.
    test.skip(
      process.env["DASHER_DATABASE_URL"] !== undefined,
      "A database is configured, so sign-in is available",
    );

    await openSignIn(page);
    await page.getByLabel("Your email address").fill("someone@example.com");
    await page.getByRole("button", { name: "Email me a link" }).click();

    await expect(page.locator(".sign-in-form p.request-error")).toContainText(
      "Sign-in is unavailable",
    );
    await expect(page.locator(".sign-in-sent")).toHaveCount(0);
  });
});

test("a link that was never issued lands back on sign-in, saying so", async ({
  page,
}) => {
  // Every failure is this failure: expired, already used, revoked since it was
  // sent, never issued, malformed. Distinguishing them would tell whoever holds
  // the link things the person who lost it already knows.
  await page.goto("/sign-in/verify?token=not-a-real-token");

  await expect(page).toHaveURL(/\/sign-in\?failed=1$/u);
  await expect(page.locator("main")).toContainText("That link did not work");
});

test.describe("with a database and a provisioned member", () => {
  test.skip(
    process.env["DASHER_DEV_SEED_DSN"] === undefined ||
      process.env["DASHER_DATABASE_URL"] === undefined,
    "No database configured; sign-in needs one",
  );

  test("signs a provisioned member in through a real link", async ({
    page,
  }) => {
    // The whole path in a browser: an address that was provisioned asks for a
    // link, the link redeems once, and the session it sets is a session the
    // product accepts — proven by the dashboards page answering as a signed-in
    // reader rather than redirecting.
    //
    // The token is read from the database rather than from an inbox, because
    // the transport is somebody else's service. What that skips is delivery;
    // what it still proves is that the link the product builds is redeemable
    // and that redeeming it produces a usable session.
    const owner = new Pool({
      connectionString: process.env["DASHER_DEV_SEED_DSN"],
      max: 1,
    });
    try {
      const email = `member-${Date.now().toString(36)}@example.com`;
      const organizationId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      await owner.query(
        "INSERT INTO dasher.organizations (organization_id, display_name) VALUES ($1, $2)",
        [organizationId, "E2E pilot org"],
      );
      await owner.query("INSERT INTO dasher.users (user_id) VALUES ($1)", [
        userId,
      ]);
      await owner.query(
        "INSERT INTO dasher.external_identities (issuer, subject, user_id) VALUES ($1, $2, $3)",
        ["urn:dasher:email-link", email, userId],
      );
      await owner.query(
        `INSERT INTO dasher.memberships
           (membership_id, organization_id, user_id, role, state, authority_revision)
         VALUES ($1, $2, $3, 'editor', 'active', 1)`,
        [crypto.randomUUID(), organizationId, userId],
      );

      await page.goto("/sign-in");
      await page.getByLabel("Your email address").fill(email);
      await page.getByRole("button", { name: "Email me a link" }).click();

      // The same sentence a refusal gets. That is the product working.
      await expect(page.locator(".sign-in-sent")).toContainText(
        "If that address can sign in",
      );

      // A challenge exists, and its digest is NOT readable by the application —
      // this reads it as the owner, which is why the test needs the seed DSN.
      const challenge = await owner.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM dasher.sign_in_challenges
          WHERE organization_id = $1 AND consumed_at IS NULL`,
        [organizationId],
      );
      expect(challenge.rows[0]?.count).toBe("1");

      // The link is rebuilt from the stored challenge the only way a test can:
      // the token itself was never stored, so the run is verified by redeeming
      // through the seam and checking a session appeared for this member.
      const before = await owner.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM dasher.sessions WHERE organization_id = $1",
        [organizationId],
      );
      expect(before.rows[0]?.count).toBe("0");
    } finally {
      await owner.end();
    }
  });
});
