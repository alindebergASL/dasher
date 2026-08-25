import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

/**
 * The slice, end to end: a file this repository does not contain becomes a
 * dashboard, and the file is still there afterwards.
 *
 * WHY THE CSV IS BUILT HERE RATHER THAN COMMITTED. Every ledger test before
 * this one reads `fixtures/ledger/operating-spend.csv.json` — six lines, six
 * months, USD, spend in the tens of thousands. A path that only ever sees that
 * file could be fitted to it without anyone noticing. So this one uploads
 * something with different budget lines, a different currency, a different
 * number of periods, a different period word, and figures of a different
 * magnitude, and asserts the dashboard reports THAT file's numbers.
 *
 * WHAT ONLY A BROWSER CAN SHOW. The bytes leaving a file input, arriving at a
 * server action as multipart, being decoded, parsed, planned, compiled, stored,
 * and cited by the version that renders — with a session cookie carrying the
 * tenancy through all of it. Each stage is proven on its own elsewhere; this is
 * the only place they are proven to join up.
 *
 * Skipped without a database, like the persistence suite beside it, because an
 * upload with nowhere to store the file is refused by design. CI's persistence
 * job configures one.
 */

const seedDsn = process.env["DASHER_DEV_SEED_DSN"] ?? "";

const persistenceConfigured =
  process.env["DASHER_DATABASE_URL"] !== undefined &&
  process.env["DASHER_DEV_SEED_DSN"] !== undefined;

/**
 * A quarterly ledger in pounds, with a trailing newline and CRLF endings —
 * which is what a spreadsheet writes, and which the reader had an off-by-one
 * on until a mutation survivor was traced.
 *
 * `licences` is deliberately unbudgeted: a blank budget cell must read as "not
 * compared" rather than as a budget of zero, and a zero there would put the
 * line over budget on any spend at all.
 */
const QUARTERLY_LEDGER = [
  "line_id,label,budget_per_period,2025-03,2025-06,2025-09,2025-12",
  "field-ops,Field operations,90000,81250,84900,88300,96400",
  "licences,Software licences,,12400,12400,13850,13850",
  'freight,"Freight, inbound",40000,38900,41200,39750,42600',
  "",
].join("\r\n");

/*
 * `Page` is imported statically above rather than named inline in this
 * signature. The generated-code gate is a text sweep that does not treat type
 * positions differently from value ones, so the inline form reads to it as a
 * dynamic import and fails the gate — which is how this comment came to exist.
 */
async function buildFromUpload(page: Page): Promise<void> {
  await page.goto("/");
  // Opened the way a reader opens it. The panel is a disclosure because the
  // upload path costs six controls and most readers will not take it.
  await page.getByText("Build one from your own ledger export").click();

  await page.getByLabel("Ledger export (CSV)").setInputFiles({
    name: "q4-operating-ledger.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(QUARTERLY_LEDGER, "utf8"),
  });
  await page
    .getByLabel("What should the dashboard show?")
    .fill("Operating spend by category");
  await page
    .getByLabel("What is this export called?")
    .fill("Finance quarterly export");
  await page.getByLabel("Currency").fill("GBP");
  await page.getByLabel("One column is a…").fill("quarter");
  await page.getByLabel("Exported on").fill("2026-01-15");
  await page.getByRole("button", { name: "Build from this file" }).click();
}

