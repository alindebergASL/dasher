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

import {
  MigrationContractError,
  bootstrapManagedRoles,
  discoverMigrations,
  resetPreparedRetentionRoles,
  runMigrations,
  type MigrationClient,
  type MigrationPool,
} from "./migrator.js";

const fixtureDirectory = fileURLToPath(
  new URL("../test/fixtures/migrations", import.meta.url),
);
const canonicalMigrationDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const modeledSuccessorFixture = fileURLToPath(
  new URL(
    "../test/fixtures/migrations-0003-allowlist/modeled-successor/0003_immutable_content.sql",
    import.meta.url,
  ),
);
const temporaryDirectories: string[] = [];

type FailureStage =
  | "advisory"
  | "begin"
  | "commit"
  | "journal"
  | "migration"
  | "set-local"
  | "validation";

interface FailureInjection {
  readonly stage: FailureStage;
  readonly transaction: 1 | 2 | 3;
}

type ManagedRoleName =
  | "dasher_app"
  | "dasher_retention_definer"
  | "dasher_retention_operator"
  | "dasher_security_definer";

interface ScriptedMigrationOptions {
  readonly dependencyMatches?: readonly boolean[];
  readonly destructiveReleaseThrows?: boolean;
  readonly expectedLoginRows?: readonly Record<string, unknown>[];
  readonly failure?: FailureInjection;
  readonly initialJournalRows?: readonly {
    readonly applied_by: string;
    readonly checksum_sha256: Uint8Array;
    readonly filename: string;
    readonly sequence: number;
  }[];
  readonly membershipRows?: readonly Record<string, unknown>[];
  readonly managedRoleCreateErrors?: Partial<Record<ManagedRoleName, unknown>>;
  readonly managedRoleReads?: Partial<
    Record<
      ManagedRoleName,
      readonly (Readonly<Record<string, unknown>> | undefined)[]
    >
  >;
  readonly normalReleaseThrows?: boolean;
  readonly operationError?: unknown;
  readonly prefixObjectMatches?: boolean;
  readonly retentionRoleNames?: readonly string[];
  readonly rollbackFails?: boolean;
  readonly savepointReleaseError?: unknown;
  readonly savepointRollbackError?: unknown;
  readonly sessionLockError?: unknown;
  readonly sessionUnlockError?: unknown;
  readonly sessionUnlockResult?: boolean;
  readonly successorCatalogMatches?: boolean;
}

interface ScriptedMigrationClient {
  readonly client: MigrationClient;
  readonly destructiveReleaseError: Error;
  readonly normalReleaseError: Error;
  readonly operationError: unknown;
  readonly managedRoleEvents: readonly string[];
  readonly queryTexts: readonly string[];
  readonly releaseArguments: readonly (Error | boolean | undefined)[];
  readonly rollbackError: Error;
  readonly rollbackQueries: number;
  readonly transactionCommands: readonly string[];
  readonly dependencyInventories: readonly (readonly Record<
    string,
    unknown
  >[])[];
  readonly dependencyRoleNames: readonly (readonly string[])[];
}

function result(rows: readonly unknown[]): { rows: readonly unknown[] } {
  return { rows };
}

