import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  bootstrapManagedRoles,
  parsePostgresIntegrationEnv,
  runMigrations,
} from "../src/index.js";
import { renderSchemaSnapshot } from "../src/schema-snapshot.js";
import {
  baselineMigrationDirectory,
  borrowedClientPool,
} from "./postgres-harness.js";

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
  await adminPool.query(`CREATE DATABASE ${databaseName}`);

  const target = new URL(config.ownerDsn);
  target.pathname = `/${databaseName}`;
  targetPool = new Pool({ connectionString: target.toString(), max: 2 });

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

it("the snapshot records forced row security on every tenant table but memberships", async () => {
  const committed = await readFile(snapshotPath, "utf8");

  // Scoped to `dasher`. Tables in `dasher_private` hold no tenant rows, are
  // unreachable from the application role, and are read by SECURITY DEFINER
  // functions running as the owner — which FORCE would itself block, since a
  // forced table applies its policies to the owner too.
  const tenantRowSecurity = committed
    .split("\n")
    .filter((line) => line.includes(" rls=") && line.startsWith("dasher."));

  const unforced = tenantRowSecurity.filter(
    (line) => !line.endsWith("rls=true force=true"),
  );

  expect(unforced).toEqual(["dasher.memberships rls=true force=false"]);
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
