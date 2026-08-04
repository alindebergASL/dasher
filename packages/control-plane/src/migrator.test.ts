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
import { isDeepStrictEqual } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import {
  MigrationContractError,
  bootstrapManagedRoles,
  discoverMigrations,
  getCanonical0003ExactCatalogContractForTests,
  getCanonical0004ExactCatalogContractForTests,
  getCanonical0005ExactCatalogContractForTests,
  getCanonical0006ExactCatalogContractForTests,
  getModeled0003StaticCatalogContractForTests,
  resetPreparedRetentionRoles,
  runMigrations,
  type MigrationClient,
  type MigrationPool,
} from "./migrator.js";
import { modeled0003CatalogMatrix } from "../test/fixtures/migrations-0003-allowlist/modeled-0003-inventory.js";

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

function independentModeled0003CatalogContract() {
  return {
    schemas: modeled0003CatalogMatrix.schemas,
    relations: modeled0003CatalogMatrix.relationCatalog,
    columns: modeled0003CatalogMatrix.columns,
    types: modeled0003CatalogMatrix.types,
    sequences: modeled0003CatalogMatrix.sequences,
    indexes: modeled0003CatalogMatrix.indexes,
    constraints: modeled0003CatalogMatrix.constraints,
    triggers: modeled0003CatalogMatrix.triggers,
    policies: modeled0003CatalogMatrix.policies,
    functions: modeled0003CatalogMatrix.functions,
    relationAcls: modeled0003CatalogMatrix.catalogRelationAcls,
    columnAcls: modeled0003CatalogMatrix.catalogColumnAcls,
    functionExecuteGrants: modeled0003CatalogMatrix.functionExecuteGrants,
    comments: modeled0003CatalogMatrix.comments,
    defaultAcls: modeled0003CatalogMatrix.defaultAcls,
    ownershipDependencyRows: modeled0003CatalogMatrix.ownershipDependencyRows,
    aclDependencyRows: modeled0003CatalogMatrix.aclDependencyRows,
    policyDependencyRows: modeled0003CatalogMatrix.policyDependencyRows,
  };
}

type Modeled0003CatalogContract = ReturnType<
  typeof independentModeled0003CatalogContract
>;

function catalogContractMismatchDimensions(
  expected: Modeled0003CatalogContract,
  candidate: unknown,
): readonly string[] {
  if (candidate === null || typeof candidate !== "object") {
    return ["contract"];
  }
  const candidateContract = candidate as Record<string, unknown>;
  const expectedDimensions = Object.keys(
    expected,
  ) as (keyof Modeled0003CatalogContract)[];
  const unexpectedDimensions = Object.keys(candidateContract).filter(
    (dimension) => !(dimension in expected),
  );
  return [
    ...expectedDimensions.filter(
      (dimension) =>
        !isDeepStrictEqual(expected[dimension], candidateContract[dimension]),
    ),
    ...unexpectedDimensions,
  ];
}

type FailureStage =
  | "advisory"
  | "begin"
  | "catalog"
  | "commit"
  | "journal"
  | "migration"
  | "set-local"
  | "validation";