function arraysEqualForTest<T>(
  left: readonly T[],
  right: readonly T[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function managedRoleRow(
  roleName: ManagedRoleName,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    bypass_rls: roleName === "dasher_security_definer",
    can_create_database: false,
    can_create_role: false,
    can_login: false,
    comment:
      roleName === "dasher_security_definer"
        ? "dasher:managed-role:v1:security-definer"
        : roleName === "dasher_retention_definer"
          ? "dasher:managed-role:v1:retention-definer"
          : roleName === "dasher_retention_operator"
            ? "dasher:managed-role:v1:retention-operator"
            : "dasher:managed-role:v1:app",
    connection_limit: -1,
    has_settings: false,
    inherit_privileges: false,
    password_is_null: true,
    replication: false,
    role_count: "1",
    superuser: false,
    valid_until_is_null: true,
    valid_until_is_infinity: roleName.startsWith("dasher_retention_"),
    ...overrides,
  };
}

function scriptedMigrationClient(
  options: ScriptedMigrationOptions = {},
): ScriptedMigrationClient {
  const operationError =
    options.operationError ??
    new Error(`synthetic ${options.failure?.stage ?? "unused"} failure`);
  const rollbackError = new Error(
    "synthetic rollback failure with postgres://user:secret@host/database and SELECT secret",
  );
  const destructiveReleaseError = new Error(
    "synthetic release failure with postgres://user:secret@host/database and raw server details",
  );
  const normalReleaseError = new Error("synthetic normal release failure");
  const managedRoleEvents: string[] = [];
  const releaseArguments: (Error | boolean | undefined)[] = [];
  const queryTexts: string[] = [];
  const transactionCommands: string[] = [];
  const dependencyInventories: (readonly Record<string, unknown>[])[] = [];
  const dependencyRoleNames: (readonly string[])[] = [];
  const journalRows = [...(options.initialJournalRows ?? [])];
  const managedRoleReadCounts: Record<ManagedRoleName, number> = {
    dasher_app: 0,
    dasher_retention_definer: 0,
    dasher_retention_operator: 0,
    dasher_security_definer: 0,
  };
  const createdPreparedRoles = new Set<string>();
  const droppedPreparedRoles = new Set<string>();
  let currentTransaction = 0;
  let dependencyCheck = 0;
  let rollbackQueries = 0;

  function command(name: string): void {
    transactionCommands.push(`T${String(currentTransaction)} ${name}`);
  }

  function failAt(stage: FailureStage): void {
    if (
      options.failure?.transaction === currentTransaction &&
      options.failure.stage === stage
    ) {
      throw operationError;
    }
  }

  const query = (async (
    queryText: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly unknown[] }> => {
    const text = queryText.trim();
    queryTexts.push(text);

    if (text.includes("pg_catalog.pg_advisory_lock(")) {
      transactionCommands.push("SESSION ADVISORY LOCK");
      if (options.sessionLockError !== undefined) {
        throw options.sessionLockError;
      }
      return result([]);
    }
    if (text.includes("pg_catalog.pg_advisory_unlock(")) {
      transactionCommands.push("SESSION ADVISORY UNLOCK");
      if (options.sessionUnlockError !== undefined) {
        throw options.sessionUnlockError;
      }
      return result([{ unlocked: options.sessionUnlockResult ?? true }]);
    }

    if (text === "BEGIN") {
      currentTransaction += 1;
      command("BEGIN");
      failAt("begin");
      return result([]);
    }
    if (text === "SET LOCAL search_path = pg_catalog") {
      command("SET LOCAL");
      failAt("set-local");
      return result([]);
    }
    if (text === "SELECT pg_catalog.pg_advisory_xact_lock(724372, 20260730)") {
      command("ADVISORY LOCK");
      failAt("advisory");
      return result([]);
    }
    if (text === "SAVEPOINT dasher_managed_role_create") {
      managedRoleEvents.push("SAVEPOINT");
      return result([]);
    }
    if (text === "ROLLBACK TO SAVEPOINT dasher_managed_role_create") {
      managedRoleEvents.push("ROLLBACK TO SAVEPOINT");
      if (options.savepointRollbackError !== undefined) {
        throw options.savepointRollbackError;
      }
      return result([]);
    }
    if (text === "RELEASE SAVEPOINT dasher_managed_role_create") {
      managedRoleEvents.push("RELEASE SAVEPOINT");
      if (options.savepointReleaseError !== undefined) {
        throw options.savepointReleaseError;
      }
      return result([]);
    }
    if (text === "COMMIT") {
      command("COMMIT");
      failAt("commit");
      return result([]);
    }
    if (text === "ROLLBACK") {
      command("ROLLBACK");
      rollbackQueries += 1;
      if (options.rollbackFails === true) {
        throw rollbackError;
      }
      return result([]);
    }
    if (
      text.includes("CREATE TABLE dasher.users") ||
      text.includes("CREATE FUNCTION dasher_api.rotate_session")
    ) {
      command("MIGRATION SQL");
      failAt("migration");
      return result([]);
    }
    if (text.includes("WITH RECURSIVE inherited_roles")) {
      command("CATALOG VALIDATION");
      failAt("validation");
      return result([
        {
          current_name: "migration_owner",
          database_owner_name: "migration_owner",
          is_database_owner: true,
          is_managed_role: false,
          is_member_of_app: false,
          is_superuser: true,
          session_name: "migration_owner",
        },
      ]);
    }
    if (text.includes("WITH expected(role_name) AS")) {
      return result(options.expectedLoginRows ?? []);
    }
    if (text.includes("role.rolname LIKE 'dasher\\_retention\\_%'")) {
      const roleNames = [
        ...(options.retentionRoleNames ?? []),
        ...createdPreparedRoles,
      ].filter((roleName) => !droppedPreparedRoles.has(roleName));
      return result(
        [...new Set(roleNames)]
          .sort()
          .map((roleName) => ({ role_name: roleName })),
      );
    }
    if (text.includes("FROM pg_catalog.pg_authid AS role")) {
      const roleName = values?.[0] as ManagedRoleName;
      managedRoleEvents.push(`READ ${roleName}`);
      const reads = options.managedRoleReads?.[roleName];
      const readIndex = managedRoleReadCounts[roleName];
      managedRoleReadCounts[roleName] += 1;
      const row =
        reads !== undefined && readIndex < reads.length
          ? reads[readIndex]
          : roleName.startsWith("dasher_retention_") &&
              (droppedPreparedRoles.has(roleName) ||
                (!createdPreparedRoles.has(roleName) &&
                  !(options.retentionRoleNames ?? []).includes(roleName)))
            ? undefined
            : managedRoleRow(roleName);
      return result(row === undefined ? [] : [row]);
    }
    if (text.startsWith("CREATE ROLE dasher_app")) {
      managedRoleEvents.push("CREATE dasher_app");
      if (
        options.managedRoleCreateErrors !== undefined &&
        Object.prototype.hasOwnProperty.call(
          options.managedRoleCreateErrors,
          "dasher_app",
        )
      ) {
        throw options.managedRoleCreateErrors.dasher_app;
      }
      return result([]);
    }
    if (text.startsWith("CREATE ROLE dasher_security_definer")) {
      managedRoleEvents.push("CREATE dasher_security_definer");
      if (
        options.managedRoleCreateErrors !== undefined &&
        Object.prototype.hasOwnProperty.call(
          options.managedRoleCreateErrors,
          "dasher_security_definer",
        )
      ) {
        throw options.managedRoleCreateErrors.dasher_security_definer;
      }
      return result([]);
    }
    if (text.startsWith("CREATE ROLE dasher_retention_definer")) {
      managedRoleEvents.push("CREATE dasher_retention_definer");
      createdPreparedRoles.add("dasher_retention_definer");
      return result([]);
    }
    if (text.startsWith("CREATE ROLE dasher_retention_operator")) {
      managedRoleEvents.push("CREATE dasher_retention_operator");
      createdPreparedRoles.add("dasher_retention_operator");
      return result([]);
    }
    if (text.startsWith("COMMENT ON ROLE ")) {
      managedRoleEvents.push(
        text.startsWith("COMMENT ON ROLE dasher_app ")
          ? "COMMENT dasher_app"
          : text.startsWith("COMMENT ON ROLE dasher_security_definer ")
            ? "COMMENT dasher_security_definer"
            : text.startsWith("COMMENT ON ROLE dasher_retention_definer ")
              ? "COMMENT dasher_retention_definer"
              : "COMMENT dasher_retention_operator",
      );
      return result([]);
    }
    if (text === "DROP ROLE dasher_retention_operator") {
      managedRoleEvents.push("DROP dasher_retention_operator");
      droppedPreparedRoles.add("dasher_retention_operator");
      return result([]);
    }
    if (text === "DROP ROLE dasher_retention_definer") {
      managedRoleEvents.push("DROP dasher_retention_definer");
      droppedPreparedRoles.add("dasher_retention_definer");
      return result([]);
    }
    if (
      text.includes("database_row.oid::text AS database_oid") &&
      text.includes("pg_catalog.current_database()")
    ) {
      return result([
        {
          database_name: "dasher_test",
          database_oid: "16384",
        },
      ]);
    }
    if (text.includes("FROM pg_catalog.pg_auth_members AS membership")) {
      return result(options.membershipRows ?? []);
    }
    if (text.includes("actual_schemas AS")) {
      return result([{ matches: options.prefixObjectMatches ?? true }]);
    }
    if (text.includes("modeled_initializer AS")) {
      return result([{ matches: options.successorCatalogMatches ?? true }]);
    }
    if (text.includes("pg_catalog.jsonb_to_recordset")) {
      dependencyRoleNames.push([...(values?.[0] as readonly string[])]);
      dependencyInventories.push(
        JSON.parse(values?.[1] as string) as readonly Record<string, unknown>[],
      );
      const matches = options.dependencyMatches?.[dependencyCheck] ?? true;
      dependencyCheck += 1;
      return result([{ matches }]);
    }
    if (text.includes("pg_catalog.to_regclass")) {
      return result([{ journal_oid: "dasher_meta.schema_migrations" }]);
    }
    if (
      text.includes("relation.relkind") &&
      text.includes("namespace.nspname = 'dasher_meta'")
    ) {
      return result([
        {
          relforcerowsecurity: false,
          relkind: "r",
          reloptions: null,
          relpersistence: "p",
          relrowsecurity: false,
          schema_owner: "migration_owner",
          table_owner: "migration_owner",
        },
      ]);
    }
    if (
      text.includes("attribute.attname") &&
      text.includes("attribute.attidentity")
    ) {
      return result([
        {
          attgenerated: "",
          attidentity: "",
          attname: "sequence",
          attnotnull: true,
          default_expression: null,
          formatted_type: "integer",
        },
        {
          attgenerated: "",
          attidentity: "",
          attname: "filename",
          attnotnull: true,
          default_expression: null,
          formatted_type: "text",
        },
        {
          attgenerated: "",
          attidentity: "",
          attname: "checksum_sha256",
          attnotnull: true,
          default_expression: null,
          formatted_type: "bytea",
        },
        {
          attgenerated: "",
          attidentity: "",
          attname: "applied_at",
          attnotnull: true,
          default_expression: "statement_timestamp()",
          formatted_type: "timestamp with time zone",
        },
        {
          attgenerated: "",
          attidentity: "",
          attname: "applied_by",
          attnotnull: true,
          default_expression: null,
          formatted_type: "name",
        },
      ]);
    }
    if (text.includes("FROM pg_catalog.pg_constraint AS journal_constraint")) {
      return result([
        {
          column_numbers: [3],
          constraint_definition: "CHECK ((octet_length(checksum_sha256) = 32))",
          constraint_name: "schema_migrations_checksum_sha256_check",
          constraint_type: "c",
        },
        {
          column_numbers: [2],
          constraint_definition:
            "CHECK ((filename ~ '^[0-9]{4}_[a-z0-9]+(?:_[a-z0-9]+)*[.]sql$'::text))",
          constraint_name: "schema_migrations_filename_check",
          constraint_type: "c",
        },
        {
          column_numbers: [2],
          constraint_definition: "UNIQUE (filename)",
          constraint_name: "schema_migrations_filename_key",
          constraint_type: "u",
        },
        {
          column_numbers: [1],
          constraint_definition: "PRIMARY KEY (sequence)",
          constraint_name: "schema_migrations_pkey",
          constraint_type: "p",
        },
        {
          column_numbers: [1],
          constraint_definition:
            "CHECK (((sequence >= 1) AND (sequence <= 9999)))",
          constraint_name: "schema_migrations_sequence_check",
          constraint_type: "c",
        },
      ]);
    }
    if (text.includes("namespace.nspacl")) {
      return result([
        {
          grantee_name: "migration_owner",
          is_grantable: false,
          privilege_type: "CREATE",
        },
        {
          grantee_name: "migration_owner",
          is_grantable: false,
          privilege_type: "USAGE",
        },
      ]);
    }
    if (text.includes("relation.relacl")) {
      return result(
        [
          "DELETE",
          "INSERT",
          "REFERENCES",
          "SELECT",
          "TRIGGER",
          "TRUNCATE",
          "UPDATE",
        ].map((privilegeType) => ({
          grantee_name: "migration_owner",
          is_grantable: false,
          privilege_type: privilegeType,
        })),
      );
    }
    if (text.startsWith("SELECT relname, relkind")) {
      return result([
        { relname: "schema_migrations", relkind: "r" },
        { relname: "schema_migrations_filename_key", relkind: "i" },
        { relname: "schema_migrations_pkey", relkind: "i" },
      ]);
    }
    if (
      text.includes("FROM pg_catalog.pg_attribute") &&
      text.includes("attacl IS NOT NULL")
    ) {
      return result([{ count: "0" }]);
    }
    if (text.includes("FROM pg_catalog.pg_index")) {
      return result([{ count: "2" }]);
    }
    if (text.includes("FROM pg_catalog.pg_trigger")) {
      return result([{ count: "0" }]);
    }
    if (text.includes("FROM pg_catalog.pg_policy")) {
      return result([{ count: "0" }]);
    }
    if (text.startsWith("SELECT sequence, filename, checksum_sha256")) {
      return result([...journalRows]);
    }
    if (
      text.startsWith("CREATE SCHEMA dasher;") ||
      text.startsWith("CREATE TABLE dasher.fixture_extension") ||
      text.startsWith("SELECT 1;") ||
      text.startsWith("SELECT 2;") ||
      text.includes("modeled_successor_inventory_version")
    ) {
      command("MIGRATION SQL");
      failAt("migration");
      return result([]);
    }
    if (text.includes("INSERT INTO dasher_meta.schema_migrations")) {
      command("JOURNAL INSERT");
      failAt("journal");
      journalRows.push({
        applied_by: "migration_owner",
        checksum_sha256: values?.[2] as Uint8Array,
        filename: values?.[1] as string,
        sequence: values?.[0] as number,
      });
      return result([]);
    }

    throw new Error("unexpected scripted migration query");
  }) as MigrationClient["query"];

  return {
    client: {
      query,
      release(error) {
        releaseArguments.push(error);
        if (options.destructiveReleaseThrows === true && error !== undefined) {
          throw destructiveReleaseError;
        }
        if (options.normalReleaseThrows === true && error === undefined) {
          throw normalReleaseError;
        }
      },
    },
    destructiveReleaseError,
    normalReleaseError,
    operationError,
    managedRoleEvents,
    queryTexts,
    releaseArguments,
    rollbackError,
    dependencyInventories,
    dependencyRoleNames,
    get rollbackQueries() {
      return rollbackQueries;
    },
    transactionCommands,
  };
}

function singleClientPool(client: MigrationClient): MigrationPool {
  return {
    async connect() {
      return client;
    },
  };
}

async function capturedFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }

  throw new Error("expected operation to fail");
}

