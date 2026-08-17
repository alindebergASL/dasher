import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  bootstrapManagedRoles,
  parsePostgresIntegrationEnv,
  runMigrations,
} from "../src/index";
import { renderSchemaSnapshot } from "../src/schema-snapshot";
import {
  baselineMigrationDirectory,
  borrowedClientPool,
  ignoreTeardownShutdown,
} from "./postgres-harness";

/**
 * Proves the committed schema snapshot is what the migrations actually
 * produce, by applying them to a fresh database and rendering the result.
 *
 * Run with UPDATE_SCHEMA_SNAPSHOT=1 to regenerate after an intentional schema
 * change; review the resulting diff, which reads as the change itself.
 */

const config = parsePostgresIntegrationEnv(process.env);
const snapshotPath = fileURLToPath(
  new URL("../schema.snapshot.txt", import.meta.url),
);
const databaseName = `dasher_snapshot_${Date.now().toString(36)}`;

let adminPool: Pool;
let targetPool: Pool;

beforeAll(async () => {
  adminPool = new Pool({ connectionString: config.ownerDsn, max: 2 });
  ignoreTeardownShutdown(adminPool);
  await adminPool.query(`CREATE DATABASE ${databaseName}`);

  const target = new URL(config.ownerDsn);
  target.pathname = `/${databaseName}`;
  targetPool = new Pool({ connectionString: target.toString(), max: 2 });
  ignoreTeardownShutdown(targetPool);

  const client = await targetPool.connect();
  try {
    await bootstrapManagedRoles(client, []);
    await runMigrations(
      borrowedClientPool(client),
      baselineMigrationDirectory,
      [],
    );
  } finally {
    client.release();
  }
}, 120_000);

afterAll(async () => {
  await targetPool?.end();
  if (adminPool !== undefined) {
    await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await adminPool.end();
  }
});

it("the committed schema snapshot matches a freshly migrated database", async () => {
  const client = await targetPool.connect();
  let rendered: string;
  try {
    rendered = await renderSchemaSnapshot(client);
  } finally {
    client.release();
  }

  if (process.env.UPDATE_SCHEMA_SNAPSHOT === "1") {
    await writeFile(snapshotPath, rendered, "utf8");
  }

  const committed = await readFile(snapshotPath, "utf8");
  expect(rendered).toBe(committed);
});

it("the snapshot records that the application role cannot bypass row security", async () => {
  const committed = await readFile(snapshotPath, "utf8");

  expect(committed).toContain(
    "dasher_app superuser=false bypassrls=false login=false",
  );
});

it("the snapshot records row security enabled and unforced on every tenant table", async () => {
  const committed = await readFile(snapshotPath, "utf8");

  // Scoped to `dasher`. Tables in `dasher_private` hold no tenant rows and are
  // unreachable from the application role.
  //
  // Enabled confines the application role, which is not the owner. Unforced
  // keeps the SECURITY DEFINER seam working, because FORCE applies a table's
  // policies to its owner and every seam function runs as that owner — so a
  // forced table denies the seam the writes it exists to perform, unless the
  // owner is superuser or BYPASSRLS. The migrator refuses a schema that forces
  // it; this asserts the committed snapshot agrees.
  const tenantRowSecurity = committed
    .split("\n")
    .filter((line) => line.includes(" rls=") && line.startsWith("dasher."));

  expect(tenantRowSecurity.length).toBeGreaterThan(0);
  expect(
    tenantRowSecurity.filter((line) => !line.endsWith("rls=true force=false")),
  ).toEqual([]);
});

it("the private key table is unreachable rather than policy-protected", async () => {
  const committed = await readFile(snapshotPath, "utf8");

  // The context key is what makes a forged request context detectable, so its
  // protection is that no role but the owner can reach it at all. If a grant
  // ever appears here, the whole construction is void.
  const grants = committed
    .split("\n")
    .filter((line) => line.includes("dasher_private.context_keys"))
    .filter((line) => line.includes("grant"));

  expect(grants).toEqual([]);
});

it("orders every section by bytes, so the render does not depend on the server collation", async () => {
  // This is the property that broke CI: `ORDER BY` without an explicit
  // collation sorts under the server's locale, and en_US.UTF-8 ignores `_` at
  // the primary level while byte order does not. Asserting byte order here
  // catches a regression on any machine, without needing a second locale
  // installed to reproduce it.
  const committed = await readFile(snapshotPath, "utf8");

  const sections = committed.split("\n\n");
  expect(sections.length).toBeGreaterThan(1);

  for (const block of sections) {
    const body = block
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("-- "));
    const byteSorted = [...body].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    expect(body).toEqual(byteSorted);
  }
});

it("every callable entry point is execute-restricted, never PUBLIC", async () => {
  const committed = await readFile(snapshotPath, "utf8");

  // `dasher_api` holds the callable surface and no tables at all, so before the
  // routine sections existed it was invisible to this gate entirely: a
  // SECURITY DEFINER entry point could have been granted to PUBLIC — an
  // unauthenticated write path — with the snapshot still matching.
  //
  // A null `proacl` renders as the PostgreSQL default, which is EXECUTE to
  // PUBLIC. That is the string this asserts against, because the dangerous case
  // is a routine nobody ever granted rather than one granted wrongly.
  const routineGrants = committed
    .split("\n")
    .filter((line) => line.startsWith("dasher_api."));

  expect(routineGrants.length).toBeGreaterThan(0);
  expect(
    routineGrants.filter((line) => line.includes("EXECUTE to PUBLIC")),
  ).toEqual([]);
});

it("records the evidence seam's exact signature, definer flag, and search path", async () => {
  const committed = await readFile(snapshotPath, "utf8");

  // `record_evidence` gained two arguments in this branch. Without the routine
  // sections, that signature change — and the SECURITY DEFINER and search_path
  // that make it safe — passed the schema gate without being looked at.
  const signature = committed
    .split("\n")
    .find(
      (line) =>
        line.startsWith("dasher_api.record_evidence(") && line.includes("->"),
    );

  expect(signature).toBeDefined();
  expect(signature).toContain("p_request_id uuid");
  expect(signature).toContain("p_deployment_revision text");
  expect(signature).toContain("security_definer=true");
  expect(signature).toContain("search_path=pg_catalog");
});
