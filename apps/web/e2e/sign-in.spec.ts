import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";

import { Pool } from "pg";

/** Sign-in in a browser: the page, the link round trip, and CSRF refusals. */

async function openSignIn(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await expect(page.locator("#sign-in-email")).toBeVisible();
}

test("is reachable from the site navigation", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Site" })
    .getByRole("link", { name: "Sign in" })
    .click();
  await expect(page).toHaveURL(/\/sign-in$/u);
  await openSignIn(page);
});

test("a link that was never issued lands back on sign-in, saying so", async ({
  page,
}) => {
  // Every failure is this failure: expired, already used, revoked since it was
  // sent, never issued, malformed. Distinguishing them would tell whoever holds
  // the link things the person who lost it already knows.
  //
  // And the failure is only reached after CONFIRMING: opening the link shows a
  // button, it does not redeem. Note this page says nothing about whether the
  // token is real — validating before the click would answer "is this a live
  // token?" more cheaply than redeeming it.
  await page.goto("/sign-in/verify?token=not-a-real-token");
  await expect(page.locator("main")).toContainText("Sign in to Dasher");

  await page.getByRole("button", { name: "Sign me in" }).click();

  await expect(page).toHaveURL(/\/sign-in\?failed=1$/u);
  await expect(page.locator("main")).toContainText("That link did not work");
});

test("opening a link does not sign anyone in until they confirm", async ({
  page,
}) => {
  // The login-CSRF property, and the reason the redemption moved to a POST.
  //
  // A GET that mints a session lets an attacker put their OWN link where a
  // victim will follow it — a message, or a redirect from any page the victim
  // visits — and the victim's browser silently stores a session for the
  // attacker's organization. The same GET also let mail scanners and
  // link-preview bots spend a single-use link before the recipient clicked it.
  //
  // Asserted without a database, because the property is that GET performs no
  // state change at all, whatever the token is.
  await page.goto("/sign-in/verify?token=whatever");

  // No session cookie was set by merely opening the link.
  const cookies = await page.context().cookies();
  expect(
    cookies.some((cookie) => cookie.name === "__Host-dasher_session"),
  ).toBe(false);

  // And the page that redeems is a form posting elsewhere, not this URL.
  await expect(page.locator("form")).toHaveAttribute("method", /post/iu);
  await expect(page.locator("form")).toHaveAttribute(
    "action",
    "/sign-in/confirm",
  );
});

test("refuses a redemption submitted from another site", async ({ page }) => {
  // LOGIN CSRF, and the reason POST-only was not enough.
  //
  // A cross-site auto-submitting form is a top-level navigation, so moving the
  // token from the URL to a body changed nothing an attacker cannot control:
  // they hand out a page instead of a link. Reproduced against the built app
  // before this check existed — 303 with a `__Host-` session cookie set — and
  // `SameSite=lax` does not help, because it governs whether a cookie is SENT,
  // not whether one may be stored, and the redirect lands same-site.
  //
  // A real token is not needed: the origin is checked before the body is read,
  // so a cross-site caller gets the same refusal whatever it carries.
  const attacked = await page.context().request.post("/sign-in/confirm", {
    headers: {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
      "content-type": "application/x-www-form-urlencoded",
    },
    data: "token=anything",
    maxRedirects: 0,
  });

  expect(attacked.status()).toBe(303);
  expect(attacked.headers()["location"]).toContain("/sign-in?failed=1");
  expect(attacked.headers()["set-cookie"]).toBeUndefined();
});

test("refuses a redemption whose origin is null", async ({ page }) => {
  // The shape a `no-referrer` page produces. It is not evidence of a same-site
  // request and must not be treated as one — and getting this wrong in the
  // other direction is what the confirm page's `referrer: origin` exists for:
  // under `no-referrer` a browser sends `Origin: null` even SAME-ORIGIN, so an
  // origin check that accepted null would be no check, and one that rejected
  // null without changing the policy would have broken the real flow.
  const nulled = await page.context().request.post("/sign-in/confirm", {
    headers: {
      origin: "null",
      "content-type": "application/x-www-form-urlencoded",
    },
    data: "token=anything",
    maxRedirects: 0,
  });

  expect(nulled.status()).toBe(303);
  expect(nulled.headers()["location"]).toContain("/sign-in?failed=1");
  expect(nulled.headers()["set-cookie"]).toBeUndefined();
});