function managedRoleCreateError(
  properties: Readonly<Record<string, unknown>>,
): Error {
  const error = new Error(
    "duplicate role with postgres://owner:secret@host/database and raw DETAIL",
  );
  for (const [property, value] of Object.entries(properties)) {
    Object.defineProperty(error, property, { enumerable: true, value });
  }
  Object.defineProperty(error, "detail", {
    enumerable: true,
    value: "raw duplicate-role diagnostic",
  });
  return error;
}

function duplicateObjectError(): Error {
  return managedRoleCreateError({ code: "42710" });
}

function pgAuthIdUniqueError(
  overrides: Readonly<Record<string, unknown>> = {},
): Error {
  return managedRoleCreateError({
    code: "23505",
    constraint: "pg_authid_rolname_index",
    schema: "pg_catalog",
    table: "pg_authid",
    ...overrides,
  });
}

const transactionFailureCases = [
  { name: "prefix validation BEGIN", stage: "begin", transaction: 1 },
  { name: "prefix validation SET LOCAL", stage: "set-local", transaction: 1 },
  { name: "prefix catalog validation", stage: "validation", transaction: 1 },
  { name: "prefix validation COMMIT", stage: "commit", transaction: 1 },
  { name: "migration BEGIN", stage: "begin", transaction: 2 },
  { name: "migration SET LOCAL", stage: "set-local", transaction: 2 },
  { name: "migration catalog validation", stage: "validation", transaction: 2 },
  { name: "migration SQL", stage: "migration", transaction: 2 },
  { name: "journal insertion", stage: "journal", transaction: 2 },
  { name: "migration COMMIT", stage: "commit", transaction: 2 },
] as const satisfies readonly (FailureInjection & { readonly name: string })[];

function transactionCommands(
  scripted: ScriptedMigrationClient,
  transaction: 1 | 2 | 3,
): readonly string[] {
  const prefix = `T${String(transaction)} `;
  return scripted.transactionCommands.filter((entry) =>
    entry.startsWith(prefix),
  );
}

function expectFailureCommandOrder(
  scripted: ScriptedMigrationClient,
  failure: FailureInjection,
): void {
  if (failure.transaction === 2) {
    expect(transactionCommands(scripted, 1)).toEqual([
      "T1 BEGIN",
      "T1 SET LOCAL",
      "T1 CATALOG VALIDATION",
      "T1 COMMIT",
    ]);
  }

  const commands = transactionCommands(scripted, failure.transaction);
  expect(commands[0]).toBe(`T${String(failure.transaction)} BEGIN`);

  if (failure.stage !== "begin") {
    expect(commands[1]).toBe(`T${String(failure.transaction)} SET LOCAL`);
  }
  if (failure.stage !== "begin" && failure.stage !== "set-local") {
    expect(commands.slice(0, 3)).toEqual([
      `T${String(failure.transaction)} BEGIN`,
      `T${String(failure.transaction)} SET LOCAL`,
      `T${String(failure.transaction)} CATALOG VALIDATION`,
    ]);
  }
  if (
    failure.stage === "validation" ||
    failure.stage === "migration" ||
    failure.stage === "journal" ||
    failure.stage === "commit"
  ) {
    expect(commands[2]).toBe(
      `T${String(failure.transaction)} CATALOG VALIDATION`,
    );
  }

  const failureCommand = {
    advisory: "ADVISORY LOCK",
    begin: "BEGIN",
    commit: "COMMIT",
    journal: "JOURNAL INSERT",
    migration: "MIGRATION SQL",
    "set-local": "SET LOCAL",
    validation: "CATALOG VALIDATION",
  }[failure.stage];
  expect(commands).toContain(
    `T${String(failure.transaction)} ${failureCommand}`,
  );
  expect(commands.at(-1)).toBe(`T${String(failure.transaction)} ROLLBACK`);
}

function expectSanitizedDestructiveRelease(
  scripted: ScriptedMigrationClient,
): Error {
  expect(scripted.releaseArguments).toHaveLength(1);
  const releaseError = scripted.releaseArguments[0];
  expect(releaseError).toBeInstanceOf(Error);
  expect(releaseError).not.toBe(scripted.rollbackError);
  expect(releaseError).not.toBe(scripted.destructiveReleaseError);
  expect((releaseError as Error).message).toBe(
    "PostgreSQL transaction rollback failed; pooled client destroyed",
  );
  expect(scripted.operationError).toBeInstanceOf(Error);
  expect((scripted.operationError as Error).cause).toBe(releaseError);
  const diagnostic = `${(releaseError as Error).name}:${
    (releaseError as Error).message
  }\n${(releaseError as Error).stack ?? ""}`;
  expect(diagnostic).not.toContain("postgres://");
  expect(diagnostic).not.toContain("SELECT secret");
  expect(diagnostic).not.toContain("raw server details");
  expect(scripted.releaseArguments).not.toContain(undefined);
  return releaseError as Error;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dasher-migrator-unit-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function securityBoundarySeries(): Promise<{
  readonly directory: string;
  readonly journalRows: readonly {
    readonly applied_by: string;
    readonly checksum_sha256: Uint8Array;
    readonly filename: string;
    readonly sequence: number;
  }[];
}> {
  const directory = await temporaryDirectory();
  for (const filename of [
    "0001_identity_audit.sql",
    "0002_security_boundary.sql",
  ] as const) {
    await writeFile(
      join(directory, filename),
      await readFile(join(canonicalMigrationDirectory, filename)),
    );
  }
  const migrations = await discoverMigrations(directory);
  return {
    directory,
    journalRows: migrations.map((migration) => ({
      applied_by: "migration_owner",
      checksum_sha256: migration.checksumSha256,
      filename: migration.filename,
      sequence: migration.sequence,
    })),
  };
}

async function modeledSuccessorSeries(): Promise<{
  readonly directory: string;
  readonly journalRows: readonly {
    readonly applied_by: string;
    readonly checksum_sha256: Uint8Array;
    readonly filename: string;
    readonly sequence: number;
  }[];
}> {
  const directory = await temporaryDirectory();
  for (const filename of [
    "0001_identity_audit.sql",
    "0002_security_boundary.sql",
  ] as const) {
    await writeFile(
      join(directory, filename),
      await readFile(join(canonicalMigrationDirectory, filename)),
    );
  }
  await writeFile(
    join(directory, "0003_immutable_content.sql"),
    await readFile(modeledSuccessorFixture),
  );
  const migrations = await discoverMigrations(directory);
  return {
    directory,
    journalRows: migrations.slice(0, 2).map((migration) => ({
      applied_by: "migration_owner",
      checksum_sha256: migration.checksumSha256,
      filename: migration.filename,
      sequence: migration.sequence,
    })),
  };
}

async function canonical0002Series(): Promise<{
  readonly directory: string;
  readonly journalRows: readonly {
    readonly applied_by: string;
    readonly checksum_sha256: Uint8Array;
    readonly filename: string;
    readonly sequence: number;
  }[];
}> {
  const directory = await temporaryDirectory();
  for (const filename of [
    "0001_identity_audit.sql",
    "0002_security_boundary.sql",
  ] as const) {
    await writeFile(
      join(directory, filename),
      await readFile(join(canonicalMigrationDirectory, filename)),
    );
  }
  const migrations = await discoverMigrations(directory);
  return {
    directory,
    journalRows: migrations.map((migration) => ({
      applied_by: "migration_owner",
      checksum_sha256: migration.checksumSha256,
      filename: migration.filename,
      sequence: migration.sequence,
    })),
  };
}

function expectedLoginRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    bypass_rls: false,
    can_create_database: false,
    can_create_role: false,
    can_login: true,
    comment: "dasher:app-login:v1:database-oid:16384",
    connection_limit: -1,
    current_database_oid: "16384",
    has_settings: false,
    inherit_privileges: false,
    password_is_scram: true,
    replication: false,
    role_name: "dasher_test_00000000000000000000000000000000",
    role_present: true,
    superuser: false,
    valid_until_is_null: true,
    ...overrides,
  };
}