test.describe("a dashboard built from an uploaded ledger", () => {
  test.skip(
    !persistenceConfigured,
    "No database configured; an upload with nowhere to store the file is refused by design",
  );

  test("reports the uploaded file's own figures, in its own currency", async ({
    page,
  }) => {
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    expect(bootstrap.ok()).toBe(true);

    await buildFromUpload(page);

    const main = page.locator("main");

    // 96400 + 13850 + 42600 = 152850, in pounds because the reader said so.
    // Not a number that appears in the committed fixture, and not a currency
    // any other test in this repository uses.
    await expect(main).toContainText("£152,850");
    // The period word the reader declared, not "month" from somewhere else.
    await expect(main).toContainText("quarter");
    // The last period column in the file, which is what the ledger is "as of".
    await expect(main).toContainText("2025-12");
    // And nothing from the committed export leaked in.
    await expect(main).not.toContainText("£474,855");
    await expect(main).not.toContainText("Salaries");
  });

  test("keeps the uploaded bytes, and the version cites them", async ({
    page,
  }) => {
    // The decision this slice was built around: the file is kept because the
    // dashboard states figures and the file is what those figures came from.
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    const { organizationId } = (await bootstrap.json()) as {
      organizationId: string;
    };

    await buildFromUpload(page);
    const permalink = page.getByRole("link", {
      name: "Open this dashboard by link",
    });
    await expect(permalink).toBeVisible();

    const owner = new Pool({ connectionString: seedDsn, max: 1 });
    try {
      // Read as the owner, so row security cannot be what makes this pass.
      const stored = await owner.query<{
        canonical_bytes: Buffer;
        digest_matches: boolean;
        source_kind: string;
        source_ref: string;
        observed_at: Date;
      }>(
        `SELECT snapshot.canonical_bytes,
                snapshot.content_sha256 = sha256(snapshot.canonical_bytes)
                  AS digest_matches,
                snapshot.source_kind,
                snapshot.source_ref,
                snapshot.observed_at
           FROM dasher.dashboards AS dashboard
           JOIN dasher.dashboard_versions AS version
             ON version.organization_id = dashboard.organization_id
            AND version.version_id = dashboard.head_version_id
           JOIN dasher.source_snapshots AS snapshot
             ON snapshot.organization_id = version.organization_id
            AND snapshot.snapshot_id = version.source_snapshot_id
          WHERE dashboard.organization_id = $1`,
        [organizationId],
      );

      expect(stored.rows).toHaveLength(1);
      const row = stored.rows[0]!;
      // Byte for byte, CRLF endings and trailing newline included. Anything
      // normalised on the way in would be evidence of our reading of the file
      // rather than of the file.
      expect(row.canonical_bytes.toString("utf8")).toBe(QUARTERLY_LEDGER);
      expect(row.digest_matches).toBe(true);
      // Which reader was applied, and the client's claim about the name.
      expect(row.source_kind).toBe("csv-upload");
      expect(row.source_ref).toBe("q4-operating-ledger.csv");
      // The declared export date, NOT the upload time. The database stamps the
      // arrival itself in `retrieved_at`, so the row carries both facts.
      expect(row.observed_at.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    } finally {
      await owner.end();
    }
  });

  test("says its figures came from a file, not from an official source", async ({
    page,
  }) => {
    await page.context().request.post("/dev/bootstrap");
    await buildFromUpload(page);

    // An uploaded dashboard has no refinement path yet, and the sentence
    // explaining that is its own. It shipped as the official-snapshot wording
    // in review, which told a reader that the CSV on their own laptop was an
    // official source — the same mislabelling that made `combined-sources`
    // necessary in the first place.
    // The workspace shows two notes at this point — this one and the saved
    // link — so the first is named, and the absence is asserted across both.
    await expect(
      page.locator(".request-workspace > .request-note").first(),
    ).toContainText("built from a file you uploaded");
    await expect(page.locator(".request-workspace")).not.toContainText(
      "official snapshot",
    );
  });

  test("reopens from stored bytes with the uploaded figures intact", async ({
    page,
  }) => {
    await page.context().request.post("/dev/bootstrap");
    await buildFromUpload(page);

    const href = await page
      .getByRole("link", { name: "Open this dashboard by link" })
      .getAttribute("href");
    expect(href).toMatch(/^\/d\/[0-9a-f-]{36}$/u);

    await page.goto(href!);
    await expect(page.getByText("Saved snapshot")).toBeVisible();
    await expect(page.locator("main")).toContainText("£152,850");
  });

  test("refuses a file that is not a ledger, beside the form", async ({
    page,
  }) => {
    await page.context().request.post("/dev/bootstrap");
    await page.goto("/");
    await page.getByText("Build one from your own ledger export").click();

    await page.getByLabel("Ledger export (CSV)").setInputFiles({
      name: "invoices.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("invoice,amount\r\nINV-1,120\r\n", "utf8"),
    });
    await page.getByLabel("Exported on").fill("2026-01-15");
    await page.getByRole("button", { name: "Build from this file" }).click();

    // The sentence names the columns a ledger export needs, next to the file
    // input the reader has to change — not at the top of the page.
    await expect(page.locator(".upload-form p.request-error")).toContainText(
      "line_id, label and budget_per_period",
    );
  });

  test("stores nothing for a file it refused", async ({ page }) => {
    // Parse first, store second. A file that never became a dashboard leaves
    // no bytes behind, because storing it would be keeping evidence for
    // nothing.
    const bootstrap = await page.context().request.post("/dev/bootstrap");
    const { organizationId } = (await bootstrap.json()) as {
      organizationId: string;
    };

    await page.goto("/");
    await page.getByText("Build one from your own ledger export").click();
    await page.getByLabel("Ledger export (CSV)").setInputFiles({
      name: "invoices.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("invoice,amount\r\nINV-1,120\r\n", "utf8"),
    });
    await page.getByLabel("Exported on").fill("2026-01-15");
    await page.getByRole("button", { name: "Build from this file" }).click();
    await expect(page.locator(".upload-form p.request-error")).toBeVisible();

    const owner = new Pool({ connectionString: seedDsn, max: 1 });
    try {
      const rows = await owner.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM dasher.source_snapshots
          WHERE organization_id = $1`,
        [organizationId],
      );
      expect(Number(rows.rows[0]?.count)).toBe(0);
    } finally {
      await owner.end();
    }
  });
});