interface FailureInjection {
  readonly stage: FailureStage;
  readonly transaction: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
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
  readonly expectedRetentionLoginRows?: readonly Record<string, unknown>[];
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
  readonly lifecycleCorrectionCatalogMatches?: boolean;
  readonly phase6CatalogCandidate?: Readonly<Record<string, readonly string[]>>;
  readonly phase6CatalogMatches?: boolean;
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
  readonly canonicalSuccessorSideEffectPresent: boolean;
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
  readonly catalogContracts: readonly Record<string, readonly string[]>[];
  readonly journalRows: readonly Record<string, unknown>[];
  readonly lifecycleCorrectionSideEffectPresent: boolean;
  readonly phase6CorrectionSideEffectPresent: boolean;
  readonly phase6FunctionReplacements: readonly string[];
  readonly phase6PolicyReplacements: readonly string[];
  readonly phase6ColumnAclPresent: boolean;
  readonly modeledSuccessorSideEffectPresent: boolean;
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
  const catalogContracts: Record<string, readonly string[]>[] = [];
  const journalRows = [...(options.initialJournalRows ?? [])];
  const managedRoleReadCounts: Record<ManagedRoleName, number> = {
    dasher_app: 0,
    dasher_retention_definer: 0,
    dasher_retention_operator: 0,
    dasher_security_definer: 0,
  };
  const createdPreparedRoles = new Set<string>();
  const droppedPreparedRoles = new Set<string>();
  let modeledSuccessorSideEffectPresent = false;
  let canonicalSuccessorSideEffectPresent = false;
  let lifecycleCorrectionSideEffectPresent = false;
  let phase6CorrectionSideEffectPresent = false;
  let phase6FunctionReplacements: string[] = [];
  let phase6PolicyReplacements: string[] = [];
  let phase6ColumnAclPresent = false;
  let transactionSnapshot:
    | {
        readonly canonicalSuccessorSideEffectPresent: boolean;
        readonly createdPreparedRoles: readonly string[];
        readonly droppedPreparedRoles: readonly string[];
        readonly journalRows: readonly (typeof journalRows)[number][];
        readonly lifecycleCorrectionSideEffectPresent: boolean;
        readonly phase6CorrectionSideEffectPresent: boolean;
        readonly phase6FunctionReplacements: readonly string[];
        readonly phase6PolicyReplacements: readonly string[];
        readonly phase6ColumnAclPresent: boolean;
        readonly modeledSuccessorSideEffectPresent: boolean;
      }
    | undefined;
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
      transactionSnapshot = {
        canonicalSuccessorSideEffectPresent,
        createdPreparedRoles: [...createdPreparedRoles],
        droppedPreparedRoles: [...droppedPreparedRoles],
        journalRows: journalRows.map((row) => ({ ...row })),
        lifecycleCorrectionSideEffectPresent,
        phase6CorrectionSideEffectPresent,
        phase6FunctionReplacements: [...phase6FunctionReplacements],
        phase6PolicyReplacements: [...phase6PolicyReplacements],
        phase6ColumnAclPresent,
        modeledSuccessorSideEffectPresent,
      };
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
      transactionSnapshot = undefined;
      return result([]);
    }
    if (text === "ROLLBACK") {
      command("ROLLBACK");
      rollbackQueries += 1;
      if (options.rollbackFails === true) {
        throw rollbackError;
      }
      if (transactionSnapshot !== undefined) {
        journalRows.splice(
          0,
          journalRows.length,
          ...transactionSnapshot.journalRows.map((row) => ({ ...row })),
        );
        createdPreparedRoles.clear();
        for (const roleName of transactionSnapshot.createdPreparedRoles) {
          createdPreparedRoles.add(roleName);
        }
        droppedPreparedRoles.clear();
        for (const roleName of transactionSnapshot.droppedPreparedRoles) {
          droppedPreparedRoles.add(roleName);
        }
        modeledSuccessorSideEffectPresent =
          transactionSnapshot.modeledSuccessorSideEffectPresent;
        canonicalSuccessorSideEffectPresent =
          transactionSnapshot.canonicalSuccessorSideEffectPresent;
        lifecycleCorrectionSideEffectPresent =
          transactionSnapshot.lifecycleCorrectionSideEffectPresent;
        phase6CorrectionSideEffectPresent =
          transactionSnapshot.phase6CorrectionSideEffectPresent;
        phase6FunctionReplacements = [
          ...transactionSnapshot.phase6FunctionReplacements,
        ];
        phase6PolicyReplacements = [
          ...transactionSnapshot.phase6PolicyReplacements,
        ];
        phase6ColumnAclPresent = transactionSnapshot.phase6ColumnAclPresent;
        transactionSnapshot = undefined;
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
      return result(
        values?.[1] === "retention-login"
          ? (options.expectedRetentionLoginRows ?? [])
          : (options.expectedLoginRows ?? []),
      );
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
    if (text.includes("signature_catalog AS")) {
      const contract = JSON.parse(values?.[0] as string) as Record<
        string,
        readonly string[]
      >;
      catalogContracts.push(contract);
      expect(values).toHaveLength(2);
      const isSuccessor = (contract.relations ?? []).some((signature) =>
        signature.includes("|dashboards|"),
      );
      const isLifecycleCorrection = (contract.types ?? []).some((signature) =>
        signature.includes("|dashboard_creation_result|"),
      );
      const isPhase6Correction = (contract.functions ?? []).some((signature) =>
        signature.endsWith("059c7ab3e72146897a750ff61e115e44"),
      );
      const phase6CandidateMatches =
        isPhase6Correction && options.phase6CatalogCandidate !== undefined
          ? isDeepStrictEqual(contract, options.phase6CatalogCandidate)
          : undefined;
      const explicitMatch = isPhase6Correction
        ? (phase6CandidateMatches ??
          options.phase6CatalogMatches ??
          options.lifecycleCorrectionCatalogMatches ??
          options.successorCatalogMatches ??
          options.prefixObjectMatches)
        : isLifecycleCorrection
          ? (options.lifecycleCorrectionCatalogMatches ??
            options.successorCatalogMatches ??
            options.prefixObjectMatches)
          : isSuccessor
            ? (options.successorCatalogMatches ?? options.prefixObjectMatches)
            : options.prefixObjectMatches;
      if (explicitMatch === undefined) {
        throw new Error("scripted catalog matching must be explicit");
      }
      if (isPhase6Correction) {
        failAt("catalog");
      }
      return result([
        {
          matches: explicitMatch,
        },
      ]);
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
      text.includes("modeled_successor_inventory_version") ||
      text.includes("-- Dasher immutable-content and lifecycle successor.") ||
      text.includes("-- Dasher lifecycle API correction successor.") ||
      text.includes(
        "-- Dasher security-definer cleanup-coordination authority correction.",
      ) ||
      text.startsWith(
        "CREATE OR REPLACE FUNCTION dasher_api.get_dashboard_admin_status(uuid)",
      )
    ) {
      command("MIGRATION SQL");
      if (text.includes("modeled_successor_inventory_version")) {
        modeledSuccessorSideEffectPresent = true;
      }
      if (
        text.includes("-- Dasher immutable-content and lifecycle successor.")
      ) {
        canonicalSuccessorSideEffectPresent = true;
      }
      if (text.includes("-- Dasher lifecycle API correction successor.")) {
        lifecycleCorrectionSideEffectPresent = true;
      }
      if (
        text.startsWith(
          "CREATE OR REPLACE FUNCTION dasher_api.get_dashboard_admin_status(uuid)",
        )
      ) {
        phase6CorrectionSideEffectPresent = true;
        phase6FunctionReplacements = [
          ...text.matchAll(
            /^CREATE OR REPLACE FUNCTION ([a-z_]+[.][a-z_]+\([^\n]*\))$/gmu,
          ),
        ].map((match) => match[1]!);
        phase6PolicyReplacements = [
          ...text.matchAll(/^CREATE POLICY ([a-z_]+)$/gmu),
        ].map((match) => match[1]!);
        phase6ColumnAclPresent =
          /GRANT UPDATE \(head_version_id\) ON TABLE dasher[.]dashboards\s+TO dasher_retention_definer;/u.test(
            text,
          );
      }
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
    get canonicalSuccessorSideEffectPresent() {
      return canonicalSuccessorSideEffectPresent;
    },
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
    catalogContracts,
    get journalRows() {
      return journalRows;
    },
    get lifecycleCorrectionSideEffectPresent() {
      return lifecycleCorrectionSideEffectPresent;
    },
    get phase6CorrectionSideEffectPresent() {
      return phase6CorrectionSideEffectPresent;
    },
    get phase6FunctionReplacements() {
      return phase6FunctionReplacements;
    },
    get phase6PolicyReplacements() {
      return phase6PolicyReplacements;
    },
    get phase6ColumnAclPresent() {
      return phase6ColumnAclPresent;
    },
    get modeledSuccessorSideEffectPresent() {
      return modeledSuccessorSideEffectPresent;
    },
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

function expectExactlyOneSuccessfulSessionGate(
  scripted: ScriptedMigrationClient,
): void {
  expect(
    scripted.queryTexts.filter((text) =>
      text.includes("pg_catalog.pg_advisory_lock("),
    ),
  ).toHaveLength(1);
  expect(
    scripted.queryTexts.filter((text) =>
      text.includes("pg_catalog.pg_advisory_unlock("),
    ),
  ).toHaveLength(1);
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
  transaction: FailureInjection["transaction"],
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
    catalog: "CATALOG VALIDATION",
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

async function canonicalSuccessorSeries(): Promise<{
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
    "0003_immutable_content.sql",
  ] as const) {
    await writeFile(
      join(directory, filename),
      await readFile(join(canonicalMigrationDirectory, filename)),
    );
  }
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

async function canonicalLifecycleCorrectionSeries(): Promise<{
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
    "0003_immutable_content.sql",
    "0004_lifecycle_api_correction.sql",
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

async function canonicalPhase6Series(): Promise<{
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
    "0003_immutable_content.sql",
    "0004_lifecycle_api_correction.sql",
    "0005_security_definer_cleanup_coordination.sql",
    "0006_lifecycle_access_retention_guard_correction.sql",
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

function expectedRetentionLoginRow(
  roleName = "dasher_test_task8d_retention",
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return expectedLoginRow({
    comment: "dasher:retention-login:v1:database-oid:16384",
    role_name: roleName,
    ...overrides,
  });
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

function expectedRetentionMembershipRowFor(
  roleName: string,
): Readonly<Record<string, unknown>> {
  return {
    ...expectedMembershipRowFor(roleName),
    granted_role_name: "dasher_retention_operator",
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
  it("applies the clean canonical 0001-to-0003 series and reruns idempotently", async () => {
    const series = await canonicalSuccessorSeries();
    const scripted = scriptedMigrationClient({ prefixObjectMatches: true });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).resolves.toEqual({
      appliedCount: 3,
      discoveredCount: 3,
      previouslyAppliedCount: 0,
    });
    expect(scripted.journalRows).toHaveLength(3);
    expect(scripted.canonicalSuccessorSideEffectPresent).toBe(true);

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).resolves.toEqual({
      appliedCount: 0,
      discoveredCount: 3,
      previouslyAppliedCount: 3,
    });
    expect(scripted.journalRows).toHaveLength(3);
  });

  it("applies fresh canonical 0001-to-0004, upgrades exact journal 3, and reruns journal 4 idempotently", async () => {
    const freshSeries = await canonicalLifecycleCorrectionSeries();
    const fresh = scriptedMigrationClient({ prefixObjectMatches: true });

    await expect(
      runMigrations(singleClientPool(fresh.client), freshSeries.directory, []),
    ).resolves.toEqual({
      appliedCount: 4,
      discoveredCount: 4,
      previouslyAppliedCount: 0,
    });
    expect(fresh.journalRows).toHaveLength(4);
    expect(fresh.canonicalSuccessorSideEffectPresent).toBe(true);
    expect(fresh.lifecycleCorrectionSideEffectPresent).toBe(true);

    await expect(
      runMigrations(singleClientPool(fresh.client), freshSeries.directory, []),
    ).resolves.toEqual({
      appliedCount: 0,
      discoveredCount: 4,
      previouslyAppliedCount: 4,
    });
    expect(fresh.journalRows).toHaveLength(4);

    const upgrade = scriptedMigrationClient({
      initialJournalRows: freshSeries.journalRows.slice(0, 3),
      prefixObjectMatches: true,
      retentionRoleNames: [
        "dasher_retention_definer",
        "dasher_retention_operator",
      ],
    });
    await expect(
      runMigrations(
        singleClientPool(upgrade.client),
        freshSeries.directory,
        [],
      ),
    ).resolves.toEqual({
      appliedCount: 1,
      discoveredCount: 4,
      previouslyAppliedCount: 3,
    });
    expect(upgrade.journalRows).toHaveLength(4);
    expect(upgrade.canonicalSuccessorSideEffectPresent).toBe(false);
    expect(upgrade.lifecycleCorrectionSideEffectPresent).toBe(true);
    expect(
      upgrade.queryTexts.findIndex((text) =>
        text.includes("-- Dasher lifecycle API correction successor."),
      ),
    ).toBeGreaterThan(
      upgrade.queryTexts.findIndex((text) =>
        text.includes("signature_catalog"),
      ),
    );
  });

  it("keeps exact journal-3 and journal-4 catalog contracts independent and closes only the lifecycle deltas", async () => {
    const journal3 = getCanonical0003ExactCatalogContractForTests(
      "migration_owner",
    ) as Record<string, readonly string[]>;
    const journal4 = getCanonical0004ExactCatalogContractForTests(
      "migration_owner",
    ) as Record<string, readonly string[]>;

    expect(journal3.types).not.toContainEqual(
      expect.stringContaining("|dashboard_creation_result|"),
    );
    expect(journal3.functions).not.toContainEqual(
      expect.stringContaining("context_csrf_allows"),
    );
    expect(journal3.functions).toContainEqual(
      expect.stringContaining(
        "dasher_api.create_dashboard(uuid, text, text, integer, boolean, uuid, uuid, text)|",
      ),
    );
    expect(journal4.types).toContainEqual(
      expect.stringContaining(
        "|dashboard_creation_result|c|C|migration_owner|dashboard_creation_result|",
      ),
    );
    expect(journal4.types).toContainEqual(
      expect.stringMatching(
        /dashboard_lineage_projection[^\n]*artifact_ownership_class text/iu,
      ),
    );
    expect(journal4.types).not.toContainEqual(
      expect.stringContaining("restored_at_utc"),
    );
    expect(journal4.functions).toContainEqual(
      expect.stringContaining(
        "dasher_private.context_csrf_allows(smallint, bytea)|f|boolean|plpgsql|v|true|false|false|false|u|<none>|0|<none>|dasher_security_definer|{search_path=pg_catalog}|30922f8dde74601248d8a06d124ca30f",
      ),
    );
    expect(journal4.functions).not.toContainEqual(
      expect.stringContaining(
        "dasher_api.create_dashboard(uuid, text, text, integer, boolean, uuid, uuid, text)|",
      ),
    );
    expect(journal4.functions).toContainEqual(
      expect.stringContaining(
        "dasher_api.create_dashboard(uuid, text, text, integer, boolean, uuid, uuid, smallint, bytea, text)|f|dasher.dashboard_creation_result",
      ),
    );
    expect(
      journal4.acls?.filter(
        (acl) =>
          acl ===
            "relation|dasher.dashboard_cleanup_coordination|migration_owner|dasher_security_definer|SELECT|false" ||
          acl ===
            "relation|dasher.dashboard_legal_holds|migration_owner|dasher_security_definer|SELECT|false",
      ),
    ).toHaveLength(2);
  });

  it.each([
    ["SQL", "migration"],
    ["journal insertion", "journal"],
  ] as const)(
    "rolls back failed 0004 %s to the exact three-row prefix, then retries",
    async (_failureName, failureStage) => {
      const series = await canonicalLifecycleCorrectionSeries();
      const scripted = scriptedMigrationClient({
        failure: { stage: failureStage, transaction: 2 },
        initialJournalRows: series.journalRows.slice(0, 3),
        prefixObjectMatches: true,
        retentionRoleNames: [
          "dasher_retention_definer",
          "dasher_retention_operator",
        ],
      });

      await expect(
        runMigrations(singleClientPool(scripted.client), series.directory, []),
      ).rejects.toBe(scripted.operationError);
      expect(scripted.journalRows).toEqual(series.journalRows.slice(0, 3));
      expect(scripted.lifecycleCorrectionSideEffectPresent).toBe(false);
      expect(transactionCommands(scripted, 2).at(-1)).toBe("T2 ROLLBACK");

      await expect(
        runMigrations(singleClientPool(scripted.client), series.directory, []),
      ).resolves.toEqual({
        appliedCount: 1,
        discoveredCount: 4,
        previouslyAppliedCount: 3,
      });
      expect(scripted.journalRows).toHaveLength(4);
      expect(scripted.lifecycleCorrectionSideEffectPresent).toBe(true);
    },
  );

  it("applies exact five-file state through the full directory once and reruns phase 6 as a no-op", async () => {
    const series = await canonicalPhase6Series();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows.slice(0, 5),
      prefixObjectMatches: true,
      retentionRoleNames: [
        "dasher_retention_definer",
        "dasher_retention_operator",
      ],
    });
    const phase6Sql = await readFile(
      join(
        canonicalMigrationDirectory,
        "0006_lifecycle_access_retention_guard_correction.sql",
      ),
      "utf8",
    );

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).resolves.toEqual({
      appliedCount: 1,
      discoveredCount: 6,
      previouslyAppliedCount: 5,
    });
    expect(scripted.journalRows).toEqual(series.journalRows);
    expect(scripted.phase6CorrectionSideEffectPresent).toBe(true);
    expect(scripted.phase6FunctionReplacements).toEqual([
      "dasher_api.get_dashboard_admin_status(uuid)",
      "dasher_private.enforce_retention_mutation()",
    ]);
    expect(scripted.phase6PolicyReplacements).toEqual([
      "source_snapshots_retention_select",
      "source_snapshots_retention_delete",
      "evidence_records_retention_select",
      "evidence_records_retention_delete",
    ]);
    expect(scripted.phase6ColumnAclPresent).toBe(true);
    expect(scripted.catalogContracts).toContainEqual(
      getCanonical0005ExactCatalogContractForTests("migration_owner"),
    );
    const phase6Catalog = getCanonical0006ExactCatalogContractForTests(
      "migration_owner",
      phase6Sql,
    ) as Record<string, readonly string[]>;
    expect(scripted.catalogContracts).toContainEqual(phase6Catalog);
    const dependencyInventories = [
      ...new Map(
        scripted.dependencyInventories.map((inventory) => [
          JSON.stringify(inventory),
          inventory,
        ]),
      ).values(),
    ];
    expect(dependencyInventories).toHaveLength(2);
    const [phase5Dependencies, phase6Dependencies] = dependencyInventories.sort(
      (left, right) => left.length - right.length,
    );
    expect(phase6Dependencies).toHaveLength(
      (phase5Dependencies?.length ?? 0) + 1,
    );
    expect(phase6Dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dependency_type: "a",
          grantor_name: "migration_owner",
          is_grantable: false,
          object_kind: "column",
          object_name: "dashboards",
          privilege_type: "UPDATE",
          role_name: "dasher_retention_definer",
          schema_name: "dasher",
          subobject_name: "head_version_id",
        }),
      ]),
    );
    const correctedPolicyNames = new Set([
      "source_snapshots_retention_select",
      "source_snapshots_retention_delete",
      "evidence_records_retention_select",
      "evidence_records_retention_delete",
    ]);
    const policyRows = (inventory: readonly Record<string, unknown>[]) =>
      inventory.filter(
        (row) =>
          row.object_kind === "policy" &&
          typeof row.policy_name === "string" &&
          correctedPolicyNames.has(row.policy_name),
      );
    const phase5PolicyRows = policyRows(phase5Dependencies ?? []);
    const phase6PolicyRows = policyRows(phase6Dependencies ?? []);
    expect(phase5PolicyRows).toHaveLength(4);
    expect(phase6PolicyRows).toHaveLength(4);
    for (const phase6Policy of phase6PolicyRows) {
      const phase5Policy = phase5PolicyRows.find(
        (candidate) => candidate.policy_name === phase6Policy.policy_name,
      );
      expect(phase5Policy).toBeDefined();
      expect(phase6Policy.policy_using_expression).not.toBe(
        phase5Policy?.policy_using_expression,
      );
      expect(phase6Policy).toMatchObject({
        dependency_type: "r",
        object_kind: "policy",
        policy_permissive: true,
        policy_roles: ["dasher_retention_definer"],
        policy_with_check_expression: null,
        role_name: "dasher_retention_definer",
        schema_name: "dasher",
      });
      expect(phase6Policy.policy_using_expression).toEqual(
        expect.stringContaining("target_finalizer.state = 'deleted'::text"),
      );
      expect(phase6Policy.policy_using_expression).not.toEqual(
        expect.stringContaining(
          "target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256",
        ),
      );
      expect(phase6Policy.policy_using_expression).toEqual(
        expect.stringContaining("(EXISTS ( SELECT 1\n"),
      );
      expect(phase6Catalog.policies).toContainEqual(
        expect.stringContaining(
          `|${String(phase6Policy.policy_using_expression)}|<none>`,
        ),
      );
    }

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).resolves.toEqual({
      appliedCount: 0,
      discoveredCount: 6,
      previouslyAppliedCount: 6,
    });
    expect(scripted.journalRows).toEqual(series.journalRows);
  });

  it("binds missing, extra, broad, wrong-role, wrong-column, and grantable phase-6 ACL drift", async () => {
    type ExactCatalog = Record<string, readonly string[]>;
    const phase6Sql = await readFile(
      join(
        canonicalMigrationDirectory,
        "0006_lifecycle_access_retention_guard_correction.sql",
      ),
      "utf8",
    );
    const exact = getCanonical0006ExactCatalogContractForTests(
      "migration_owner",
      phase6Sql,
    ) as ExactCatalog;
    const approved =
      "column|dasher.dashboards.head_version_id|migration_owner|dasher_retention_definer|UPDATE|false";
    expect(exact.acls?.filter((acl) => acl === approved)).toHaveLength(1);

    const replaceApproved = (replacement: string) => ({
      ...exact,
      acls: (exact.acls ?? []).map((acl) =>
        acl === approved ? replacement : acl,
      ),
    });
    const mutants: readonly ExactCatalog[] = [
      { ...exact, acls: (exact.acls ?? []).filter((acl) => acl !== approved) },
      {
        ...exact,
        acls: [
          ...(exact.acls ?? []),
          "column|dasher.dashboards.title|migration_owner|dasher_retention_definer|UPDATE|false",
        ],
      },
      replaceApproved(
        "relation|dasher.dashboards|migration_owner|dasher_retention_definer|UPDATE|false",
      ),
      replaceApproved(
        "column|dasher.dashboards.head_version_id|migration_owner|dasher_retention_operator|UPDATE|false",
      ),
      replaceApproved(
        "column|dasher.dashboards.title|migration_owner|dasher_retention_definer|UPDATE|false",
      ),
      replaceApproved(
        "column|dasher.dashboards.head_version_id|migration_owner|dasher_retention_definer|UPDATE|true",
      ),
    ];

    for (const [index, mutant] of mutants.entries()) {
      const mismatchDimensions = Object.keys(exact).filter(
        (dimension) => !isDeepStrictEqual(exact[dimension], mutant[dimension]),
      );
      expect(mismatchDimensions, `phase-6 ACL mutant ${index + 1}`).toEqual([
        "acls",
      ]);
    }
  });

  it("binds missing, extra, renamed, wrong-command, restrictive, wrong-role, predicate, and WITH CHECK policy drift", async () => {
    type ExactCatalog = Record<string, readonly string[]>;
    const phase6Sql = await readFile(
      join(
        canonicalMigrationDirectory,
        "0006_lifecycle_access_retention_guard_correction.sql",
      ),
      "utf8",
    );
    const exact = getCanonical0006ExactCatalogContractForTests(
      "migration_owner",
      phase6Sql,
    ) as ExactCatalog;
    const identity =
      "dasher|source_snapshots|source_snapshots_retention_select|";
    const approved = (exact.policies ?? []).find((row) =>
      row.startsWith(identity),
    );
    expect(approved).toBeDefined();
    const replaceApproved = (replacement: string) => ({
      ...exact,
      policies: (exact.policies ?? []).map((row) =>
        row === approved ? replacement : row,
      ),
    });
    const mutants: readonly ExactCatalog[] = [
      {
        ...exact,
        policies: (exact.policies ?? []).filter((row) => row !== approved),
      },
      { ...exact, policies: [...(exact.policies ?? []), approved!] },
      replaceApproved(
        approved!.replace(
          "source_snapshots_retention_select",
          "source_snapshots_retention_select_extra",
        ),
      ),
      replaceApproved(
        approved!.replace(
          "|true|r|{dasher_retention_definer}|",
          "|true|d|{dasher_retention_definer}|",
        ),
      ),
      replaceApproved(
        approved!.replace(
          "|true|r|{dasher_retention_definer}|",
          "|false|r|{dasher_retention_definer}|",
        ),
      ),
      replaceApproved(
        approved!.replace(
          "|true|r|{dasher_retention_definer}|",
          "|true|r|{dasher_retention_operator}|",
        ),
      ),
      replaceApproved(
        approved!.replace(
          "target_finalizer.state = 'deleted'::text",
          "target_finalizer.state = 'eligible'::text",
        ),
      ),
      replaceApproved(approved!.replace(/<none>$/u, "true")),
    ];

    for (const [index, mutant] of mutants.entries()) {
      expect(
        Object.keys(exact).filter(
          (dimension) =>
            !isDeepStrictEqual(exact[dimension], mutant[dimension]),
        ),
        `phase-6 policy mutant ${index + 1}`,
      ).toEqual(["policies"]);
    }
  });

  it("pins all four PostgreSQL-normalized phase-6 policy expressions without changing phase 5", async () => {
    type ExactCatalog = Record<string, readonly string[]>;
    const phase6Sql = await readFile(
      join(
        canonicalMigrationDirectory,
        "0006_lifecycle_access_retention_guard_correction.sql",
      ),
      "utf8",
    );
    const phase5 = getCanonical0005ExactCatalogContractForTests(
      "migration_owner",
    ) as ExactCatalog;
    const phase6 = getCanonical0006ExactCatalogContractForTests(
      "migration_owner",
      phase6Sql,
    ) as ExactCatalog;
    const policies = [
      {
        catalogCommand: "r",
        name: "source_snapshots_retention_select",
        phase5Sha256:
          "fda7b996c553e58515db6ef0cf78f1dc36edff7367d3c53d2ed8a5a9f825ed1e",
        phase6Sha256:
          "4ed1d5e8aab0f915a0d1b5b61ee004eb01b19341251b25bdc0d05ab96607f35c",
        relation: "source_snapshots",
      },
      {
        catalogCommand: "d",
        name: "source_snapshots_retention_delete",
        phase5Sha256:
          "fda7b996c553e58515db6ef0cf78f1dc36edff7367d3c53d2ed8a5a9f825ed1e",
        phase6Sha256:
          "4ed1d5e8aab0f915a0d1b5b61ee004eb01b19341251b25bdc0d05ab96607f35c",
        relation: "source_snapshots",
      },
      {
        catalogCommand: "r",
        name: "evidence_records_retention_select",
        phase5Sha256:
          "59a5733f04110af250f723d3ab8d527fbd8f5b733e318e2385079acaf36133c1",
        phase6Sha256:
          "a2976b23c20c713f6d2bbab7dd7100a4a13ea9982c1521b20fa8a485cf3eb3e9",
        relation: "evidence_records",
      },
      {
        catalogCommand: "d",
        name: "evidence_records_retention_delete",
        phase5Sha256:
          "59a5733f04110af250f723d3ab8d527fbd8f5b733e318e2385079acaf36133c1",
        phase6Sha256:
          "a2976b23c20c713f6d2bbab7dd7100a4a13ea9982c1521b20fa8a485cf3eb3e9",
        relation: "evidence_records",
      },
    ] as const;
    const catalogUsing = (
      catalog: ExactCatalog,
      policy: (typeof policies)[number],
    ) => {
      const prefix = `dasher|${policy.relation}|${policy.name}|true|${policy.catalogCommand}|{dasher_retention_definer}|`;
      const row = (catalog.policies ?? []).find((candidate) =>
        candidate.startsWith(prefix),
      );
      expect(row, policy.name).toBeDefined();
      expect(row, policy.name).toMatch(/[|]<none>$/u);
      return row!.slice(prefix.length, -"|<none>".length);
    };

    for (const policy of policies) {
      const rawUsing = new RegExp(
        `^CREATE POLICY ${policy.name}\\nON dasher[.]${policy.relation}\\nAS PERMISSIVE\\nFOR (?:SELECT|DELETE)\\nTO dasher_retention_definer\\nUSING \\((.+)\\)\\n;$`,
        "mu",
      ).exec(phase6Sql)?.[1];
      const phase5Using = catalogUsing(phase5, policy);
      const phase6Using = catalogUsing(phase6, policy);

      expect(rawUsing, policy.name).toBeDefined();
      expect(phase6Using, policy.name).not.toBe(rawUsing);
      expect(phase6Using, policy.name).toContain("(EXISTS ( SELECT 1\n");
      expect(phase6Using, policy.name).toContain(
        "AND (NOT (EXISTS ( SELECT 1\n",
      );
      expect(createHash("sha256").update(phase5Using).digest("hex")).toBe(
        policy.phase5Sha256,
      );
      expect(createHash("sha256").update(phase6Using).digest("hex")).toBe(
        policy.phase6Sha256,
      );
      expect(phase5Using, policy.name).toContain(
        "target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256",
      );
      expect(phase6Using, policy.name).not.toContain(
        "target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256",
      );
    }
  });

  it("rejects an exact phase-6 normalized policy-expression mutation before SQL", async () => {
    type ExactCatalog = Record<string, readonly string[]>;
    const series = await canonicalPhase6Series();
    const phase6Sql = await readFile(
      join(
        canonicalMigrationDirectory,
        "0006_lifecycle_access_retention_guard_correction.sql",
      ),
      "utf8",
    );
    const exact = getCanonical0006ExactCatalogContractForTests(
      "migration_owner",
      phase6Sql,
    ) as ExactCatalog;
    const approved = exact.policies?.find((row) =>
      row.startsWith(
        "dasher|source_snapshots|source_snapshots_retention_select|",
      ),
    );
    expect(approved).toBeDefined();
    const mutated = approved!.replace(
      "(octet_length(target_cleanup.completion_proof_sha256) = 32)",
      "(octet_length(target_cleanup.completion_proof_sha256) = 31)",
    );
    expect(mutated).not.toBe(approved);
    const candidate = {
      ...exact,
      policies: (exact.policies ?? []).map((row) =>
        row === approved ? mutated : row,
      ),
    };
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
      phase6CatalogCandidate: candidate,
      prefixObjectMatches: true,
      retentionRoleNames: [
        "dasher_retention_definer",
        "dasher_retention_operator",
      ],
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
    expect(scripted.phase6CorrectionSideEffectPresent).toBe(false);
    expect(scripted.journalRows).toEqual(series.journalRows);
    expect(scripted.queryTexts).not.toContainEqual(
      expect.stringContaining(
        "CREATE OR REPLACE FUNCTION dasher_api.get_dashboard_admin_status(uuid)",
      ),
    );
  });

  it.each([
    ["missing corrected policy", { phase6CatalogMatches: false }],
    ["extra corrected policy", { phase6CatalogMatches: false }],
    ["renamed corrected policy", { phase6CatalogMatches: false }],
    ["wrong corrected-policy command", { phase6CatalogMatches: false }],
    ["restrictive corrected policy", { phase6CatalogMatches: false }],
    ["wrong corrected-policy role", { phase6CatalogMatches: false }],
    ["altered corrected-policy predicate", { phase6CatalogMatches: false }],
    ["non-null corrected-policy WITH CHECK", { phase6CatalogMatches: false }],
    ["revoked required grant", { phase6CatalogMatches: false }],
    ["altered managed dependency closure", { dependencyMatches: [false] }],
  ] as const)(
    "rejects replay with %s before SQL and does not self-repair",
    async (_name, drift) => {
      const series = await canonicalPhase6Series();
      const scripted = scriptedMigrationClient({
        ...drift,
        initialJournalRows: series.journalRows,
        prefixObjectMatches: true,
        retentionRoleNames: [
          "dasher_retention_definer",
          "dasher_retention_operator",
        ],
      });

      await expect(
        runMigrations(singleClientPool(scripted.client), series.directory, []),
      ).rejects.toMatchObject({ code: "managed_role_drift" });
      expect(scripted.phase6CorrectionSideEffectPresent).toBe(false);
      expect(scripted.journalRows).toEqual(series.journalRows);
      expect(scripted.queryTexts).not.toContainEqual(
        expect.stringContaining(
          "CREATE OR REPLACE FUNCTION dasher_api.get_dashboard_admin_status(uuid)",
        ),
      );
    },
  );

  it.each([
    ["post-DDL catalog validation", "catalog"],
    ["journal insertion", "journal"],
  ] as const)(
    "rolls back failed 0006 %s with its journal row, then retries atomically",
    async (_failureName, failureStage) => {
      const series = await canonicalPhase6Series();
      const scripted = scriptedMigrationClient({
        failure: { stage: failureStage, transaction: 2 },
        initialJournalRows: series.journalRows.slice(0, 5),
        prefixObjectMatches: true,
        retentionRoleNames: [
          "dasher_retention_definer",
          "dasher_retention_operator",
        ],
      });

      await expect(
        runMigrations(singleClientPool(scripted.client), series.directory, []),
      ).rejects.toBe(scripted.operationError);
      expect(scripted.journalRows).toEqual(series.journalRows.slice(0, 5));
      expect(scripted.phase6CorrectionSideEffectPresent).toBe(false);
      expect(scripted.phase6FunctionReplacements).toEqual([]);
      expect(scripted.phase6PolicyReplacements).toEqual([]);
      expect(scripted.phase6ColumnAclPresent).toBe(false);
      expect(transactionCommands(scripted, 2).at(-1)).toBe("T2 ROLLBACK");

      await expect(
        runMigrations(singleClientPool(scripted.client), series.directory, []),
      ).resolves.toEqual({
        appliedCount: 1,
        discoveredCount: 6,
        previouslyAppliedCount: 5,
      });
      expect(scripted.journalRows).toEqual(series.journalRows);
      expect(scripted.phase6CorrectionSideEffectPresent).toBe(true);
      expect(scripted.phase6FunctionReplacements).toEqual([
        "dasher_api.get_dashboard_admin_status(uuid)",
        "dasher_private.enforce_retention_mutation()",
      ]);
      expect(scripted.phase6PolicyReplacements).toEqual([
        "source_snapshots_retention_select",
        "source_snapshots_retention_delete",
        "evidence_records_retention_select",
        "evidence_records_retention_delete",
      ]);
      expect(scripted.phase6ColumnAclPresent).toBe(true);
    },
  );

  it("publishes exact journal-4 function, ACL, and relation dependencies without retaining old mutation identities", async () => {
    const series = await canonicalLifecycleCorrectionSeries();
    const scripted = scriptedMigrationClient({ prefixObjectMatches: true });
    await runMigrations(
      singleClientPool(scripted.client),
      series.directory,
      [],
    );

    const inventory = scripted.dependencyInventories.at(-1) ?? [];
    expect(inventory).toContainEqual(
      expect.objectContaining({
        dependency_type: "o",
        function_arguments: "smallint, bytea",
        object_kind: "function",
        object_name: "context_csrf_allows",
        role_name: "dasher_security_definer",
        schema_name: "dasher_private",
      }),
    );
    expect(inventory).not.toContainEqual(
      expect.objectContaining({
        dependency_type: "a",
        object_name: "context_csrf_allows",
        role_name: "dasher_app",
      }),
    );
    expect(inventory).not.toContainEqual(
      expect.objectContaining({
        function_arguments:
          "uuid, text, text, integer, boolean, uuid, uuid, text",
        object_name: "create_dashboard",
      }),
    );
    expect(inventory).toContainEqual(
      expect.objectContaining({
        dependency_type: "a",
        function_arguments:
          "uuid, text, text, integer, boolean, uuid, uuid, smallint, bytea, text",
        object_name: "create_dashboard",
        privilege_type: "EXECUTE",
        role_name: "dasher_app",
      }),
    );
    expect(
      inventory.filter(
        (entry) =>
          entry.dependency_type === "a" &&
          entry.object_kind === "relation" &&
          entry.privilege_type === "SELECT" &&
          entry.role_name === "dasher_security_definer" &&
          (entry.object_name === "dashboard_cleanup_coordination" ||
            entry.object_name === "dashboard_legal_holds"),
      ),
    ).toHaveLength(2);
  });

  it.each([
    {
      name: "catalog",
      options: { lifecycleCorrectionCatalogMatches: false },
    },
    {
      name: "dependency",
      options: { dependencyMatches: [false] },
    },
  ])(
    "rejects exact journal-4 $name drift before SQL or cleanup mutation",
    async ({ options }) => {
      const series = await canonicalLifecycleCorrectionSeries();
      const scripted = scriptedMigrationClient({
        ...options,
        initialJournalRows: series.journalRows,
        prefixObjectMatches: true,
        retentionRoleNames: [
          "dasher_retention_definer",
          "dasher_retention_operator",
        ],
      });
      await expect(
        runMigrations(singleClientPool(scripted.client), series.directory, []),
      ).rejects.toMatchObject({ code: "managed_role_drift" });
      expect(scripted.queryTexts).not.toContainEqual(
        expect.stringContaining(
          "-- Dasher lifecycle API correction successor.",
        ),
      );
      expect(
        scripted.managedRoleEvents.some(
          (event) => event.startsWith("CREATE ") || event.startsWith("DROP "),
        ),
      ).toBe(false);
      expect(scripted.journalRows).toEqual(series.journalRows);
    },
  );

  it("holds one session gate and prepares both retention roles only after validating exact 0002", async () => {
    const series = await canonicalSuccessorSeries();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
      prefixObjectMatches: true,
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
    expect(
      scripted.queryTexts.filter((text) =>
        text.includes("pg_catalog.pg_advisory_lock("),
      ),
    ).toHaveLength(1);
    expect(
      scripted.queryTexts.filter((text) =>
        text.includes("pg_catalog.pg_advisory_unlock("),
      ),
    ).toHaveLength(1);
    expectExactlyOneSuccessfulSessionGate(scripted);
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
      text.includes("signature_catalog AS"),
    );
    expect(successorCatalogQuery).toContain(
      "pg_catalog.pg_get_function_result",
    );
    expect(successorCatalogQuery).toContain("routine.provolatile");
    expect(successorCatalogQuery).toContain("routine.prosecdef");
    expect(successorCatalogQuery).toContain("routine.proconfig");
    expect(successorCatalogQuery).toContain("routine.provariadic");
    expect(successorCatalogQuery).toContain("routine.pronargdefaults");
    expect(successorCatalogQuery).toContain("routine.proargdefaults");
    expect(successorCatalogQuery).toContain("attribute.attcollation");
    expect(successorCatalogQuery).toContain("index_row.indnatts");
    expect(successorCatalogQuery).toContain("index_row.indnkeyatts");
    expect(successorCatalogQuery).toContain("index_row.indcollation");
    expect(successorCatalogQuery).toContain("index_row.indisclustered");
    expect(successorCatalogQuery).toContain("pg_catalog.pg_get_constraintdef");
    expect(successorCatalogQuery).toContain("pg_catalog.pg_get_triggerdef");
    expect(successorCatalogQuery).toContain("pg_catalog.col_description");
    expect(successorCatalogQuery).toContain("'pg_constraint'");
    expect(successorCatalogQuery).toContain("'pg_trigger'");
    expect(successorCatalogQuery).toContain("'pg_policy'");
    expect(successorCatalogQuery).toMatch(
      /pg_catalog\.shobj_description\(\s*database_row\.oid,\s*'pg_database'/,
    );
    expect(successorCatalogQuery).not.toMatch(
      /pg_catalog\.obj_description\(\s*database_row\.oid,\s*'pg_database'/,
    );
    expect(successorCatalogQuery).toContain("privilege.is_grantable");
    expect(successorCatalogQuery).not.toContain("$3::jsonb");
    const successorContract = scripted.catalogContracts.at(-1);
    expect(successorContract).toBeDefined();
    expect(Object.keys(successorContract ?? {}).sort()).toEqual(
      [
        "acls",
        "columns",
        "comments",
        "constraints",
        "defaultAcls",
        "foreignKeys",
        "functions",
        "indexes",
        "policies",
        "relations",
        "schemas",
        "sequences",
        "triggers",
        "types",
      ].sort(),
    );
    for (const category of [
      "schemas",
      "relations",
      "columns",
      "types",
      "indexes",
      "constraints",
      "foreignKeys",
      "triggers",
      "policies",
      "functions",
      "acls",
      "defaultAcls",
    ]) {
      expect(successorContract?.[category]).not.toEqual([]);
    }
    expect(successorContract?.comments).toEqual([]);
    expect(
      (successorContract?.functions ?? []).every(
        (signature) => signature.split("|").length === 16,
      ),
    ).toBe(true);
    expect(
      (successorContract?.columns ?? []).every(
        (signature) => signature.split("|").length === 10,
      ),
    ).toBe(true);
    expect(
      (successorContract?.indexes ?? []).every(
        (signature) => signature.split("|").length === 19,
      ),
    ).toBe(true);
    expect(
      (successorContract?.policies ?? []).filter(
        (signature) =>
          signature.includes(
            "retention_service_principal_self_binding_select",
          ) ||
          signature.includes("dashboards_retention_target_discovery_select"),
      ),
    ).toHaveLength(2);
    const independentFixtureContract = independentModeled0003CatalogContract();
    const runtimeModeledContract =
      getModeled0003StaticCatalogContractForTests() as typeof independentFixtureContract;
    for (const category of Object.keys(
      independentFixtureContract,
    ) as (keyof typeof independentFixtureContract)[]) {
      expect(runtimeModeledContract[category], category).toEqual(
        independentFixtureContract[category],
      );
    }
    expect(runtimeModeledContract).toEqual(independentFixtureContract);
    const secondRuntimeCopy =
      getModeled0003StaticCatalogContractForTests() as typeof independentFixtureContract;
    expect(secondRuntimeCopy).toEqual(runtimeModeledContract);
    expect(secondRuntimeCopy).not.toBe(runtimeModeledContract);
    const disposableRuntimeCopy =
      getModeled0003StaticCatalogContractForTests() as {
        comments: string[];
      };
    disposableRuntimeCopy.comments.push("database|drift|copy-only");
    expect(getModeled0003StaticCatalogContractForTests()).toEqual(
      independentFixtureContract,
    );
    const successorDependencies = scripted.dependencyInventories.at(-1) ?? [];
    expect(
      successorDependencies.filter(
        (entry) =>
          entry.dependency_type === "o" &&
          entry.role_name === "dasher_retention_definer",
      ),
    ).toHaveLength(7);
    const successorPolicyDependencies = successorDependencies.filter(
      (entry) =>
        entry.dependency_type === "r" &&
        entry.object_kind === "policy" &&
        (entry.role_name === "dasher_security_definer" ||
          entry.role_name === "dasher_retention_definer"),
    );
    expect(successorPolicyDependencies).toHaveLength(
      modeled0003CatalogMatrix.policies.length,
    );
    expect(
      successorPolicyDependencies.every(
        (entry) =>
          entry.object_kind === "policy" &&
          entry.policy_permissive === true &&
          Array.isArray(entry.policy_roles) &&
          entry.role_name !== null &&
          entry.policy_roles.includes(entry.role_name) &&
          (typeof entry.policy_using_expression === "string" ||
            typeof entry.policy_with_check_expression === "string"),
      ),
    ).toBe(true);
    expect(
      successorDependencies.filter(
        (entry) =>
          entry.privilege_type === "EXECUTE" &&
          entry.role_name === "dasher_retention_operator",
      ),
    ).toHaveLength(6);
    expect(
      successorDependencies.some(
        (entry) =>
          entry.privilege_type === "EXECUTE" &&
          entry.role_name === "dasher_retention_operator" &&
          entry.identity ===
            "dasher_retention_api.initialize_operator_context(uuid, text, uuid, text, uuid)",
      ),
    ).toBe(false);
  });

  it("rejects one-field mutations in every independently bound successor dimension", () => {
    const runtime =
      getModeled0003StaticCatalogContractForTests() as Modeled0003CatalogContract;
    const fixture = independentModeled0003CatalogContract();
    const mutationDimensions = [
      "functions",
      "functions",
      "columns",
      "indexes",
      "indexes",
      "indexes",
      "comments",
      "functions",
      "functions",
      "functions",
      "functions",
      "functions",
      "policies",
      "functions",
      "functions",
      "columns",
      "constraints",
      "policies",
      "policyDependencyRows",
      "ownershipDependencyRows",
      "aclDependencyRows",
      "functions",
      "functions",
      "functions",
      "columnAcls",
      "policies",
      "triggers",
      "relationAcls",
      "constraints",
      "aclDependencyRows",
      "columnAcls",
      "aclDependencyRows",
    ] as const satisfies readonly (keyof Modeled0003CatalogContract)[];
    const mutations = [
      {
        ...fixture,
        functions: fixture.functions.map((routine, index) =>
          index === 0 ? { ...routine, defaults: ["100"] } : routine,
        ),
      },
      {
        ...fixture,
        functions: fixture.functions.map((routine, index) =>
          index === 0 ? { ...routine, variadic: true } : routine,
        ),
      },
      {
        ...fixture,
        columns: fixture.columns.map((column, index) =>
          index === 0 ? { ...column, collation: "pg_catalog.C" } : column,
        ),
      },
      {
        ...fixture,
        indexes: fixture.indexes.map((indexRow, index) =>
          index === 0
            ? { ...indexRow, includedColumns: ["created_at"] }
            : indexRow,
        ),
      },
      {
        ...fixture,
        indexes: fixture.indexes.map((indexRow, index) =>
          index === 0
            ? { ...indexRow, collations: ["pg_catalog.default", "<none>"] }
            : indexRow,
        ),
      },
      {
        ...fixture,
        indexes: fixture.indexes.map((indexRow, index) =>
          index === 0 ? { ...indexRow, clustered: true } : indexRow,
        ),
      },
      { ...fixture, comments: ["column|dasher.dashboards.title|drift"] },
      {
        ...fixture,
        functions: fixture.functions.map((routine, index) =>
          index === 0 ? { ...routine, source: `${routine.source}\n` } : routine,
        ),
      },
      {
        ...fixture,
        functions: fixture.functions.map((routine) =>
          routine.name === "initialize_operator_context"
            ? {
                ...routine,
                source: (routine.source ?? "").replace(
                  "count(DISTINCT retention_service_principal_id)",
                  "1",
                ),
              }
            : routine,
        ),
      },
      {
        ...fixture,
        functions: fixture.functions.map((routine) =>
          routine.name === "initialize_operator_context"
            ? {
                ...routine,
                source: (routine.source ?? "").replace(
                  "OR NOT v_can_initialize OR NOT v_capability_allowed",
                  "OR NOT v_capability_allowed",
                ),
              }
            : routine,
        ),
      },
      {
        ...fixture,
        functions: fixture.functions.map((routine) =>
          routine.name === "initialize_operator_context"
            ? {
                ...routine,
                source: (routine.source ?? "").replace(
                  "proof.distinct_principal_count = 1",
                  "proof.distinct_principal_count >= 1",
                ),
              }
            : routine,
        ),
      },
      {
        ...fixture,
        functions: fixture.functions.map((routine) =>
          routine.name === "initialize_operator_context"
            ? {
                ...routine,
                source: (routine.source ?? "").replace(
                  "      ) = 1\n",
                  "      ) >= 1\n",
                ),
              }
            : routine,
        ),
      },
      {
        ...fixture,
        policies: fixture.policies.map((policy) =>
          policy.name === "dashboards_retention_target_discovery_select"
            ? {
                ...policy,
                using: (policy.using ?? "").replace(
                  "= ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])",
                  "<> ''::text",
                ),
              }
            : policy,
        ),
      },
      {
        ...fixture,
        functions: fixture.functions.map((routine) =>
          routine.name === "enforce_retention_mutation"
            ? {
                ...routine,
                source: (routine.source ?? "").replace(
                  "      AND OLD.purged_at IS NULL\n      AND OLD.purged_lifecycle_revision IS NULL\n      AND OLD.purged_proof_sha256 IS NULL\n",
                  "",
                ),
              }
            : routine,
        ),
      },
      {
        ...fixture,
        functions: fixture.functions.map((routine) =>
          routine.name === "enforce_retention_mutation"
            ? {
                ...routine,
                source: (routine.source ?? "").replace(
                  "        OLD.retention_policy_revision, OLD.access_revoked_at,\n",
                  "",
                ),
              }
            : routine,
        ),
      },
      {
        ...fixture,
        columns: fixture.columns.map((column, index) =>
          index === 0 ? { ...column, nullable: !column.nullable } : column,
        ),
      },
      {
        ...fixture,
        constraints: fixture.constraints.map((constraint) =>
          constraint.name ===
          "dashboard_promotion_decisions_requester_approver_check"
            ? {
                ...constraint,
                definition:
                  "CHECK ((requested_by_user_id = decided_by_user_id))",
              }
            : constraint,
        ),
      },
      {
        ...fixture,
        policies: fixture.policies.map((policy, index) =>
          index === 0 ? { ...policy, using: "true" } : policy,
        ),
      },
      {
        ...fixture,
        policyDependencyRows: fixture.policyDependencyRows.map((row, index) =>
          index === 0 ? { ...row, dependencyType: "a" } : row,
        ),
      },
      {
        ...fixture,
        ownershipDependencyRows: fixture.ownershipDependencyRows.map(
          (row, index) =>
            index === 0 ? { ...row, roleName: "migration_owner" } : row,
        ),
      },
      {
        ...fixture,
        aclDependencyRows: fixture.aclDependencyRows.map((row, index) =>
          index === 0 ? { ...row, isGrantable: true } : row,
        ),
      },
      {
        ...fixture,
        functions: fixture.functions.map((routine) =>
          routine.name === "materialize_dashboard_expiry"
            ? {
                ...routine,
                source: (routine.source ?? "").replace(
                  "  PERFORM dasher_retention_api.initialize_operator_context(\n    $1, 'materialize_expiry', $3, $4, $5\n  );\n",
                  "",
                ),
              }
            : routine,
        ),
      },
      {
        ...fixture,
        functions: fixture.functions.map((routine) =>
          routine.name === "purge_dashboard"
            ? {
                ...routine,
                source: (routine.source ?? "").replace(
                  "SET state = 'eligible', proof_sha256 = finalizer.expected_claim_set_sha256",
                  "SET state = 'deleted', proof_sha256 = finalizer.expected_claim_set_sha256",
                ),
              }
            : routine,
        ),
      },
      {
        ...fixture,
        functions: fixture.functions.map((routine) =>
          routine.name === "decide_dashboard_promotion"
            ? {
                ...routine,
                source: (routine.source ?? "")
                  .replace(
                    "INSERT INTO dasher.dashboard_promotion_decisions",
                    "__TASK8A_DECISION_WRITE__",
                  )
                  .replace(
                    "INSERT INTO dasher.dashboard_lifecycle_events",
                    "INSERT INTO dasher.dashboard_promotion_decisions",
                  )
                  .replace(
                    "__TASK8A_DECISION_WRITE__",
                    "INSERT INTO dasher.dashboard_lifecycle_events",
                  ),
              }
            : routine,
        ),
      },
      {
        ...fixture,
        columnAcls: fixture.columnAcls.map((acl) =>
          acl.grantee === "dasher_retention_definer" &&
          acl.relationName === "dashboard_restore_lineage" &&
          acl.columnName === "organization_id" &&
          acl.privilege === "UPDATE"
            ? { ...acl, columnName: "dashboard_id" }
            : acl,
        ),
      },
      {
        ...fixture,
        policies: fixture.policies.map((policy) =>
          policy.name === "dashboard_restore_lineage_retention_delete"
            ? { ...policy, using: "true" }
            : policy,
        ),
      },
      {
        ...fixture,
        triggers: fixture.triggers.map((trigger) =>
          trigger.name === "dashboard_restore_lineage_immutable"
            ? {
                ...trigger,
                functionIdentity:
                  "dasher_private.reject_dashboard_append_mutation()",
              }
            : trigger,
        ),
      },
      {
        ...fixture,
        relationAcls: fixture.relationAcls.map((acl) =>
          acl.relationName === "dashboard_restore_lineage" &&
          acl.grantee === "dasher_retention_definer" &&
          acl.privilege === "DELETE"
            ? { ...acl, grantee: "dasher_security_definer" }
            : acl,
        ),
      },
      {
        ...fixture,
        constraints: fixture.constraints.map((constraint) =>
          constraint.name === "dashboard_restore_lineage_dashboard_version_fk"
            ? { ...constraint, deleteAction: "c" }
            : constraint,
        ),
      },
      {
        ...fixture,
        aclDependencyRows: fixture.aclDependencyRows.map((row) =>
          row.objectKind === "column" &&
          row.identity === "dasher.dashboard_restore_lineage.organization_id" &&
          row.grantee === "dasher_retention_definer" &&
          row.privilege === "UPDATE"
            ? { ...row, grantee: "dasher_retention_operator" }
            : row,
        ),
      },
      {
        ...fixture,
        columnAcls: fixture.columnAcls.map((acl) =>
          acl.grantee === "dasher_retention_definer" &&
          acl.relationName === "source_snapshots" &&
          acl.columnName === "organization_id" &&
          acl.privilege === "UPDATE"
            ? { ...acl, columnName: "snapshot_id" }
            : acl,
        ),
      },
      {
        ...fixture,
        aclDependencyRows: fixture.aclDependencyRows.map((row) =>
          row.objectKind === "column" &&
          row.identity === "dasher.source_snapshots.organization_id" &&
          row.grantee === "dasher_retention_definer" &&
          row.privilege === "UPDATE"
            ? { ...row, grantee: "dasher_retention_operator" }
            : row,
        ),
      },
    ];

    expect(catalogContractMismatchDimensions(runtime, fixture)).toEqual([]);
    expect(mutations).toHaveLength(mutationDimensions.length);
    for (const [index, mutation] of mutations.entries()) {
      expect(
        catalogContractMismatchDimensions(runtime, mutation),
        `catalog mutant ${index + 1}`,
      ).toEqual([mutationDimensions[index]]);
    }
  });

  it("accepts the exact dependency-free prepared residue and retries the canonical successor without adoption", async () => {
    const series = await canonicalSuccessorSeries();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
      prefixObjectMatches: true,
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
      expect.stringContaining(
        "-- Dasher immutable-content and lifecycle successor.",
      ),
    );
  });

  it("rejects the exact modeled probe from pure 0002 before role, SQL, or journal side effects", async () => {
    const series = await modeledSuccessorSeries();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).rejects.toMatchObject({ code: "migration_file_mismatch" });
    expect(scripted.transactionCommands).toEqual([
      "SESSION ADVISORY LOCK",
      "SESSION ADVISORY UNLOCK",
    ]);
    expect(scripted.journalRows).toEqual(series.journalRows);
    expect(scripted.modeledSuccessorSideEffectPresent).toBe(false);
    expect(scripted.managedRoleEvents).toEqual([]);
  });

  it("rejects missing, renamed, reordered, extra, mutated, and modeled-plus-0004 series before DDL or role mutation", async () => {
    const canonicalBytes = new Map<string, Buffer>();
    for (const filename of [
      "0001_identity_audit.sql",
      "0002_security_boundary.sql",
      "0003_immutable_content.sql",
      "0004_lifecycle_api_correction.sql",
    ]) {
      canonicalBytes.set(
        filename,
        await readFile(join(canonicalMigrationDirectory, filename)),
      );
    }
    const cases: {
      readonly name: string;
      readonly files: readonly (readonly [string, Buffer | string])[];
    }[] = [
      {
        name: "missing predecessor",
        files: [
          [
            "0001_identity_audit.sql",
            canonicalBytes.get("0001_identity_audit.sql")!,
          ],
          [
            "0002_security_boundary.sql",
            canonicalBytes.get("0002_security_boundary.sql")!,
          ],
          [
            "0004_lifecycle_api_correction.sql",
            canonicalBytes.get("0004_lifecycle_api_correction.sql")!,
          ],
        ],
      },
      {
        name: "renamed 0004",
        files: [
          ...[...canonicalBytes.entries()].slice(0, 3),
          [
            "0004_lifecycle_correction_renamed.sql",
            canonicalBytes.get("0004_lifecycle_api_correction.sql")!,
          ],
        ],
      },
      {
        name: "reordered bytes",
        files: [
          ...[...canonicalBytes.entries()].slice(0, 2),
          [
            "0003_immutable_content.sql",
            canonicalBytes.get("0004_lifecycle_api_correction.sql")!,
          ],
          [
            "0004_lifecycle_api_correction.sql",
            canonicalBytes.get("0003_immutable_content.sql")!,
          ],
        ],
      },
      {
        name: "extra fifth",
        files: [...canonicalBytes.entries(), ["0005_extra.sql", "SELECT 5;\n"]],
      },
      {
        name: "mutated 0004",
        files: [
          ...[...canonicalBytes.entries()].slice(0, 3),
          [
            "0004_lifecycle_api_correction.sql",
            Buffer.concat([
              canonicalBytes.get("0004_lifecycle_api_correction.sql")!,
              Buffer.from("\n-- mutated\n"),
            ]),
          ],
        ],
      },
      {
        name: "modeled plus 0004",
        files: [
          ...[...canonicalBytes.entries()].slice(0, 2),
          [
            "0003_immutable_content.sql",
            await readFile(modeledSuccessorFixture),
          ],
          [
            "0004_lifecycle_api_correction.sql",
            canonicalBytes.get("0004_lifecycle_api_correction.sql")!,
          ],
        ],
      },
    ];

    for (const candidate of cases) {
      const directory = await temporaryDirectory();
      for (const [filename, bytes] of candidate.files) {
        await writeFile(join(directory, filename), bytes);
      }
      const scripted = scriptedMigrationClient();
      await expect(
        runMigrations(singleClientPool(scripted.client), directory, []),
        candidate.name,
      ).rejects.toMatchObject({ code: "migration_file_mismatch" });
      expect(scripted.transactionCommands, candidate.name).toEqual([
        "SESSION ADVISORY LOCK",
        "SESSION ADVISORY UNLOCK",
      ]);
      expect(scripted.managedRoleEvents, candidate.name).toEqual([]);
      expect(scripted.journalRows, candidate.name).toEqual([]);
      expect(scripted.lifecycleCorrectionSideEffectPresent).toBe(false);
    }
  });

  it("rejects renamed, checksum-drifted, gapped, and extra phase-6 successors before SQL", async () => {
    const canonicalBytes = new Map<string, Buffer>();
    for (const filename of [
      "0001_identity_audit.sql",
      "0002_security_boundary.sql",
      "0003_immutable_content.sql",
      "0004_lifecycle_api_correction.sql",
      "0005_security_definer_cleanup_coordination.sql",
      "0006_lifecycle_access_retention_guard_correction.sql",
    ]) {
      canonicalBytes.set(
        filename,
        await readFile(join(canonicalMigrationDirectory, filename)),
      );
    }
    const phase6 = canonicalBytes.get(
      "0006_lifecycle_access_retention_guard_correction.sql",
    )!;
    const cases: readonly Readonly<{
      files: readonly (readonly [string, Buffer | string])[];
      name: string;
    }>[] = [
      {
        name: "renamed phase 6",
        files: [
          ...[...canonicalBytes.entries()].slice(0, 5),
          ["0006_retention_guard_renamed.sql", phase6],
        ],
      },
      {
        name: "phase-6 checksum drift",
        files: [
          ...[...canonicalBytes.entries()].slice(0, 5),
          [
            "0006_lifecycle_access_retention_guard_correction.sql",
            Buffer.concat([phase6, Buffer.from("\n-- drift\n")]),
          ],
        ],
      },
      {
        name: "gap before phase 6",
        files: [
          ...[...canonicalBytes.entries()].slice(0, 4),
          ["0006_lifecycle_access_retention_guard_correction.sql", phase6],
        ],
      },
      {
        name: "extra phase 7",
        files: [...canonicalBytes.entries(), ["0007_extra.sql", "SELECT 7;\n"]],
      },
    ];

    for (const candidate of cases) {
      const directory = await temporaryDirectory();
      for (const [filename, bytes] of candidate.files) {
        await writeFile(join(directory, filename), bytes);
      }
      const scripted = scriptedMigrationClient();
      await expect(
        runMigrations(singleClientPool(scripted.client), directory, []),
        candidate.name,
      ).rejects.toMatchObject({ code: "migration_file_mismatch" });
      expect(scripted.transactionCommands, candidate.name).toEqual([
        "SESSION ADVISORY LOCK",
        "SESSION ADVISORY UNLOCK",
      ]);
      expect(scripted.journalRows, candidate.name).toEqual([]);
      expect(scripted.phase6CorrectionSideEffectPresent).toBe(false);
    }
  });

  it("rejects partial, extra, IF EXISTS, role, command, mode, state, and proof-domain phase-6 policy source tampering before mutation", async () => {
    const canonicalBytes = new Map<string, Buffer>();
    for (const filename of [
      "0001_identity_audit.sql",
      "0002_security_boundary.sql",
      "0003_immutable_content.sql",
      "0004_lifecycle_api_correction.sql",
      "0005_security_definer_cleanup_coordination.sql",
      "0006_lifecycle_access_retention_guard_correction.sql",
    ]) {
      canonicalBytes.set(
        filename,
        await readFile(join(canonicalMigrationDirectory, filename)),
      );
    }
    const phase6 = canonicalBytes
      .get("0006_lifecycle_access_retention_guard_correction.sql")!
      .toString("utf8");
    const mutants = [
      phase6.replace(
        "DROP POLICY source_snapshots_retention_select ON dasher.source_snapshots;\n",
        "",
      ),
      `${phase6}\nCREATE POLICY source_snapshots_retention_extra ON dasher.source_snapshots USING (true);\n`,
      phase6.replace(
        "DROP POLICY source_snapshots",
        "DROP POLICY IF EXISTS source_snapshots",
      ),
      phase6.replace(
        "TO dasher_retention_definer\nUSING",
        "TO dasher_retention_operator\nUSING",
      ),
      phase6.replace("FOR SELECT\nTO", "FOR UPDATE\nTO"),
      phase6.replace("AS PERMISSIVE\nFOR SELECT", "AS RESTRICTIVE\nFOR SELECT"),
      phase6.replace(
        "target_finalizer.state = 'deleted'::text",
        "target_finalizer.state = 'eligible'::text",
      ),
      phase6.replace(
        "target_finalizer.proof_sha256 = target_finalizer.expected_claim_set_sha256",
        "target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256",
      ),
    ];

    for (const [index, mutant] of mutants.entries()) {
      expect(mutant, `policy source mutant ${index + 1}`).not.toBe(phase6);
      const directory = await temporaryDirectory();
      for (const [filename, bytes] of canonicalBytes) {
        await writeFile(
          join(directory, filename),
          filename === "0006_lifecycle_access_retention_guard_correction.sql"
            ? mutant
            : bytes,
        );
      }
      const scripted = scriptedMigrationClient();
      await expect(
        runMigrations(singleClientPool(scripted.client), directory, []),
        `policy source mutant ${index + 1}`,
      ).rejects.toMatchObject({ code: "migration_file_mismatch" });
      expect(scripted.transactionCommands).toEqual([
        "SESSION ADVISORY LOCK",
        "SESSION ADVISORY UNLOCK",
      ]);
      expect(scripted.phase6CorrectionSideEffectPresent).toBe(false);
      expect(scripted.phase6PolicyReplacements).toEqual([]);
      expect(scripted.journalRows).toEqual([]);
    }
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
  ])("rejects $name before canonical SQL", async ({ roleNames }) => {
    const series = await canonicalSuccessorSeries();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
      retentionRoleNames: roleNames,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
    expect(scripted.queryTexts).not.toContainEqual(
      expect.stringContaining(
        "-- Dasher immutable-content and lifecycle successor.",
      ),
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
      const series = await canonicalSuccessorSeries();
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
        expect.stringContaining(
          "-- Dasher immutable-content and lifecycle successor.",
        ),
      );
    },
  );

  it("rejects prepared-role membership, dependency, and premature-object drift before SQL", async () => {
    const series = await canonicalSuccessorSeries();
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
        prefixObjectMatches: true,
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
        expect.stringContaining(
          "-- Dasher immutable-content and lifecycle successor.",
        ),
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

  it("rejects both immutable canonical files renamed before any catalog or SQL query", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "0001_renamed_identity.sql"),
      await readFile(
        join(canonicalMigrationDirectory, "0001_identity_audit.sql"),
      ),
    );
    await writeFile(
      join(directory, "0002_renamed_security.sql"),
      await readFile(
        join(canonicalMigrationDirectory, "0002_security_boundary.sql"),
      ),
    );
    const scripted = scriptedMigrationClient();

    await expect(
      runMigrations(singleClientPool(scripted.client), directory, []),
    ).rejects.toMatchObject({ code: "migration_file_mismatch" });
    expect(scripted.queryTexts).toHaveLength(2);
    expect(
      scripted.queryTexts.filter((text) =>
        text.includes("pg_catalog.pg_advisory_lock("),
      ),
    ).toHaveLength(1);
    expect(
      scripted.queryTexts.filter((text) =>
        text.includes("pg_catalog.pg_advisory_unlock("),
      ),
    ).toHaveLength(1);
    expect(scripted.releaseArguments).toEqual([undefined]);
    expect(scripted.managedRoleEvents).toEqual([]);
  });

  it("leaves the exact committed pair after canonical SQL failure and accepts a same-file retry", async () => {
    const series = await canonicalSuccessorSeries();
    const scripted = scriptedMigrationClient({
      failure: { stage: "migration", transaction: 3 },
      initialJournalRows: series.journalRows,
      prefixObjectMatches: true,
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
    expect(
      scripted.queryTexts.filter((text) =>
        text.includes("pg_catalog.pg_advisory_lock("),
      ),
    ).toHaveLength(2);
    expect(
      scripted.queryTexts.filter((text) =>
        text.includes("pg_catalog.pg_advisory_unlock("),
      ),
    ).toHaveLength(2);
  });

  it.each([
    {
      name: "SQL",
      options: {
        failure: { stage: "migration", transaction: 3 },
      } satisfies ScriptedMigrationOptions,
    },
    {
      name: "catalog",
      options: {
        successorCatalogMatches: false,
      } satisfies ScriptedMigrationOptions,
    },
    {
      name: "ACL dependency",
      options: {
        dependencyMatches: [true, true, true, true, false],
      } satisfies ScriptedMigrationOptions,
    },
    {
      name: "journal",
      options: {
        failure: { stage: "journal", transaction: 3 },
      } satisfies ScriptedMigrationOptions,
    },
  ])(
    "rolls back canonical tenant SQL and journal after injected $name failure",
    async ({ options }) => {
      const series = await canonicalSuccessorSeries();
      const scripted = scriptedMigrationClient({
        ...options,
        initialJournalRows: series.journalRows,
        prefixObjectMatches: true,
      });

      await expect(
        runMigrations(singleClientPool(scripted.client), series.directory, []),
      ).rejects.toBeDefined();
      expect(transactionCommands(scripted, 2).at(-1)).toBe("T2 COMMIT");
      expect(transactionCommands(scripted, 3).at(-1)).toBe("T3 ROLLBACK");
      expect(scripted.journalRows).toEqual(series.journalRows);
      expect(scripted.canonicalSuccessorSideEffectPresent).toBe(false);
      expect(
        scripted.managedRoleEvents.filter((event) =>
          event.startsWith("CREATE dasher_retention_"),
        ),
      ).toEqual([
        "CREATE dasher_retention_definer",
        "CREATE dasher_retention_operator",
      ]);
      expect(
        scripted.managedRoleEvents.some((event) => event.startsWith("DROP ")),
      ).toBe(false);
    },
  );

  it("rejects the modeled probe with exact prepared-role residue before SQL and preserves state", async () => {
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
    ).rejects.toMatchObject({ code: "migration_file_mismatch" });
    expect(scripted.transactionCommands).toEqual([
      "SESSION ADVISORY LOCK",
      "SESSION ADVISORY UNLOCK",
    ]);
    expect(scripted.journalRows).toEqual(series.journalRows);
    expect(scripted.modeledSuccessorSideEffectPresent).toBe(false);
    expect(scripted.managedRoleEvents).toEqual([]);
  });

  it("explicitly resets only the exact owner-validated dependency-free pair in safe order", async () => {
    const series = await canonical0002Series();
    const scripted = scriptedMigrationClient({
      initialJournalRows: series.journalRows,
      prefixObjectMatches: true,
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
    expectExactlyOneSuccessfulSessionGate(scripted);
  });

  it("rejects overlapping reset allowlists before connecting", async () => {
    let connections = 0;
    const pool: MigrationPool = {
      async connect() {
        connections += 1;
        throw new Error("unexpected connection");
      },
    };

    await expect(
      resetPreparedRetentionRoles(
        pool,
        fixtureDirectory,
        ["shared_login"],
        ["shared_login"],
      ),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
    expect(connections).toBe(0);
  });

  it("refuses reset for partial roles, dependencies, or a pending different 0003 without dropping anything", async () => {
    const series = await canonical0002Series();
    const cases: readonly ScriptedMigrationOptions[] = [
      {
        initialJournalRows: series.journalRows,
        prefixObjectMatches: true,
        retentionRoleNames: ["dasher_retention_definer"],
      },
      {
        dependencyMatches: [false],
        initialJournalRows: series.journalRows,
        prefixObjectMatches: true,
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
      await readFile(modeledSuccessorFixture),
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
    {
      name: "managed role dasher_app",
      roleNames: ["dasher_app"],
    },
    {
      name: "managed role dasher_security_definer",
      roleNames: ["dasher_security_definer"],
    },
    {
      name: "managed role dasher_retention_definer",
      roleNames: ["dasher_retention_definer"],
    },
    {
      name: "managed role dasher_retention_operator",
      roleNames: ["dasher_retention_operator"],
    },
    { name: "empty name", roleNames: [""] },
    { name: "control byte", roleNames: ["dasher_test_\nlogin"] },
    { name: "overlength", roleNames: ["x".repeat(64)] },
  ])(
    "rejects $name expected-login input before connecting",
    async ({ roleNames }) => {
      for (const allowlists of [
        { app: roleNames, retention: [] },
        { app: [], retention: roleNames },
      ] as const) {
        let connections = 0;
        const pool: MigrationPool = {
          async connect() {
            connections += 1;
            throw new Error("unexpected connection");
          },
        };

        const failure = await capturedFailure(
          runMigrations(
            pool,
            fixtureDirectory,
            allowlists.app,
            allowlists.retention,
          ),
        );

        expect(failure).toMatchObject({ code: "managed_role_drift" });
        expect(connections).toBe(0);
      }
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

  it("accepts unordered app and retention logins with their exact closed memberships and CONNECT inventories", async () => {
    const appLoginNames = ["z_app_login", "a_app_login"];
    const retentionLoginNames = ["z_retention_login", "a_retention_login"];
    const scripted = scriptedMigrationClient({
      expectedLoginRows: [
        expectedLoginRow({ role_name: "z_app_login" }),
        expectedLoginRow({ role_name: "a_app_login" }),
      ],
      expectedRetentionLoginRows: [
        expectedRetentionLoginRow("a_retention_login"),
        expectedRetentionLoginRow("z_retention_login"),
      ],
      membershipRows: [
        expectedRetentionMembershipRowFor("z_retention_login"),
        expectedMembershipRowFor("a_app_login"),
        expectedRetentionMembershipRowFor("a_retention_login"),
        expectedMembershipRowFor("z_app_login"),
      ],
    });

    await expect(
      runMigrations(
        singleClientPool(scripted.client),
        fixtureDirectory,
        appLoginNames,
        retentionLoginNames,
      ),
    ).resolves.toEqual({
      appliedCount: 2,
      discoveredCount: 2,
      previouslyAppliedCount: 0,
    });

    const expectedTargets = [
      ...expectedManagedDependencyRoleNames,
      ...[...appLoginNames].sort(),
      ...[...retentionLoginNames].sort(),
    ];
    expect(scripted.dependencyRoleNames).toHaveLength(3);
    expect(
      scripted.dependencyRoleNames.every((roleNames) =>
        arraysEqualForTest(roleNames, expectedTargets),
      ),
    ).toBe(true);
    for (const inventory of scripted.dependencyInventories) {
      expect(inventory.map((entry) => entry.role_name).sort()).toEqual(
        [...appLoginNames, ...retentionLoginNames].sort(),
      );
      expect(
        inventory.every(
          (entry) =>
            entry.object_kind === "database" &&
            entry.object_name === "dasher_test" &&
            entry.privilege_type === "CONNECT" &&
            entry.is_grantable === false,
        ),
      ).toBe(true);
      expect(JSON.stringify(inventory)).not.toContain("password");
      expect(JSON.stringify(inventory)).not.toContain("postgres://");
    }
  });

  it("rejects app/retention allowlist overlap before connecting", async () => {
    let connections = 0;
    const pool: MigrationPool = {
      async connect() {
        connections += 1;
        throw new Error("unexpected connection");
      },
    };

    await expect(
      runMigrations(pool, fixtureDirectory, ["shared_login"], ["shared_login"]),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
    expect(connections).toBe(0);
  });

  it.each([
    { app: ["app_login"], name: "app", retention: [] },
    { app: [], name: "retention", retention: ["retention_login"] },
  ])(
    "requires the $name allowlist to be empty while base roles are absent",
    async ({ app, retention }) => {
      const scripted = scriptedMigrationClient({
        managedRoleReads: {
          dasher_app: [undefined],
          dasher_security_definer: [undefined],
        },
      });

      await expect(
        runMigrations(
          singleClientPool(scripted.client),
          fixtureDirectory,
          app,
          retention,
        ),
      ).rejects.toMatchObject({ code: "managed_role_drift" });
      expect(scripted.managedRoleEvents).not.toContain("CREATE dasher_app");
      expect(scripted.managedRoleEvents).not.toContain(
        "CREATE dasher_security_definer",
      );
    },
  );

  it.each([
    {
      name: "wrong marker",
      row: expectedRetentionLoginRow("retention_login", {
        comment: "dasher:app-login:v1:database-oid:16384",
      }),
    },
    {
      name: "wrong database marker",
      row: expectedRetentionLoginRow("retention_login", {
        comment: "dasher:retention-login:v1:database-oid:99999",
      }),
    },
    {
      name: "unsafe attribute",
      row: expectedRetentionLoginRow("retention_login", {
        bypass_rls: true,
      }),
    },
  ])("rejects retention-login catalog drift: $name", async ({ row }) => {
    const scripted = scriptedMigrationClient({
      expectedRetentionLoginRows: [row],
      membershipRows: [expectedRetentionMembershipRowFor("retention_login")],
    });

    await expect(
      runMigrations(
        singleClientPool(scripted.client),
        fixtureDirectory,
        [],
        ["retention_login"],
      ),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
  });

  it.each([
    { name: "missing", rows: [] },
    {
      name: "duplicate",
      rows: [
        expectedRetentionMembershipRowFor("retention_login"),
        expectedRetentionMembershipRowFor("retention_login"),
      ],
    },
    {
      name: "wrong granted role",
      rows: [expectedMembershipRowFor("retention_login")],
    },
    {
      name: "grant option",
      rows: [
        {
          ...expectedRetentionMembershipRowFor("retention_login"),
          admin_option: true,
        },
      ],
    },
    {
      name: "wrong membership options",
      rows: [
        {
          ...expectedRetentionMembershipRowFor("retention_login"),
          inherit_option: true,
          set_option: false,
        },
      ],
    },
    {
      name: "extra outgoing authority",
      rows: [
        expectedRetentionMembershipRowFor("retention_login"),
        {
          ...expectedRetentionMembershipRowFor("retention_login"),
          granted_role_name: "synthetic_parent",
          member_role_name: "dasher_retention_operator",
        },
      ],
    },
  ])("rejects retention membership drift: $name", async ({ rows }) => {
    const scripted = scriptedMigrationClient({
      expectedRetentionLoginRows: [
        expectedRetentionLoginRow("retention_login"),
      ],
      membershipRows: rows,
    });

    await expect(
      runMigrations(
        singleClientPool(scripted.client),
        fixtureDirectory,
        [],
        ["retention_login"],
      ),
    ).rejects.toMatchObject({ code: "managed_role_drift" });
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
      prefixObjectMatches: true,
    });

    await expect(
      runMigrations(singleClientPool(scripted.client), series.directory, []),
    ).resolves.toMatchObject({
      appliedCount: 0,
      previouslyAppliedCount: 2,
    });

    expect(scripted.dependencyInventories).toHaveLength(3);
    const catalogContract = scripted.catalogContracts.at(-1);
    expect(catalogContract).toBeDefined();
    expect(
      (catalogContract?.acls ?? []).filter(
        (signature) =>
          signature.startsWith("type|dasher.") &&
          signature.endsWith("|migration_owner|PUBLIC|USAGE|false"),
      ),
    ).toEqual(
      [
        "audit_events",
        "external_identities",
        "invitations",
        "memberships",
        "organizations",
        "sessions",
        "users",
      ].map(
        (relationName) =>
          `type|dasher.${relationName}|migration_owner|PUBLIC|USAGE|false`,
      ),
    );
    for (const signature of catalogContract?.constraints ?? []) {
      const constraintType = signature.split("|")[3];
      expect(["c", "p", "u"]).toContain(constraintType);
      const expectedNoInherit =
        constraintType === "p" || constraintType === "u";
      expect(signature.endsWith(`|${String(expectedNoInherit)}`)).toBe(true);
    }
    expect(catalogContract?.triggers).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "CREATE TRIGGER audit_events_immutable BEFORE DELETE OR UPDATE ON dasher.audit_events",
        ),
      ]),
    );
    expect(catalogContract?.triggers).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON dasher.audit_events",
        ),
      ]),
    );
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
      expect(
        inventory.filter((entry) => entry.object_kind === "policy"),
      ).toEqual(
        expect.arrayContaining(
          [
            "audit_events_select",
            "invitations_select",
            "memberships_select",
            "organizations_select",
            "sessions_select",
          ].map((policyName) =>
            expect.objectContaining({
              dependency_type: "r",
              is_grantable: null,
              policy_name: policyName,
              policy_command: "r",
              policy_permissive: true,
              policy_roles: ["dasher_app"],
              role_name: "dasher_app",
            }),
          ),
        ),
      );
      expect(
        inventory
          .filter((entry) => entry.dependency_type === "a")
          .every((entry) => entry.is_grantable === false),
      ).toBe(true);
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
      prefixObjectMatches: true,
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
    expect(
      scripted.dependencyInventories[2]?.filter(
        (entry) => entry.dependency_type === "r",
      ),
    ).toHaveLength(5);
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
      prefixObjectMatches: true,
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
      prefixObjectMatches: true,
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
  it("destructively releases when run lock acquisition is ownership-ambiguous", async () => {
    const lockError = new Error("synthetic session gate acquisition failure");
    const scripted = scriptedMigrationClient({ sessionLockError: lockError });

    await expect(
      runMigrations(singleClientPool(scripted.client), fixtureDirectory, []),
    ).rejects.toBe(lockError);
    expect(scripted.transactionCommands).toEqual(["SESSION ADVISORY LOCK"]);
    expect(scripted.releaseArguments).toHaveLength(1);
    expect(scripted.releaseArguments[0]).toMatchObject({
      name: "MigrationGateAcquisitionError",
      message:
        "PostgreSQL migrator advisory gate acquisition was ambiguous; pooled client destroyed",
    });
    expect(scripted.releaseArguments).not.toContain(undefined);
    expect(scripted.queryTexts).toHaveLength(1);
  });

  it("destructively releases when reset lock acquisition is ownership-ambiguous", async () => {
    const lockError = new Error(
      "synthetic reset session gate acquisition failure",
    );
    const scripted = scriptedMigrationClient({ sessionLockError: lockError });

    await expect(
      resetPreparedRetentionRoles(
        singleClientPool(scripted.client),
        canonicalMigrationDirectory,
        [],
      ),
    ).rejects.toBe(lockError);
    expect(scripted.transactionCommands).toEqual(["SESSION ADVISORY LOCK"]);
    expect(scripted.releaseArguments).toHaveLength(1);
    expect(scripted.releaseArguments[0]).toMatchObject({
      name: "MigrationGateAcquisitionError",
      message:
        "PostgreSQL migrator advisory gate acquisition was ambiguous; pooled client destroyed",
    });
    expect(scripted.releaseArguments).not.toContain(undefined);
    expect(scripted.queryTexts).toHaveLength(1);
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
    expectExactlyOneSuccessfulSessionGate(scripted);
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