function expectedMembershipRowFor(
  roleName: string,
): Readonly<Record<string, unknown>> {
  return {
    admin_option: false,
    granted_role_name: "dasher_app",
    inherit_option: false,
    member_role_name: roleName,
    set_option: true,
  };
}

const expectedMembershipRow = expectedMembershipRowFor(
  "dasher_test_00000000000000000000000000000000",
);
const expectedManagedDependencyRoleNames = [
  "dasher_app",
  "dasher_security_definer",
  "dasher_retention_definer",
  "dasher_retention_operator",
] as const;

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("managed-role concurrent bootstrap savepoints", () => {
  it("creates, releases, comments, and strictly reads back both missing roles in order", async () => {
    const scripted = scriptedMigrationClient({
      managedRoleReads: {
        dasher_app: [undefined, managedRoleRow("dasher_app")],
        dasher_security_definer: [
          undefined,
          managedRoleRow("dasher_security_definer"),
        ],
      },
    });

    await expect(bootstrapManagedRoles(scripted.client, [])).resolves.toBe(
      undefined,
    );
    expect(scripted.managedRoleEvents).toEqual([
      "READ dasher_app",
      "SAVEPOINT",
      "CREATE dasher_app",
      "RELEASE SAVEPOINT",
      "COMMENT dasher_app",
      "READ dasher_app",
      "READ dasher_security_definer",
      "SAVEPOINT",
      "CREATE dasher_security_definer",
      "RELEASE SAVEPOINT",
      "COMMENT dasher_security_definer",
      "READ dasher_security_definer",
    ]);
  });

  it.each([
    { error: duplicateObjectError(), name: "exact 42710" },
    { error: pgAuthIdUniqueError(), name: "exact pg_authid 23505" },
  ])("recovers an $name loser and verifies the winner", async ({ error }) => {
    const scripted = scriptedMigrationClient({
      managedRoleCreateErrors: { dasher_app: error },
      managedRoleReads: {
        dasher_app: [undefined, managedRoleRow("dasher_app")],
      },
    });

    await expect(bootstrapManagedRoles(scripted.client, [])).resolves.toBe(
      undefined,
    );
    expect(scripted.managedRoleEvents).toEqual([
      "READ dasher_app",
      "SAVEPOINT",
      "CREATE dasher_app",
      "ROLLBACK TO SAVEPOINT",
      "RELEASE SAVEPOINT",
      "READ dasher_app",
      "READ dasher_security_definer",
      "READ dasher_security_definer",
    ]);
    expect(scripted.managedRoleEvents).not.toContain("COMMENT dasher_app");
  });

  it("preserves partial, mismatched, inherited, accessor, arbitrary, and hostile errors", async () => {
    const otherPostgresError = new Error(
      "synthetic non-duplicate CREATE failure",
    );
    Object.defineProperty(otherPostgresError, "code", { value: "42501" });

    const accessorCodeError = new Error("accessor code raw diagnostic");
    let accessorCodeReads = 0;
    Object.defineProperty(accessorCodeError, "code", {
      get() {
        accessorCodeReads += 1;
        throw new Error("secondary code accessor failure");
      },
    });
    const accessorError = managedRoleCreateError({
      code: "23505",
      constraint: "pg_authid_rolname_index",
      schema: "pg_catalog",
    });
    let accessorReads = 0;
    Object.defineProperty(accessorError, "table", {
      get() {
        accessorReads += 1;
        throw new Error("secondary accessor failure");
      },
    });

    const inheritedTableError = managedRoleCreateError({
      code: "23505",
      constraint: "pg_authid_rolname_index",
      schema: "pg_catalog",
    });
    const inheritedTablePrototype = Object.create(Error.prototype) as object;
    Object.defineProperty(inheritedTablePrototype, "table", {
      value: "pg_authid",
    });
    Object.setPrototypeOf(inheritedTableError, inheritedTablePrototype);

    let proxyTrapCalls = 0;
    const hostileProxy = new Proxy(pgAuthIdUniqueError(), {
      get() {
        proxyTrapCalls += 1;
        throw new Error("secondary proxy get failure");
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("secondary proxy descriptor failure");
      },
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error("secondary proxy failure");
      },
    });
    const thrownValues: readonly unknown[] = [
      otherPostgresError,
      accessorCodeError,
      managedRoleCreateError({ code: "23505" }),
      pgAuthIdUniqueError({ constraint: "wrong_constraint" }),
      pgAuthIdUniqueError({ schema: "public" }),
      pgAuthIdUniqueError({ table: "wrong_table" }),
      inheritedTableError,
      accessorError,
      {
        code: "42710",
      },
      {
        code: "23505",
        constraint: "pg_authid_rolname_index",
        schema: "pg_catalog",
        table: "pg_authid",
      },
      hostileProxy,
    ];

    for (const thrownValue of thrownValues) {
      const scripted = scriptedMigrationClient({
        managedRoleCreateErrors: { dasher_app: thrownValue },
        managedRoleReads: { dasher_app: [undefined] },
      });
      const captured: { failure?: unknown } = {};
      try {
        await bootstrapManagedRoles(scripted.client, []);
      } catch (error) {
        captured.failure = error;
      }

      expect(captured).toHaveProperty("failure");
      expect(captured.failure).toBe(thrownValue);
      expect(scripted.managedRoleEvents).toEqual([
        "READ dasher_app",
        "SAVEPOINT",
        "CREATE dasher_app",
      ]);
      expect(transactionCommands(scripted, 1).at(-1)).toBe("T1 ROLLBACK");
    }
    expect(accessorCodeReads).toBe(0);
    expect(accessorReads).toBe(0);
    expect(proxyTrapCalls).toBe(0);
  });

  it.each([
    { name: "still missing", winner: undefined },
    {
      name: "drifted",
      winner: managedRoleRow("dasher_app", {
        comment: "synthetic:wrong-marker with raw secret",
      }),
    },
  ])(
    "rejects a $name duplicate-object winner without leakage",
    async ({ winner }) => {
      const duplicate = duplicateObjectError();
      const scripted = scriptedMigrationClient({
        managedRoleCreateErrors: { dasher_app: duplicate },
        managedRoleReads: { dasher_app: [undefined, winner] },
      });

      const failure = await capturedFailure(
        bootstrapManagedRoles(scripted.client, []),
      );
      expect(failure).toBeInstanceOf(MigrationContractError);
      expect(failure).toMatchObject({ code: "managed_role_drift" });
      expect((failure as Error).cause).toBeUndefined();
      const publicDiagnostic = `${String(failure)}\n${
        (failure as Error).stack ?? ""
      }`;
      expect(publicDiagnostic).not.toContain("postgres://");
      expect(publicDiagnostic).not.toContain("raw DETAIL");
      expect(publicDiagnostic).not.toContain("raw secret");
      expect(scripted.managedRoleEvents).toEqual([
        "READ dasher_app",
        "SAVEPOINT",
        "CREATE dasher_app",
        "ROLLBACK TO SAVEPOINT",
        "RELEASE SAVEPOINT",
        "READ dasher_app",
      ]);
      expect(transactionCommands(scripted, 1).at(-1)).toBe("T1 ROLLBACK");
    },
  );

  it.each([
    { failAt: "rollback", name: "loser rollback" },
    { failAt: "release", name: "loser release" },
    { failAt: "winning release", name: "winner release" },
  ] as const)(
    "preserves a $name failure for the outer rollback",
    async ({ failAt }) => {
      const savepointFailure = new Error(
        `synthetic ${failAt} savepoint failure`,
      );
      const isWinner = failAt === "winning release";
      const scripted = scriptedMigrationClient({
        managedRoleCreateErrors: isWinner
          ? undefined
          : { dasher_app: duplicateObjectError() },
        managedRoleReads: { dasher_app: [undefined] },
        savepointReleaseError:
          failAt === "release" || isWinner ? savepointFailure : undefined,
        savepointRollbackError:
          failAt === "rollback" ? savepointFailure : undefined,
      });

      const failure = await capturedFailure(
        bootstrapManagedRoles(scripted.client, []),
      );
      expect(failure).toBe(savepointFailure);
      expect(transactionCommands(scripted, 1).at(-1)).toBe("T1 ROLLBACK");
      expect(scripted.managedRoleEvents).not.toContain("COMMENT dasher_app");
    },
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

  it("bounds each migration file before UTF-8 parsing", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "0001_oversized.sql"),
      new Uint8Array(16 * 1024 * 1024 + 1),
    );

    await expectContractError(directory, "file_too_large");
  });
});

