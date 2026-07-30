import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { MigrationContractError, discoverMigrations } from "./migrator.js";

const fixtureDirectory = fileURLToPath(
  new URL("../test/fixtures/migrations", import.meta.url),
);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dasher-migrator-unit-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function expectContractError(
  directory: string,
  code: string,
): Promise<void> {
  try {
    await discoverMigrations(directory);
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationContractError);
    expect((error as MigrationContractError).code).toBe(code);
    return;
  }

  throw new Error("expected migration discovery to reject the directory");
}

describe("discoverMigrations", () => {
  it("discovers exact bytes in contiguous sequence order with SHA-256", async () => {
    const migrations = await discoverMigrations(fixtureDirectory);

    expect(
      migrations.map(({ sequence, filename }) => ({ sequence, filename })),
    ).toEqual([
      { sequence: 1, filename: "0001_fixture_base.sql" },
      { sequence: 2, filename: "0002_fixture_extension.sql" },
    ]);

    for (const migration of migrations) {
      const bytes = await readFile(
        resolve(fixtureDirectory, migration.filename),
      );
      expect(migration.bytes).toEqual(bytes);
      expect(migration.checksumSha256).toEqual(
        createHash("sha256").update(bytes).digest(),
      );
    }
  });

  it.each([
    "1_short.sql",
    "0001_Upper.sql",
    "0001-hyphen.sql",
    "0001_double__underscore.sql",
    "0001_trailing_.sql",
    "0001_fixture.txt",
    ".hidden",
  ])("rejects the malformed directory entry %s", async (filename) => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, filename), "SELECT 1;\n");

    await expectContractError(directory, "malformed_filename");
  });

  it("rejects directories and symbolic links as migration entries", async () => {
    const nestedDirectory = await temporaryDirectory();
    await mkdir(join(nestedDirectory, "0001_nested.sql"));
    await expectContractError(nestedDirectory, "non_regular_file");

    const linkDirectory = await temporaryDirectory();
    const target = join(linkDirectory, "target");
    await writeFile(target, "SELECT 1;\n");
    await symlink(target, join(linkDirectory, "0001_link.sql"));
    await expectContractError(linkDirectory, "non_regular_file");
  });

  it("rejects an empty series, a non-0001 start, a gap, and duplicate sequence", async () => {
    const empty = await temporaryDirectory();
    await expectContractError(empty, "empty_series");

    const lateStart = await temporaryDirectory();
    await writeFile(join(lateStart, "0002_late.sql"), "SELECT 2;\n");
    await expectContractError(lateStart, "non_contiguous_sequence");

    const gap = await temporaryDirectory();
    await writeFile(join(gap, "0001_first.sql"), "SELECT 1;\n");
    await writeFile(join(gap, "0003_third.sql"), "SELECT 3;\n");
    await expectContractError(gap, "non_contiguous_sequence");

    const duplicate = await temporaryDirectory();
    await writeFile(join(duplicate, "0001_first.sql"), "SELECT 1;\n");
    await writeFile(join(duplicate, "0001_other.sql"), "SELECT 2;\n");
    await expectContractError(duplicate, "non_contiguous_sequence");
  });

  it("rejects source bytes that are not valid UTF-8 SQL", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "0001_invalid.sql"), Uint8Array.of(0xff));

    await expectContractError(directory, "invalid_utf8");
  });
});
