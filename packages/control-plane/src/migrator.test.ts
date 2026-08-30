import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  MigrationContractError,
  discoverMigrations,
  runMigrations,
  type MigrationClient,
  type MigrationPool,
} from "./migrator";

const fixtureMigrationDirectory = fileURLToPath(
  new URL("../test/fixtures/migrations", import.meta.url),
);
const driftMigrationDirectory = fileURLToPath(
  new URL("../test/fixtures/migrations-checksum-drift", import.meta.url),
);
const baselineMigrationDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function makeDirectory(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dasher-migrations-"));
  temporaryDirectories.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents, "utf8");
  }
  return directory;
}

async function expectRejection(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(operation).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof MigrationContractError && error.code === code,
  );
}

interface RecordedQuery {
  readonly sql: string;
  readonly values?: readonly unknown[];
}

interface FakeDatabaseOptions {
  readonly journalPresent?: boolean;
  readonly journalRows?: readonly {
    readonly sequence: number;
    readonly filename: string;
    readonly checksum_sha256: Uint8Array;
  }[];
  readonly isDatabaseOwner?: boolean;
  readonly failOnSqlContaining?: string;
}

function createFakePool(options: FakeDatabaseOptions = {}): {
  readonly pool: MigrationPool;
  readonly queries: RecordedQuery[];
  readonly released: () => number;
} {
  const queries: RecordedQuery[] = [];
  let releaseCount = 0;

  const client: MigrationClient = {
    query: (async (sql: string, values?: readonly unknown[]) => {
      queries.push({ sql, values });

      if (
        options.failOnSqlContaining !== undefined &&
        sql.includes(options.failOnSqlContaining)
      ) {
        throw new Error("migration failed");
      }
      if (sql.includes("datdba")) {
        return { rows: [{ is_owner: options.isDatabaseOwner ?? true }] };
      }
      if (sql.includes("schema_migrations'")) {
        return { rows: [{ present: options.journalPresent ?? false }] };
      }
      if (sql.includes("FROM dasher_meta.schema_migrations")) {
        return { rows: options.journalRows ?? [] };
      }
      return { rows: [] };
    }) as MigrationClient["query"],
    release: () => {
      releaseCount += 1;
    },
  };

  return {
    pool: { connect: async () => client },
    queries,
    released: () => releaseCount,
  };
}

function sha256(contents: string): Uint8Array {
  return createHash("sha256").update(Buffer.from(contents, "utf8")).digest();
}

describe("discoverMigrations", () => {
  it("reads a contiguous series and checksums it from file bytes", async () => {
    const migrations = await discoverMigrations(fixtureMigrationDirectory);

    expect(migrations.map((migration) => migration.filename)).toEqual([
      "0001_fixture_base.sql",
      "0002_fixture_extension.sql",
    ]);
    expect(migrations.map((migration) => migration.sequence)).toEqual([1, 2]);
    for (const migration of migrations) {
      expect(migration.checksumSha256).toEqual(
        createHash("sha256").update(migration.bytes).digest(),
      );
    }
  });

  it("checksums differ when a migration's bytes differ", async () => {
    const [base] = await discoverMigrations(fixtureMigrationDirectory);
    const [drifted] = await discoverMigrations(driftMigrationDirectory);

    expect(base).toBeDefined();
    expect(drifted).toBeDefined();
    expect(base?.filename).toEqual(drifted?.filename);
    expect(base?.checksumSha256).not.toEqual(drifted?.checksumSha256);
  });

  it("reads the real migration series", async () => {
    const migrations = await discoverMigrations(baselineMigrationDirectory);

    // Named in order rather than counted, so adding a migration is a
    // deliberate edit here and a renamed or reordered one is a failure rather
    // than a number that still adds up.
    expect(migrations.map((migration) => migration.filename)).toEqual([
      "0001_baseline.sql",
      "0002_sign_in.sql",
      "0003_session_revocation.sql",
      "0004_sign_in_rate_limit_lock.sql",
    ]);
    expect(migrations[0]?.sql).toContain("CREATE TABLE dasher.dashboards");
    expect(migrations[1]?.sql).toContain(
      "CREATE TABLE dasher.sign_in_challenges",
    );
    expect(migrations[2]?.sql).toContain(
      "CREATE FUNCTION dasher_api.revoke_session",
    );
    expect(migrations[3]?.sql).toContain("pg_catalog.pg_advisory_xact_lock");
  });

  it("rejects an empty directory", async () => {
    await expectRejection(
      discoverMigrations(await makeDirectory({})),
      "empty_series",
    );
  });

  it("rejects a filename outside NNNN_lower_snake.sql", async () => {
    await expectRejection(
      discoverMigrations(await makeDirectory({ "0001-Base.SQL": "SELECT 1;" })),
      "malformed_filename",
    );
  });

  it("rejects a gap in the sequence", async () => {
    await expectRejection(
      discoverMigrations(
        await makeDirectory({
          "0001_base.sql": "SELECT 1;",
          "0003_later.sql": "SELECT 1;",
        }),
      ),
      "non_contiguous_sequence",
    );
  });

  it("rejects a series that does not start at 0001", async () => {
    await expectRejection(
      discoverMigrations(await makeDirectory({ "0002_base.sql": "SELECT 1;" })),
      "non_contiguous_sequence",
    );
  });

  it("rejects invalid UTF-8", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dasher-migrations-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "0001_base.sql"),
      Buffer.from([0x53, 0x45, 0xff, 0xfe]),
    );

    await expectRejection(discoverMigrations(directory), "invalid_utf8");
  });

  it("refuses to follow a symlink into the series", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dasher-migrations-"));
    const target = await mkdtemp(join(tmpdir(), "dasher-target-"));
    temporaryDirectories.push(directory, target);
    const outside = join(target, "outside.sql");
    await writeFile(outside, "SELECT 1;", "utf8");
    await symlink(outside, join(directory, "0001_base.sql"));

    await expectRejection(discoverMigrations(directory), "non_regular_file");
  });
});