describe("prefix-aware managed roles and expected app logins", () => {
  it("holds one session gate and prepares both retention roles only after validating exact 0002", async () => {
    const series = await modeledSuccessorSeries();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).resolves.toMatchObject({
      appliedCount: 1,
      previouslyAppliedCount: 2,
    });

    const sessionLockIndex = scripted.queryTexts.findIndex((text) =>
      text.includes("pg_catalog.pg_advisory_lock("),
    );
    const firstCatalogIndex = scripted.queryTexts.findIndex((text) =>
      text.includes("WITH RECURSIVE inherited_roles"),
    );
    const firstPreparedCreateIndex = scripted.queryTexts.findIndex((text) =>
      text.startsWith("CREATE ROLE dasher_retention_definer WITH"),
    );
    const journalReadIndex = scripted.queryTexts.findIndex((text) =>
      text.startsWith("SELECT sequence, filename, checksum_sha256"),
    );
    const unlockIndex = scripted.queryTexts.findIndex((text) =>
      text.includes("pg_catalog.pg_advisory_unlock("),
    );

    expect(sessionLockIndex).toBeGreaterThanOrEqual(0);
    expect(sessionLockIndex).toBeLessThan(firstCatalogIndex);
    expect(journalReadIndex).toBeLessThan(firstPreparedCreateIndex);
    expect(firstPreparedCreateIndex).toBeGreaterThanOrEqual(0);
    expect(unlockIndex).toBeGreaterThan(firstPreparedCreateIndex);
    expect(scripted.queryTexts).toContain(
      "CREATE ROLE dasher_retention_definer WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD NULL VALID UNTIL 'infinity'",
    );
    expect(scripted.queryTexts).toContain(
      "COMMENT ON ROLE dasher_retention_definer IS 'dasher:managed-role:v1:retention-definer'",
    );
    expect(scripted.queryTexts).toContain(
      "CREATE ROLE dasher_retention_operator WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD NULL VALID UNTIL 'infinity'",
    );
    expect(scripted.queryTexts).toContain(
      "COMMENT ON ROLE dasher_retention_operator IS 'dasher:managed-role:v1:retention-operator'",
    );
    expect(transactionCommands(scripted, 2)).toEqual([
      "T2 BEGIN",
      "T2 SET LOCAL",
      "T2 CATALOG VALIDATION",
      "T2 COMMIT",
    ]);
    const successorCatalogQuery = scripted.queryTexts.find((text) =>
      text.includes("modeled_initializer AS"),
    );
    expect(successorCatalogQuery).toContain(
      "pg_catalog.pg_get_function_result",
    );
    expect(successorCatalogQuery).toContain("routine.provolatile");
    expect(successorCatalogQuery).toContain("routine.prosecdef");
    expect(successorCatalogQuery).toContain("routine.proconfig");
    expect(successorCatalogQuery).toContain(
      "retention_service_principal_self_binding_select",
    );
    expect(successorCatalogQuery).toContain(
      "dashboards_retention_target_discovery_select",
    );
    expect(successorCatalogQuery).toContain(
      "prosrc !~* 'FOR[[:space:]]+(UPDATE|SHARE)'",
    );
    const successorDependencies = scripted.dependencyInventories.at(-1) ?? [];
    expect(
      successorDependencies.filter(
        (entry) =>
          entry.dependency_type === "o" &&
          entry.role_name === "dasher_retention_definer",
      ),
    ).toHaveLength(7);
    expect(
      successorDependencies.filter(
        (entry) =>
          entry.privilege_type === "EXECUTE" &&
          entry.role_name === "dasher_retention_operator",
      ),
    ).toHaveLength(7);
  });

  it("accepts the exact dependency-free prepared residue and retries the same modeled file without adoption", async () => {
    const series = await modeledSuccessorSeries();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
      retentionRoleNames: [
        "dasher_retention_definer",
        "dasher_retention_operator",
      ],
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).resolves.toMatchObject({ appliedCount: 1, previouslyAppliedCount: 2 });
    expect(scripted.managedRoleEvents).not.toContain(
      "CREATE dasher_retention_definer",
    );
    expect(scripted.queryTexts).toContainEqual(
      expect.stringContaining("modeled_successor_inventory_version"),
    );
  });

  it.each([
    {
      name: "one missing role",
      roleNames: ["dasher_retention_definer"],
    },
    {
      name: "unexpected extra role",
      roleNames: [
        "dasher_retention_definer",
        "dasher_retention_operator",
        "dasher_retention_unexpected",
      ],
    },
  ])("rejects $name before modeled SQL", async ({ roleNames }) => {
    const series = await modeledSuccessorSeries();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
      retentionRoleNames: roleNames,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
    expect(scripted.queryTexts).not.toContainEqual(
      expect.stringContaining("modeled_successor_inventory_version"),
    );
    expect(scripted.managedRoleEvents).not.toContain(
      "CREATE dasher_retention_operator",
    );
  });

  it.each([
    { name: "LOGIN", overrides: { can_login: true } },
    { name: "INHERIT", overrides: { inherit_privileges: true } },
    { name: "SUPERUSER", overrides: { superuser: true } },
    { name: "CREATEDB", overrides: { can_create_database: true } },
    { name: "CREATEROLE", overrides: { can_create_role: true } },
    { name: "REPLICATION", overrides: { replication: true } },
    { name: "BYPASSRLS", overrides: { bypass_rls: true } },
    { name: "password", overrides: { password_is_null: false } },
    { name: "connection limit", overrides: { connection_limit: 4 } },
    {
      name: "valid-until",
      overrides: { valid_until_is_infinity: false },
    },
    { name: "settings", overrides: { has_settings: true } },
    { name: "comment", overrides: { comment: "synthetic:wrong" } },
  ])(
    "rejects prepared definer $name drift before SQL",
    async ({ overrides }) => {
      const series = await modeledSuccessorSeries();
      const scripted = scriptedMigrationClient({
        initialJournalRows: series.journalRows,
        retentionRoleNames: [
          "dasher_retention_definer",
          "dasher_retention_operator",
        ],
        managedRoleReads: {
          dasher_retention_definer: [
            managedRoleRow("dasher_retention_definer", overrides),
          ],
        },
      });

      await expect(
        runMigrations(singleClientPool(scripted.client), series.directory, []),
      ).rejects.toMatchObject({ code: "managed_role_drift" });
      expect(scripted.queryTexts).not.toContainEqual(
        expect.stringContaining("modeled_successor_inventory_version"),
      );
    },
  );

  it("rejects prepared-role membership, dependency, and premature-object drift before SQL", async () => {
    const series = await modeledSuccessorSeries();
    for (const options of [
      {
        membershipRows: [
          {
            admin_option: false,
            granted_role_name: "synthetic_parent",
            inherit_option: false,
            member_role_name: "dasher_retention_definer",
            set_option: true,
          },
        ],
      },
      { dependencyMatches: [false] },
      { prefixObjectMatches: false },
    ] as const) {
      const scripted = scriptedMigrationClient({
        ...options,
        initialJournalRows: series.journalRows,
        retentionRoleNames: [
          "dasher_retention_definer",
          "dasher_retention_operator",
        ],
      });

      await expect(
        runMigrations(singleClientPool(scripted.client), series.directory, []),
      ).rejects.toMatchObject({ code: "managed_role_drift" });
      expect(scripted.queryTexts).not.toContainEqual(
        expect.stringContaining("modeled_successor_inventory_version"),
      );
    }
  });

  it("rejects prepared roles when modeled 0003 is absent", async () => {
    const series = await canonical0002Series();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
      retentionRoleNames: [
        "dasher_retention_definer",
        "dasher_retention_operator",
      ],
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
    expect(scripted.managedRoleEvents).not.toContain(
      "DROP dasher_retention_operator",
    );
  });

  it("rejects a different modeled-0003 checksum before catalog validation or role creation", async () => {
    const series = await canonical0002Series();
    await writeFile(
      join(series.directory, "0003_immutable_content.sql"),
      "SELECT 3003;\n",
    );
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).rejects.toMatchObject({ code: "migration_file_mismatch" });
    expect(scripted.queryTexts).not.toContainEqual(
      expect.stringContaining("WITH RECURSIVE inherited_roles"),
    );
    expect(scripted.managedRoleEvents).not.toContain(
      "CREATE dasher_retention_definer",
    );
  });

  it("rejects immutable canonical 0002 byte drift before catalog validation or role creation", async () => {
    const series = await canonical0002Series();
    await writeFile(
      join(series.directory, "0002_security_boundary.sql"),
      `${String(
        await readFile(
          join(canonicalMigrationDirectory, "0002_security_boundary.sql"),
        ),
      )}\n-- drift\n`,
    );
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).rejects.toMatchObject({ code: "migration_file_mismatch" });
    expect(scripted.queryTexts).not.toContainEqual(
      expect.stringContaining("WITH RECURSIVE inherited_roles"),
    );
  });

  it("leaves the exact committed pair after modeled SQL failure and accepts a same-file retry", async () => {
    const series = await modeledSuccessorSeries();
    const scripted = scriptedMigrationClient({
      failure: { stage: "migration", transaction: 3 },
      initialJournalRows: series.journalRows,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).rejects.toBe(scripted.operationError);
    expect(scripted.managedRoleEvents).toContain(
      "CREATE dasher_retention_definer",
    );
    expect(transactionCommands(scripted, 2).at(-1)).toBe("T2 COMMIT");
    expect(transactionCommands(scripted, 3).at(-1)).toBe("T3 ROLLBACK");

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).resolves.toMatchObject({ appliedCount: 1, previouslyAppliedCount: 2 });
    expect(
      scripted.managedRoleEvents.filter(
        (event) => event === "CREATE dasher_retention_definer",
      ),
    ).toHaveLength(1);
  });

  it("rolls back modeled SQL and journal when the successor catalog matrix drifts", async () => {
    const series = await modeledSuccessorSeries();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
      successorCatalogMatches: false,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
    expect(transactionCommands(scripted, 2).at(-1)).toBe("T2 COMMIT");
    expect(transactionCommands(scripted, 3)).toContain("T3 MIGRATION SQL");
    expect(transactionCommands(scripted, 3)).toContain("T3 JOURNAL INSERT");
    expect(transactionCommands(scripted, 3).at(-1)).toBe("T3 ROLLBACK");
    expect(scripted.managedRoleEvents).not.toContain(
      "DROP dasher_retention_operator",
    );
  });

  it("explicitly resets only the exact owner-validated dependency-free pair in safe order", async () => {
    const series = await canonical0002Series();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
      retentionRoleNames: [
        "dasher_retention_definer",
        "dasher_retention_operator",
      ],
    });

    await expect(
      resetPreparedRetentionRoles(
        singleClientPool(scripted.client),
        series.directory,
        [],
      ),
    ).resolves.toBeUndefined();
    expect(
      scripted.managedRoleEvents.filter((event) => event.startsWith("DROP ")),
    ).toEqual([
      "DROP dasher_retention_operator",
      "DROP dasher_retention_definer",
    ]);
  });

  it("refuses reset for partial roles, dependencies, or a pending different 0003 without dropping anything", async () => {
    const series = await canonical0002Series();
    const cases: readonly ScriptedMigrationOptions[] = [
      {
        initialJournalRows: series.journalRows,
        retentionRoleNames: ["dasher_retention_definer"],
      },
      {
        dependencyMatches: [false],
        initialJournalRows: series.journalRows,
        retentionRoleNames: [
          "dasher_retention_definer",
          "dasher_retention_operator",
        ],
      },
    ];

    for (const options of cases) {
      const scripted = scriptedMigrationClient(options);
      await expect(
        resetPreparedRetentionRoles(
          singleClientPool(scripted.client),
          series.directory,
          [],
        ),
      ).rejects.toMatchObject({ code: "managed_role_drift" });
      expect(
        scripted.managedRoleEvents.some((event) => event.startsWith("DROP ")),
      ).toBe(false);
    }

    await writeFile(
      join(series.directory, "0003_immutable_content.sql"),
      "SELECT 3003;\n",
    );
    const different = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
      retentionRoleNames: [
        "dasher_retention_definer",
        "dasher_retention_operator",
      ],
    });
    await expect(
      resetPreparedRetentionRoles(
        singleClientPool(different.client),
        series.directory,
        [],
      ),
    ).rejects.toMatchObject({ code: "migration_file_mismatch" });
    expect(
      different.managedRoleEvents.some((event) => event.startsWith("DROP ")),
    ).toBe(false);
  });

  it.each([
    {
      name: "duplicate",
      roleNames: ["dasher_test_login", "dasher_test_login"],
    },
    { name: "managed role", roleNames: ["dasher_app"] },
    { name: "empty name", roleNames: [""] },
    { name: "control byte", roleNames: ["dasher_test_\nlogin"] },
    { name: "overlength", roleNames: ["x".repeat(64)] },
  ])(
    "rejects $name expected-login input before connecting",
    async ({ roleNames }) => {
      let connections = 0;
      const pool: MigrationPool = {
        async connect() {
          connections += 1;
          throw new Error("unexpected connection");
        },
      };

      const failure = await capturedFailure(
        runMigrations(pool, fixtureDirectory, roleNames),
      );

      expect(failure).toMatchObject({ code: "managed_role_drift" });
      expect(connections).toBe(0);
    },
  );

  it("keeps the managed-role dependency inventory empty through a noncanonical pre-0002 prefix", async () => {
    const scripted = scriptedMigrationClient();

    await runMigrations(
      singleClientPool(scripted.client),
      fixtureDirectory,
      [],
    );

    expect(scripted.dependencyRoleNames).toHaveLength(3);
    expect(
      scripted.dependencyRoleNames.every((roleNames) =>
        arraysEqualForTest(roleNames, expectedManagedDependencyRoleNames),
      ),
    ).toBe(true);
    expect(scripted.dependencyInventories).toEqual([[], [], []]);
  });

  it("accepts one exact expected login and carries only its role name into validation", async () => {
    const loginName = "dasher_test_00000000000000000000000000000000";
    const scripted = scriptedMigrationClient({
      expectedLoginRows: [expectedLoginRow()],
      membershipRows: [expectedMembershipRow],
    });

    await runMigrations(singleClientPool(scripted.client), fixtureDirectory, [
      loginName,
    ]);

    expect(scripted.dependencyRoleNames).toHaveLength(3);
    expect(
      scripted.dependencyRoleNames.every((roleNames) =>
        arraysEqualForTest(roleNames, [
          ...expectedManagedDependencyRoleNames,
          loginName,
        ]),
      ),
    ).toBe(true);
    for (const inventory of scripted.dependencyInventories) {
      expect(inventory).toEqual([
        expect.objectContaining({
          database_oid: "0",
          dependency_type: "a",
          grantor_name: "migration_owner",
          object_kind: "database",
          object_name: "dasher_test",
          privilege_type: "CONNECT",
          role_name: loginName,
        }),
      ]);
      expect(JSON.stringify(inventory)).not.toContain("password");
      expect(JSON.stringify(inventory)).not.toContain("postgres://");
    }
    const loginCatalogQuery = scripted.queryTexts.find((text) =>
      text.includes("WITH expected(role_name) AS"),
    );
    expect(loginCatalogQuery).toContain(
      "role.rolpassword LIKE 'SCRAM-SHA-256$%'",
    );
    expect(loginCatalogQuery).not.toMatch(/role[.]rolpassword\s+AS/iu);
  });

  it("accepts multiple legal Unicode logins when login and membership rows use unrelated orders", async () => {
    const loginNames = ["z_login", "é_login", "Ω_login"];
    const scripted = scriptedMigrationClient({
      expectedLoginRows: [
        expectedLoginRow({ role_name: "Ω_login" }),
        expectedLoginRow({ role_name: "z_login" }),
        expectedLoginRow({ role_name: "é_login" }),
      ],
      membershipRows: [
        expectedMembershipRowFor("é_login"),
        expectedMembershipRowFor("Ω_login"),
        expectedMembershipRowFor("z_login"),
      ],
    });

    await expect(
      runMigrations(
        singleClientPool(scripted.client),
        fixtureDirectory,
        loginNames,
      ),
    ).resolves.toEqual({
      appliedCount: 2,
      discoveredCount: 2,
      previouslyAppliedCount: 0,
    });
    expect(scripted.dependencyInventories).toHaveLength(3);
    expect(
      scripted.dependencyInventories.every(
        (inventory) =>
          inventory.length === 3 &&
          loginNames.every((roleName) =>
            inventory.some((entry) => entry.role_name === roleName),
          ),
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "duplicate result row",
      rows: [expectedLoginRow(), expectedLoginRow()],
    },
    {
      name: "unexpected result row",
      rows: [
        expectedLoginRow(),
        expectedLoginRow({ role_name: "unexpected_login" }),
      ],
    },
  ])("rejects expected-login row multiset drift: $name", async ({ rows }) => {
    const scripted = scriptedMigrationClient({
      expectedLoginRows: rows,
      membershipRows: [expectedMembershipRow],
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, [
        "dasher_test_00000000000000000000000000000000",
      ]),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
  });

  it.each([
    { name: "absent role", rows: [] },
    {
      name: "wrong marker",
      rows: [expectedLoginRow({ comment: "wrong" })],
    },
    {
      name: "wrong database marker",
      rows: [
        expectedLoginRow({
          comment: "dasher:app-login:v1:database-oid:99999",
        }),
      ],
    },
    {
      name: "non-login",
      rows: [expectedLoginRow({ can_login: false })],
    },
    {
      name: "INHERIT",
      rows: [expectedLoginRow({ inherit_privileges: true })],
    },
    {
      name: "superuser",
      rows: [expectedLoginRow({ superuser: true })],
    },
    {
      name: "CREATEDB",
      rows: [expectedLoginRow({ can_create_database: true })],
    },
    {
      name: "CREATEROLE",
      rows: [expectedLoginRow({ can_create_role: true })],
    },
    {
      name: "replication",
      rows: [expectedLoginRow({ replication: true })],
    },
    {
      name: "BYPASSRLS",
      rows: [expectedLoginRow({ bypass_rls: true })],
    },
    {
      name: "missing SCRAM verifier",
      rows: [expectedLoginRow({ password_is_scram: false })],
    },
    {
      name: "role setting",
      rows: [expectedLoginRow({ has_settings: true })],
    },
    {
      name: "connection limit",
      rows: [expectedLoginRow({ connection_limit: 2 })],
    },
    {
      name: "password expiry",
      rows: [expectedLoginRow({ valid_until_is_null: false })],
    },
  ])("rejects expected login state drift: $name", async ({ rows }) => {
    const scripted = scriptedMigrationClient({
      expectedLoginRows: rows,
      membershipRows: [expectedMembershipRow],
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, [
        "dasher_test_00000000000000000000000000000000",
      ]),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
  });

  it.each([
    {
      name: "missing membership",
      rows: [],
    },
    {
      name: "duplicate membership",
      rows: [expectedMembershipRow, expectedMembershipRow],
    },
    {
      name: "inherit option",
      rows: [{ ...expectedMembershipRow, inherit_option: true }],
    },
    {
      name: "set option",
      rows: [{ ...expectedMembershipRow, set_option: false }],
    },
    {
      name: "admin option",
      rows: [{ ...expectedMembershipRow, admin_option: true }],
    },
    {
      name: "managed role outgoing edge",
      rows: [
        expectedMembershipRow,
        {
          ...expectedMembershipRow,
          granted_role_name: "synthetic_parent",
          member_role_name: "dasher_app",
        },
      ],
    },
    {
      name: "definer incoming edge",
      rows: [
        expectedMembershipRow,
        {
          ...expectedMembershipRow,
          granted_role_name: "dasher_security_definer",
          member_role_name: "synthetic_member",
        },
      ],
    },
    {
      name: "definer outgoing edge",
      rows: [
        expectedMembershipRow,
        {
          ...expectedMembershipRow,
          granted_role_name: "synthetic_parent",
          member_role_name: "dasher_security_definer",
        },
      ],
    },
    {
      name: "unexpected app member",
      rows: [
        expectedMembershipRow,
        {
          ...expectedMembershipRow,
          member_role_name: "synthetic_member",
        },
      ],
    },
  ])("rejects managed membership drift: $name", async ({ rows }) => {
    const scripted = scriptedMigrationClient({
      expectedLoginRows: [expectedLoginRow()],
      membershipRows: rows,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, [
        "dasher_test_00000000000000000000000000000000",
      ]),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
  });

  it("derives the closed validated-0002 inventory with all sixteen exact function signatures", async () => {
    const series = await securityBoundarySeries();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).resolves.toMatchObject({
      appliedCount: 0,
      previouslyAppliedCount: 2,
    });

    expect(scripted.dependencyInventories).toHaveLength(3);
    const dependencyQuery = scripted.queryTexts.find(
      (text) =>
        text.includes("pg_catalog.jsonb_to_recordset") &&
        text.includes("FROM pg_catalog.pg_shdepend AS dependency"),
    );
    expect(dependencyQuery).toContain(
      "FROM pg_catalog.pg_shdepend AS dependency",
    );
    expect(dependencyQuery).toContain(
      "dependency.dbid = current_database_row.oid",
    );
    expect(dependencyQuery).toContain("dependency.dbid = 0");
    expect(dependencyQuery).toContain("'unresolved'::text AS object_kind");
    expect(dependencyQuery?.match(/EXCEPT ALL/gu)).toHaveLength(2);
    expect(
      dependencyQuery?.match(
        /pg_catalog[.]oidvectortypes[(]routine[.]proargtypes[)]/gu,
      ),
    ).toHaveLength(2);
    expect(dependencyQuery).not.toContain(
      "pg_catalog.pg_get_function_identity_arguments",
    );
    for (const inventory of scripted.dependencyInventories) {
      expect(inventory).toHaveLength(217);
      const ownedFunctions = inventory.filter(
        (entry) =>
          entry.object_kind === "function" && entry.dependency_type === "o",
      );
      const executableFunctions = inventory.filter(
        (entry) =>
          entry.object_kind === "function" &&
          entry.dependency_type === "a" &&
          entry.privilege_type === "EXECUTE",
      );
      expect(ownedFunctions).toHaveLength(16);
      expect(executableFunctions).toHaveLength(16);
      expect(
        executableFunctions.every(
          (entry) =>
            entry.grantor_name === "dasher_security_definer" &&
            entry.role_name === "dasher_app",
        ),
      ).toBe(true);
      expect(inventory).toContainEqual(
        expect.objectContaining({
          dependency_type: "a",
          object_kind: "schema",
          object_name: "dasher_private",
          privilege_type: "USAGE",
          role_name: "dasher_security_definer",
          schema_name: "dasher_private",
        }),
      );
      expect(inventory).not.toContainEqual(
        expect.objectContaining({
          object_kind: "schema",
          object_name: "dasher_private",
          role_name: "dasher_app",
        }),
      );
      expect(
        ownedFunctions
          .map(
            (entry) =>
              `${String(entry.schema_name)}.${String(entry.object_name)}(${String(
                entry.function_arguments,
              )})`,
          )
          .sort(),
      ).toEqual([
        "dasher_api.accept_invitation(smallint, bytea, text, text, text, boolean, uuid, uuid, uuid, smallint, bytea, smallint, bytea, uuid, uuid, text)",
        "dasher_api.change_membership_role(uuid, text, uuid, smallint, bytea, text)",
        "dasher_api.initialize_context(smallint, bytea, uuid)",
        "dasher_api.issue_invitation(uuid, text, text, smallint, bytea, uuid, smallint, bytea, smallint, bytea, uuid, text)",
        "dasher_api.issue_session(text, text, uuid, uuid, smallint, bytea, smallint, bytea, uuid, uuid, text)",
        "dasher_api.revoke_invitation(uuid, uuid, smallint, bytea, smallint, bytea, uuid, text)",
        "dasher_api.revoke_membership(uuid, uuid, smallint, bytea, text)",
        "dasher_api.revoke_session(uuid, uuid, smallint, bytea, text)",
        "dasher_api.rotate_session(uuid, smallint, bytea, smallint, bytea, uuid, smallint, bytea, text)",
        "dasher_private.context_allows(uuid, text)",
        "dasher_private.context_authority_revision()",
        "dasher_private.context_membership_id()",
        "dasher_private.context_organization_id()",
        "dasher_private.context_request_id()",
        "dasher_private.context_session_id()",
        "dasher_private.context_user_id()",
      ]);
    }
  });

  it("checks the validated prefix before SQL and the successor prefix after journal insertion", async () => {
    const series = await securityBoundarySeries();
    const scripted = scriptedMigrationClient({
      initialJournalRows: [series.journalRows[0]!],
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).resolves.toMatchObject({
      appliedCount: 1,
      previouslyAppliedCount: 1,
    });

    expect(scripted.dependencyInventories).toHaveLength(3);
    expect(scripted.dependencyInventories[0]).toEqual([]);
    expect(scripted.dependencyInventories[1]).toEqual([]);
    expect(scripted.dependencyInventories[2]).toHaveLength(217);
    expect(transactionCommands(scripted, 2)).toContain("T2 MIGRATION SQL");
    expect(transactionCommands(scripted, 2)).toContain("T2 JOURNAL INSERT");
  });

  it.each([
    "missing dependency",
    "extra dependency",
    "wrong database",
    "wrong object kind",
    "wrong function signature",
    "wrong column subobject",
    "wrong privilege",
    "wrong grantor",
    "foreign owned object",
    "foreign ACL",
  ])("rejects simulated inventory drift: %s", async () => {
    const series = await securityBoundarySeries();
    const scripted = scriptedMigrationClient({
      dependencyMatches: [false],
      initialJournalRows: series.journalRows,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
    expect(transactionCommands(scripted, 2)).not.toContain("T2 MIGRATION SQL");
  });

  it("rejects a mismatched successor inventory after applying and journaling pending SQL", async () => {
    const series = await securityBoundarySeries();
    const scripted = scriptedMigrationClient({
      dependencyMatches: [true, true, false],
      initialJournalRows: [series.journalRows[0]!],
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
    expect(transactionCommands(scripted, 2)).toContain("T2 MIGRATION SQL");
    expect(transactionCommands(scripted, 2)).toContain("T2 JOURNAL INSERT");
    expect(transactionCommands(scripted, 2).at(-1)).toBe("T2 ROLLBACK");
  });
});

describe("migration transaction rollback and release", () => {
  it("normally releases when the session gate cannot be acquired", async () => {
    const lockError = new Error("synthetic session gate acquisition failure");
    const scripted = scriptedMigrationClient({ sessionLockError: lockError });

    await expect(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, []),
    ).rejects.toBe(lockError);
    expect(scripted.transactionCommands).toEqual(["SESSION ADVISORY LOCK"]);
    expect(scripted.releaseArguments).toEqual([undefined]);
  });

  it("destroys the client with a sanitized diagnostic when session unlock returns false", async () => {
    const scripted = scriptedMigrationClient({ sessionUnlockResult: false });

    const failure = await capturedFailure(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, []),
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("MigrationGateReleaseError");
    expect((failure as Error).message).toBe(
      "PostgreSQL migrator advisory gate release failed; pooled client destroyed",
    );
    expect(scripted.releaseArguments).toEqual([failure]);
    expect(scripted.releaseArguments).not.toContain(undefined);
  });

  it("preserves the operation error and destroys the client if unlock then fails", async () => {
    const unlockError = new Error(
      "synthetic unlock failure with postgres://user:secret@host/database",
    );
    const scripted = scriptedMigrationClient({
      failure: { stage: "validation", transaction: 1 },
      sessionUnlockError: unlockError,
    });

    const failure = await capturedFailure(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, []),
    );
    expect(failure).toBe(scripted.operationError);
    expect(scripted.releaseArguments).toHaveLength(1);
    const releaseError = scripted.releaseArguments[0];
    expect(releaseError).toBeInstanceOf(Error);
    expect((releaseError as Error).name).toBe("MigrationGateReleaseError");
    expect(String(releaseError)).not.toContain("postgres://");
    expect(scripted.releaseArguments).not.toContain(undefined);
  });

  it.each(transactionFailureCases)(
    "normally releases after $name failure and successful rollback",
    async (failureInjection) => {
      const scripted = scriptedMigrationClient({
        failure: failureInjection,
      });
      const failure = await capturedFailure(
        runMigrations(singleClientPool(scripted.client), fixtureDirectory, []),
      );

      expect(failure).toBe(scripted.operationError);
      expect(scripted.operationError).toBeInstanceOf(Error);
      expect((scripted.operationError as Error).cause).toBeUndefined();
      expect(scripted.rollbackQueries).toBe(1);
      expect(scripted.releaseArguments).toEqual([undefined]);
      expectFailureCommandOrder(scripted, failureInjection);
    },
  );

  it.each(transactionFailureCases)(
    "destructively releases after $name failure and rejected rollback",
    async (failureInjection) => {
      const scripted = scriptedMigrationClient({
        failure: failureInjection,
        rollbackFails: true,
      });
      const failure = await capturedFailure(
        runMigrations(singleClientPool(scripted.client), fixtureDirectory, []),
      );

      expect(failure).toBe(scripted.operationError);
      expect(scripted.rollbackQueries).toBe(1);
      expectSanitizedDestructiveRelease(scripted);
      expectFailureCommandOrder(scripted, failureInjection);
    },
  );

  it("commits both transactions and normally releases exactly once", async () => {
    const scripted = scriptedMigrationClient();

    await expect(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, []),
    ).resolves.toEqual({
      appliedCount: 2,
      discoveredCount: 2,
      previouslyAppliedCount: 0,
    });

    expect(scripted.rollbackQueries).toBe(0);
    expect(scripted.releaseArguments).toEqual([undefined]);
    expect(transactionCommands(scripted, 1)).toEqual([
      "T1 BEGIN",
      "T1 SET LOCAL",
      "T1 CATALOG VALIDATION",
      "T1 COMMIT",
    ]);
    expect(transactionCommands(scripted, 2)).toEqual([
      "T2 BEGIN",
      "T2 SET LOCAL",
      "T2 CATALOG VALIDATION",
      "T2 MIGRATION SQL",
      "T2 JOURNAL INSERT",
      "T2 MIGRATION SQL",
      "T2 JOURNAL INSERT",
      "T2 CATALOG VALIDATION",
      "T2 COMMIT",
    ]);
    expect(scripted.transactionCommands[0]).toBe("SESSION ADVISORY LOCK");
    expect(scripted.transactionCommands.at(-1)).toBe("SESSION ADVISORY UNLOCK");
  });

  it("does not retry normal release when destructive release throws", async () => {
    const failureInjection = {
      stage: "commit",
      transaction: 2,
    } as const;
    const scripted = scriptedMigrationClient({
      destructiveReleaseThrows: true,
      failure: failureInjection,
      rollbackFails: true,
    });

    const failure = await capturedFailure(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, []),
    );

    expect(failure).toBe(scripted.operationError);
    expect(failure).not.toBe(scripted.destructiveReleaseError);
    expect(scripted.rollbackQueries).toBe(1);
    expectSanitizedDestructiveRelease(scripted);
    expectFailureCommandOrder(scripted, failureInjection);
  });

  it("preserves an operation failure when normal release throws after rollback", async () => {
    const failureInjection = {
      stage: "journal",
      transaction: 2,
    } as const;
    const scripted = scriptedMigrationClient({
      failure: failureInjection,
      normalReleaseThrows: true,
    });

    const failure = await capturedFailure(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, []),
    );

    expect(failure).toBe(scripted.operationError);
    expect(failure).not.toBe(scripted.normalReleaseError);
    expect(scripted.rollbackQueries).toBe(1);
    expect(scripted.releaseArguments).toEqual([undefined]);
    expectFailureCommandOrder(scripted, failureInjection);
  });

  it("returns a normal release error after a successful migration", async () => {
    const scripted = scriptedMigrationClient({
      normalReleaseThrows: true,
    });

    const failure = await capturedFailure(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, []),
    );

    expect(failure).toBe(scripted.normalReleaseError);
    expect(scripted.rollbackQueries).toBe(0);
    expect(scripted.releaseArguments).toEqual([undefined]);
    expect(transactionCommands(scripted, 1).slice(0, 3)).toEqual([
      "T1 BEGIN",
      "T1 SET LOCAL",
      "T1 CATALOG VALIDATION",
    ]);
    expect(transactionCommands(scripted, 2).slice(0, 3)).toEqual([
      "T2 BEGIN",
      "T2 SET LOCAL",
      "T2 CATALOG VALIDATION",
    ]);
    expect(transactionCommands(scripted, 1).at(-1)).toBe("T1 COMMIT");
    expect(transactionCommands(scripted, 2).at(-1)).toBe("T2 COMMIT");
  });

  it("destructively releases after rollback failure for a hostile Proxy throw", async () => {
    const proxyTrapError = new Error(
      "synthetic getPrototypeOf trap with raw proxy details",
    );
    const hostileOperationError = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw proxyTrapError;
        },
      },
    );
    const failureInjection = {
      stage: "validation",
      transaction: 2,
    } as const;
    const scripted = scriptedMigrationClient({
      failure: failureInjection,
      operationError: hostileOperationError,
      rollbackFails: true,
    });

    const failure = await capturedFailure(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, []),
    );

    expect(Object.is(failure, hostileOperationError)).toBe(true);
    expect(Object.is(failure, proxyTrapError)).toBe(false);
    expect(scripted.rollbackQueries).toBe(1);
    expect(scripted.releaseArguments).toHaveLength(1);
    const releaseError = scripted.releaseArguments[0];
    expect(releaseError).toBeInstanceOf(Error);
    expect(releaseError).not.toBe(scripted.rollbackError);
    expect(releaseError).not.toBe(proxyTrapError);
    expect((releaseError as Error).message).toBe(
      "PostgreSQL transaction rollback failed; pooled client destroyed",
    );
    const diagnostic = `${(releaseError as Error).name}:${
      (releaseError as Error).message
    }\n${(releaseError as Error).stack ?? ""}`;
    expect(diagnostic).not.toContain("getPrototypeOf trap");
    expect(diagnostic).not.toContain("raw proxy details");
    expect(diagnostic).not.toContain("postgres://");
    expect(diagnostic).not.toContain("SELECT secret");
    expect(scripted.releaseArguments).not.toContain(undefined);
    expectFailureCommandOrder(scripted, failureInjection);
  });
});
