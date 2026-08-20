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

  test("an air-quality dashboard saves and reopens through the same journey", async ({
    page,
  }) => {
    // The second domain, through the REAL flow — request box, server action,
    // repository, permalink, reload — not through the compiler tests that
    // already prove the pipeline. What only this can show is that the intake
    // router, the domain catalog, and persistence agree end to end.
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    expect(bootstrap.ok()).toBe(true);

    await page.goto("/");
    await page
      .getByRole("textbox", { name: "What do you want to monitor?" })
      .fill("Air quality across Sacramento");
    await page.getByRole("button", { name: "Build dashboard" }).click();

    await expect(
      page.getByRole("heading", { name: "Sacramento Air Quality" }),
    ).toBeVisible();

    const permalink = page.getByRole("link", {
      name: "Open this dashboard by link",
    });
    await expect(permalink).toBeVisible();
    const href = await permalink.getAttribute("href");
    expect(href).toMatch(/^\/d\/[0-9a-f-]{36}$/u);

    // Reload from stored bytes: still the air dashboard, in air vocabulary.
    await page.goto(href!);
    await expect(
      page.getByRole("heading", { name: "Sacramento Air Quality" }),
    ).toBeVisible();
    await expect(page.getByText("Monitor map")).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/gauge/iu);
  });

  test("the official UCR enrollment snapshot saves with honest provenance and reopens", async ({
    page,
  }) => {
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    expect(bootstrap.ok()).toBe(true);
    const { organizationId } = (await bootstrap.json()) as {
      organizationId: string;
    };

    await page.goto("/");
    await page
      .getByRole("textbox", { name: "What do you want to monitor?" })
      .fill("Current student enrollment at UC Riverside");
    await page.getByRole("button", { name: "Build dashboard" }).click();

    await expect(
      page.getByRole("heading", {
        name: "UC Riverside Enrollment — Fall 2025",
      }),
    ).toBeVisible();
    const permalink = page.getByRole("link", {
      name: "Open this dashboard by link",
    });
    await expect(permalink).toBeVisible();
    const href = await permalink.getAttribute("href");
    expect(href).toMatch(/^\/d\/[0-9a-f-]{36}$/u);

    const owner = new Pool({ connectionString: seedDsn, max: 1 });
    try {
      const provenance = await owner.query<{
        provider: string;
        model: string;
      }>(
        `SELECT run.provider, run.model
         FROM dasher.dashboards AS dashboard
         JOIN dasher.dashboard_versions AS version
           ON version.organization_id = dashboard.organization_id
          AND version.dashboard_id = dashboard.dashboard_id
          AND version.version_id = dashboard.head_version_id
         JOIN dasher.agent_runs AS run
           ON run.organization_id = version.organization_id
          AND run.run_id = version.run_id
         WHERE dashboard.organization_id = $1
           AND dashboard.title = 'UC Riverside Enrollment — Fall 2025'`,
        [organizationId],
      );
      expect(provenance.rows).toEqual([
        {
          provider: "ucr-institutional-research",
          model: "deterministic-enrollment-v1",
        },
      ]);
    } finally {
      await owner.end();
    }

    await page.goto(href!);
    await expect(
      page.getByRole("heading", {
        name: "UC Riverside Enrollment — Fall 2025",
      }),
    ).toBeVisible();
    await expect(page.getByText("27,633", { exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText(
      /gauge|monitor|station/iu,
    );
  });

  test("the listing finds saved dashboards again without their permalinks", async ({
    page,
  }) => {
    // The browse journey, end to end: build one dashboard per domain, walk to
    // the listing with no link retained, and reopen both from it. This is the
    // slice's whole question — can an organization get back to what it built.
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    expect(bootstrap.ok()).toBe(true);

    const requestBox = () =>
      page.getByRole("textbox", { name: "What do you want to monitor?" });

    await page.goto("/");
    await requestBox().fill("Show me river conditions near Sacramento");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(
      page.getByRole("link", { name: "Open this dashboard by link" }),
    ).toBeVisible();

    await requestBox().fill("Air quality across Sacramento");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(
      page.getByRole("link", { name: "Open this dashboard by link" }),
    ).toBeVisible();

    // The walk a reader would take: the standing link, not a typed URL.
    await page.getByRole("link", { name: "Your dashboards" }).click();
    await expect(
      page.getByRole("heading", { name: "Your dashboards" }),
    ).toBeVisible();

    const items = page.locator(".dashboard-list-item");
    await expect(items).toHaveCount(2);
    // Newest first: the air dashboard was saved second.
    await expect(items.nth(0)).toContainText("Sacramento Air Quality");
    await expect(items.nth(1)).toContainText("Sacramento River Conditions");

    // Reopen each from the listing alone.
    await items.nth(0).getByRole("link").first().click();
    await expect(
      page.getByRole("heading", { name: "Sacramento Air Quality" }),
    ).toBeVisible();

    await page.goto("/dashboards");
    await items.nth(1).getByRole("link").first().click();
    await expect(
      page.getByRole("heading", { name: "Sacramento River Conditions" }),
    ).toBeVisible();
  });

  test("a combined dashboard saves once, lists once, and reopens whole", async ({
    page,
  }) => {
    // The slice's question, end to end: one request naming two sources
    // produces ONE persisted dashboard, findable by browsing rather than by a
    // link the reader kept, and reopening it shows both halves.
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    expect(bootstrap.ok()).toBe(true);
    const { organizationId } = (await bootstrap.json()) as {
      organizationId: string;
    };

    await page.goto("/");
    await page
      .getByRole("textbox", { name: "What do you want to monitor?" })
      .fill("Compare river conditions and air quality near Sacramento");
    await page.getByRole("button", { name: "Build dashboard" }).click();

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "River and Air quality — combined conditions",
    );
    const permalink = page.getByRole("link", {
      name: "Open this dashboard by link",
    });
    await expect(permalink).toBeVisible();
    const href = await permalink.getAttribute("href");
    expect(href).toMatch(/^\/d\/[0-9a-f-]{36}$/u);

    // ONE row, not one per source. Counted as the owner so row security is not
    // what makes the number right.
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

    // Found by browsing, with no link retained.
    await page.getByRole("link", { name: "Your dashboards" }).click();
    const items = page.locator(".dashboard-list-item");
    await expect(items).toHaveCount(1);
    await expect(items.nth(0)).toContainText(
      "River and Air quality — combined conditions",
    );

    await items.nth(0).getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "River and Air quality — combined conditions",
    );

    // Both halves survived the round trip through stored bytes.
    const pageNav = page.locator(".sidebar, .page-nav").first();
    await expect(
      pageNav.getByRole("button", { name: /01\s+River — Overview/ }),
    ).toBeVisible();
    await expect(
      pageNav.getByRole("button", { name: /03\s+Air quality — Overview/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Gauge map" }),
    ).toBeVisible();
    await pageNav
      .getByRole("button", { name: /03\s+Air quality — Overview/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "Monitor map" }),
    ).toBeVisible();
  });

  test("the listing is empty for an organization that has saved nothing", async ({
    page,
  }) => {
    // A fresh bootstrap is a different organization. Row-level security is
    // the entire isolation mechanism on this page, and this is it working:
    // the previous test's two dashboards exist and are invisible here.
    await page.context().request.post("/dev/bootstrap");
    await page.goto("/dashboards");

    await expect(
      page.getByRole("heading", { name: "Your dashboards" }),
    ).toBeVisible();
    await expect(page.locator(".dashboard-list-item")).toHaveCount(0);
    await expect(page.getByText("Nothing saved yet")).toBeVisible();
  });

  test("refused requests persist nothing", async ({ page }) => {
    // Fail closed, all the way down: a request the router cannot place — or
    // places in two domains that cannot be combined — must not leave a row
    // behind. Counted as the owner, so row security cannot be what makes this
    // zero.
    //
    // The OTHER way a combined request is refused — one upstream source being
    // unavailable — is deliberately not tested here. This suite runs with
    // `DASHER_SOURCE_MODE: fixture`, so no request ever leaves the process and
    // blocking a host at the browser would assert nothing while looking like
    // it asserted something. That refusal is proven where it can actually be
    // provoked: `actions.test.ts` takes exactly one domain offline at the
    // source seam and checks the refusal names that domain AND NOT the other.
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    const { organizationId } = (await bootstrap.json()) as {
      organizationId: string;
    };

    await page.goto("/");
    const requestBox = page.getByRole("textbox", {
      name: "What do you want to monitor?",
    });

    await requestBox.fill("stock prices for tomorrow");
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(page.locator("p.request-error")).toContainText(
      "river conditions, air quality, and UC Riverside enrollment",
    );

    // River + air is a supported pair now; river + enrollment still is not.
    await requestBox.fill(
      "compare river conditions and UC Riverside enrollment",
    );
    await page.getByRole("button", { name: "Build dashboard" }).click();
    await expect(page.locator("p.request-error")).toContainText(
      "one dashboard at a time",
    );

    const owner = new Pool({ connectionString: seedDsn, max: 1 });
    try {
      const rows = await owner.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM dasher.dashboards WHERE organization_id = $1",
        [organizationId],
      );
      expect(Number(rows.rows[0]?.count)).toBe(0);
    } finally {
      await owner.end();
    }
  });
});
