import { expect, test } from "@playwright/test";
import { Pool } from "pg";

/**
 * The slice: a generated dashboard survives a reload.
 *
 * Everything below this test is already proven without a browser — the
 * repository's integration tests save in one transaction and read in another,
 * which is what a reload is at the data layer. What only a browser can show is
 * that the product actually joins those pieces: a session cookie issued by the
 * bootstrap, carried by the browser, read by a server action, and honoured by a
 * route that renders bytes nobody recompiled.
 *
 * It is skipped when no database is configured, and that is deliberate rather
 * than convenient: the fixture demo is a supported way to run this app, so the
 * suite must pass without PostgreSQL. CI's e2e job sets `DASHER_DATABASE_URL`,
 * so the skip is a local affordance and not a hole in the gate.
 */

// The owner connection, so a database assertion cannot be satisfied by row
// security hiding rows that do exist.
const seedDsn = process.env["DASHER_DEV_SEED_DSN"] ?? "";

const persistenceConfigured =
  process.env["DASHER_DATABASE_URL"] !== undefined &&
  process.env["DASHER_DEV_SEED_DSN"] !== undefined;

test.describe("a saved dashboard", () => {
  test.skip(
    !persistenceConfigured,
    "No database configured; running in fixture-only mode",
  );

  test("survives a reload at its own URL", async ({ page }) => {
    // The development stand-in for sign-in. It sets the same cookie real
    // sign-in will, through the same seam, so nothing downstream knows the
    // difference.
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    expect(bootstrap.ok()).toBe(true);

    await page.goto("/");
    await page
      .getByRole("textbox", { name: "What do you want to monitor?" })
      .fill("Show me river conditions near Sacramento");
    await page.getByRole("button", { name: "Build dashboard" }).click();

    const permalink = page.getByRole("link", {
      name: "Open this dashboard by link",
    });
    await expect(permalink).toBeVisible();

    const href = await permalink.getAttribute("href");
    expect(href).toMatch(/^\/d\/[0-9a-f-]{36}$/u);

    // The reload. A fresh navigation to the id, with no client state carried
    // over — if the spec were being recomposed rather than read, this is where
    // it would differ.
    await page.goto(href!);
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();

    // And again, to make the point that it is durable rather than cached in
    // whatever produced it the first time.
    await page.reload();
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
  });

  test("does not serve another session's dashboard", async ({ page }) => {
    await page.context().request.post("/dev/bootstrap");
    await page.goto("/");
    await page
      .getByRole("textbox", { name: "What do you want to monitor?" })
      .fill("Show me river conditions near Sacramento");
    await page.getByRole("button", { name: "Build dashboard" }).click();

    const href = await page
      .getByRole("link", { name: "Open this dashboard by link" })
      .getAttribute("href");
    expect(href).not.toBeNull();

    // A second bootstrap is a different organization, because the seed creates
    // one per call. The first dashboard must be invisible to it — the tenant
    // boundary, reached the way a real user would reach it.
    await page.context().request.post("/dev/bootstrap");
    const response = await page.goto(href!);
    expect(response?.status()).toBe(404);
  });

  test.describe("the 404 contract holds for every failure", () => {
    // Documented before it was true. Probing found two ways to get a 500 —
    // both distinguishable from a real miss, which is the discrimination the
    // contract promised nobody could make.
    test("an id that is not a UUID is a miss, not a server error", async ({
      page,
    }) => {
      await page.context().request.post("/dev/bootstrap");

      // Reached PostgreSQL and came back 22P02 before the id was checked first.
      const response = await page.goto("/d/not-a-uuid");
      expect(response?.status()).toBe(404);
    });

    test("a well-formed but unissued token is a miss, not a server error", async ({
      request,
    }) => {
      // Sent as a header rather than planted with `addCookies`: the `__Host-`
      // prefix forbids a Domain attribute, and Playwright's cookie API always
      // sets one, so the browser refuses it. What is under test is the server's
      // answer to a credential it never issued, and a raw request asks that
      // question directly.
      const response = await request.get(
        "/d/00000000-0000-4000-8000-000000000000",
        {
          headers: {
            cookie: `__Host-dasher_session=${Buffer.alloc(32, 7).toString("base64url")}`,
          },
          failOnStatusCode: false,
        },
      );

      // `RequestContextError: denied` escaped as a 500 before this, telling the
      // holder of a forged token that their token was the problem rather than
      // the dashboard.
      expect(response.status()).toBe(404);
    });
  });

  test("does not persist the dashboard nobody asked for", async ({ page }) => {
    // `/` renders a default dashboard on every visit. Once the page became
    // dynamic that meant a row per authenticated load, unreachable because the
    // default render threads no id into the workspace.
    //
    // ASSERTED AGAINST THE DATABASE, not against the absence of a permalink.
    // The first version of this test only checked that no link appeared, and
    // would have passed against the unfixed code for the wrong reason: that
    // code persisted the dashboard and then never showed its id either. The
    // rows are the property; the missing link was only ever a symptom.
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    expect(bootstrap.ok()).toBe(true);
    const { organizationId } = (await bootstrap.json()) as {
      organizationId: string;
    };

    await page.goto("/");
    await page.goto("/");
    await page.goto("/");

    const owner = new Pool({ connectionString: seedDsn, max: 1 });
    try {
      // As the owner, so row-level security cannot be what makes this zero.
      const rows = await owner.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM dasher.dashboards WHERE organization_id = $1",
        [organizationId],
      );
      expect(Number(rows.rows[0]?.count)).toBe(0);
    } finally {
      await owner.end();
    }

    // And the symptom, kept because it is what a reader would notice.
    await expect(
      page.getByRole("link", { name: "Open this dashboard by link" }),
    ).toHaveCount(0);
  });
  test("but does persist one the reader actually asked for", async ({
    page,
  }) => {
    // The counterweight. Without it, "zero rows after visiting /" would pass
    // just as well against an app that had stopped persisting entirely.
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    const { organizationId } = (await bootstrap.json()) as {
      organizationId: string;
    };

    await page.goto("/");
    await page
      .getByRole("textbox", { name: "What do you want to monitor?" })
      .fill("Show me river conditions near Sacramento");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(
      page.getByRole("link", { name: "Open this dashboard by link" }),
    ).toBeVisible();

    const owner = new Pool({ connectionString: seedDsn, max: 1 });
    try {
      const rows = await owner.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM dasher.dashboards WHERE organization_id = $1",
        [organizationId],
      );
      expect(Number(rows.rows[0]?.count)).toBe(1);
    } finally {
      await owner.end();
    }
  });
});