describe("runMigrations", () => {
  it("creates the journal, applies the series, and records each file", async () => {
    const { pool, queries } = createFakePool();

    const result = await runMigrations(pool, fixtureMigrationDirectory, [
      "dasher_app_web",
    ]);

    expect(result).toEqual({
      discoveredCount: 2,
      previouslyAppliedCount: 0,
      appliedCount: 2,
    });
    expect(
      queries.some((query) =>
        query.sql.includes("CREATE TABLE dasher_meta.schema_migrations"),
      ),
    ).toBe(true);

    const inserts = queries.filter((query) =>
      query.sql.includes("INSERT INTO dasher_meta.schema_migrations"),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.values?.[1]).toBe("0001_fixture_base.sql");
    expect(inserts[1]?.values?.[1]).toBe("0002_fixture_extension.sql");
  });

  it("applies only what the journal has not recorded", async () => {
    const migrations = await discoverMigrations(fixtureMigrationDirectory);
    const first = migrations[0];
    expect(first).toBeDefined();
    const { pool, queries } = createFakePool({
      journalPresent: true,
      journalRows: [
        {
          sequence: 1,
          filename: first!.filename,
          checksum_sha256: first!.checksumSha256,
        },
      ],
    });

    const result = await runMigrations(pool, fixtureMigrationDirectory);

    expect(result).toEqual({
      discoveredCount: 2,
      previouslyAppliedCount: 1,
      appliedCount: 1,
    });
    expect(
      queries.filter((query) =>
        query.sql.includes("INSERT INTO dasher_meta.schema_migrations"),
      ),
    ).toHaveLength(1);
  });

  it("is a no-op when the journal already covers the series", async () => {
    const migrations = await discoverMigrations(fixtureMigrationDirectory);
    const { pool, queries } = createFakePool({
      journalPresent: true,
      journalRows: migrations.map((migration) => ({
        sequence: migration.sequence,
        filename: migration.filename,
        checksum_sha256: migration.checksumSha256,
      })),
    });

    const result = await runMigrations(pool, fixtureMigrationDirectory);

    expect(result.appliedCount).toBe(0);
    expect(
      queries.some((query) =>
        query.sql.includes("INSERT INTO dasher_meta.schema_migrations"),
      ),
    ).toBe(false);
  });

  it("reports an edit to an already-applied migration instead of ignoring it", async () => {
    const { pool } = createFakePool({
      journalPresent: true,
      journalRows: [
        {
          sequence: 1,
          filename: "0001_fixture_base.sql",
          checksum_sha256: sha256("a different file entirely"),
        },
      ],
    });

    await expectRejection(
      runMigrations(pool, fixtureMigrationDirectory),
      "migration_file_mismatch",
    );
  });

  it("rejects a journal that records a file the directory renamed", async () => {
    const migrations = await discoverMigrations(fixtureMigrationDirectory);
    const first = migrations[0];
    const { pool } = createFakePool({
      journalPresent: true,
      journalRows: [
        {
          sequence: 1,
          filename: "0001_renamed.sql",
          checksum_sha256: first!.checksumSha256,
        },
      ],
    });

    await expectRejection(
      runMigrations(pool, fixtureMigrationDirectory),
      "migration_file_mismatch",
    );
  });

  it("rejects a journal ahead of the directory", async () => {
    const { pool } = createFakePool({
      journalPresent: true,
      journalRows: [1, 2, 3].map((sequence) => ({
        sequence,
        filename: `000${sequence}_ghost.sql`,
        checksum_sha256: sha256(`ghost ${sequence}`),
      })),
    });

    await expectRejection(
      runMigrations(pool, fixtureMigrationDirectory),
      "journal_identity_mismatch",
    );
  });

  it("refuses to apply as a role that does not own the database", async () => {
    const { pool } = createFakePool({ isDatabaseOwner: false });

    await expectRejection(
      runMigrations(pool, fixtureMigrationDirectory),
      "executor_not_database_owner",
    );
  });

  it("rejects a login role name that is not a plain identifier", async () => {
    const { pool } = createFakePool();

    await expectRejection(
      runMigrations(pool, fixtureMigrationDirectory, ['app"; DROP TABLE x --']),
      "role_name_invalid",
    );
  });

  it("rejects a login role name that shadows the managed group role", async () => {
    const { pool } = createFakePool();

    await expectRejection(
      runMigrations(pool, fixtureMigrationDirectory, ["dasher_app"]),
      "role_name_invalid",
    );
  });

  it("rolls back and releases the connection when a migration fails", async () => {
    const { pool, queries, released } = createFakePool({
      failOnSqlContaining: "fixture_extension",
    });

    await expect(
      runMigrations(pool, fixtureMigrationDirectory),
    ).rejects.toThrow("migration failed");

    expect(queries.some((query) => query.sql === "ROLLBACK")).toBe(true);
    expect(released()).toBe(1);
  });

  it("takes and releases the advisory lock around the run", async () => {
    const { pool, queries, released } = createFakePool();

    await runMigrations(pool, fixtureMigrationDirectory);

    expect(queries[0]?.sql).toContain("pg_advisory_lock");
    expect(queries.at(-1)?.sql).toContain("pg_advisory_unlock");
    expect(released()).toBe(1);
  });

  it("releases the connection even when discovery never reaches the database", async () => {
    const { pool, released } = createFakePool();

    await expectRejection(
      runMigrations(pool, await makeDirectory({})),
      "empty_series",
    );
    expect(released()).toBe(0);
  });
});