test("the confirm route refuses a GET", async ({ page }) => {
  // Belt and braces on the same property: if the redemption endpoint answered
  // GET, moving it would have bought nothing.
  const answered = await page.context().request.get("/sign-in/confirm", {
    maxRedirects: 0,
  });
  expect(answered.status()).toBe(405);
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
    // THE WHOLE PATH, and it really does redeem. The first version of this test
    // asserted `sessions == 0` and stopped there while its comments said it had
    // signed in — so a regression in `redeem_sign_in`, `redeemSignIn` or
    // `/sign-in/verify` would have passed it green, precisely BECAUSE nothing
    // was redeemed. An adversarial review found that; it is the reason this
    // comment is longer than the assertion it explains.
    //
    // The token cannot be read back from a challenge the product created: only
    // its digest is stored, which is the point of the design. So the test mints
    // its own token, asks the product's own seam to raise a challenge for that
    // digest, and follows the resulting link through the browser as a person
    // would. Everything after `begin_sign_in` is the product's code.
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

      // The form first: the sentence it shows is part of the contract, being
      // the same one an address it will not mail receives.
      await page.goto("/sign-in");
      await page.getByLabel("Your email address").fill(email);
      await page.getByRole("button", { name: "Email me a link" }).click();
      await expect(page.locator(".sign-in-sent")).toContainText(
        "If that address can sign in",
      );

      const raised = await owner.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM dasher.sign_in_challenges
          WHERE organization_id = $1 AND consumed_at IS NULL`,
        [organizationId],
      );
      expect(raised.rows[0]?.count).toBe("1");

      const token = randomBytes(32);
      const created = await owner.query<{ challenge_id: string | null }>(
        `SELECT dasher_api.begin_sign_in(
           $1, 1::smallint, $2, now() + interval '15 minutes', $3, 'e2e'
         ) AS challenge_id`,
        [
          email,
          createHash("sha256").update(token).digest(),
          crypto.randomUUID(),
        ],
      );
      expect(created.rows[0]?.challenge_id).not.toBeNull();

      await page.goto(`/sign-in/verify?token=${token.toString("base64url")}`);
      await page.getByRole("button", { name: "Sign me in" }).click();

      // Redeemed: the home page, not back on /sign-in?failed=1.
      await expect(page).toHaveURL(/\/$/u);

      // A session exists where a moment ago there was none.
      const sessions = await owner.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM dasher.sessions WHERE organization_id = $1",
        [organizationId],
      );
      expect(sessions.rows[0]?.count).toBe("1");

      // And it is a session the PRODUCT accepts, not merely a row.
      await page.goto("/dashboards");
      await expect(page.locator("main")).not.toContainText(
        "You are not signed in",
      );
      await expect(
        page
          .getByRole("navigation", { name: "Site" })
          .getByRole("button", { name: "Sign out" }),
      ).toBeVisible();

      // Spent. Confirming it again lands on the failure page.
      await page.goto(`/sign-in/verify?token=${token.toString("base64url")}`);
      await page.getByRole("button", { name: "Sign me in" }).click();
      await expect(page).toHaveURL(/\/sign-in\?failed=1$/u);
    } finally {
      await owner.end();
    }
  });
});

test("refuses a sign-out submitted from another site", async ({ page }) => {
  // LOGOUT CSRF. `isSameOrigin` was written for `/sign-in/confirm` and not
  // applied here in the same commit, so one state-changing POST was guarded and
  // the other was not. Reproduced with a real browser: a cross-site form
  // cleared the victim's cookie and signed them out — and because `SameSite=lax`
  // withholds the cookie on that request, nothing was revoked server-side, so
  // the reader was locked out while their session stayed live.
  //
  // Asserted on the response rather than on a session, because the defect is
  // the unconditional `Set-Cookie`: no cookie header on the reply means no
  // browser was logged out.
  const attacked = await page.context().request.post("/sign-out", {
    headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    maxRedirects: 0,
  });

  expect(attacked.status()).toBe(303);
  expect(attacked.headers()["set-cookie"]).toBeUndefined();
});

test.describe("signing out", () => {
  test.skip(
    process.env["DASHER_DATABASE_URL"] === undefined ||
      process.env["DASHER_DEV_BOOTSTRAP"] !== "1",
    "Needs a database and a way to obtain a session",
  );

  test("ends the session and puts the reader back where they started", async ({
    page,
  }) => {
    // The session comes from the development bootstrap rather than from a
    // link, because the token in a link is never stored and cannot be read
    // back. What is under test here is revocation, and a session is a session:
    // the bootstrap writes one through the same seam sign-in does.
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    expect(bootstrap.ok()).toBe(true);

    await page.goto("/dashboards");
    await expect(page.locator("main")).not.toContainText(
      "You are not signed in",
    );
    const nav = page.getByRole("navigation", { name: "Site" });
    await expect(nav.getByRole("button", { name: "Sign out" })).toBeVisible();

    await nav.getByRole("button", { name: "Sign out" }).click();

    // Back on the home page, and the header agrees with the pages.
    await expect(page).toHaveURL(/\/$/u);
    await expect(
      page.getByRole("navigation", { name: "Site" }).getByRole("link", {
        name: "Sign in",
      }),
    ).toBeVisible();

    // And the protected page has genuinely reverted, rather than the header
    // merely changing.
    await page.goto("/dashboards");
    await expect(page.locator("main")).toContainText("You are not signed in");
  });

  test("does not sign anyone out through a GET", async ({ page }) => {
    // `<img src="/sign-out">` on any page would otherwise sign out every reader
    // who loaded it. The route answers 405 and the session survives.
    await page.context().request.post("/dev/bootstrap");

    const attempted = await page.context().request.get("/sign-out", {
      maxRedirects: 0,
    });
    expect(attempted.status()).toBe(405);

    await page.goto("/dashboards");
    await expect(page.locator("main")).not.toContainText(
      "You are not signed in",
    );
  });
});
