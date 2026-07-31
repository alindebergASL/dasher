import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { discoverMigrations } from "./migrator.js";

const canonicalMigrationDirectory = new URL("../migrations", import.meta.url)
  .pathname;

const identityAuditMigration = {
  sequence: 1,
  filename: "0001_identity_audit.sql",
  checksum: "d44b7d6e4cb34026cbfb0156b7be29ded3ac2ab6944f2759b04aa5b848f3e81a",
} as const;

describe("Task 3 canonical migration golden guard", () => {
  it("pins exactly the immutable 0001 filename and source-byte checksum", async () => {
    const migrations = await discoverMigrations(canonicalMigrationDirectory);

    expect(
      migrations.map((migration) => ({
        sequence: migration.sequence,
        filename: migration.filename,
        checksum: Buffer.from(migration.checksumSha256).toString("hex"),
      })),
    ).toEqual([identityAuditMigration]);
  });

  it("contains no extension, credential, or UUID-generation source", async () => {
    const [migration] = await discoverMigrations(canonicalMigrationDirectory);

    expect(migration?.sql).not.toMatch(
      /CREATE\s+EXTENSION|gen_random_uuid|uuid_generate|PASSWORD\s+'|sk-proj|BEGIN\s+(?:RSA|OPENSSH)\s+PRIVATE|postgres(?:ql)?:\/\/|DASHER_TEST_(?:OWNER|APP)_DSN/iu,
    );
  });

  it("has one catalog-search-path persistent function with no dynamic SQL", async () => {
    const [migration] = await discoverMigrations(canonicalMigrationDirectory);
    const functionDefinitions =
      migration?.sql
        .split(/(?=CREATE FUNCTION )/gu)
        .slice(1)
        .map((fragment) => fragment.split(/\n\$function\$;/u)[0] ?? "") ?? [];

    expect(functionDefinitions).toHaveLength(1);
    expect(functionDefinitions[0]).toContain("SET search_path = pg_catalog");
    expect(functionDefinitions[0]).not.toMatch(/\bEXECUTE\b/u);
  });
});
