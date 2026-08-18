import type { MigrationClient } from "./migrator";

/**
 * Renders the live schema as deterministic text.
 *
 * This replaces the hand-authored catalog manifest that the migrator used to
 * carry. The manifest was a second copy of the schema, typed by a person, that
 * had to be edited in lockstep with every migration; its only job was to be
 * compared against the first copy. This does the same job by generating the
 * second copy from `pg_catalog`, so it cannot drift from the migration and
 * costs nothing to maintain. When the schema changes intentionally, regenerate
 * and commit — and review that diff, which reads as the schema change itself.
 *
 * It reads the catalog rather than shelling out to `pg_dump` because the
 * generated-code gate forbids execution sinks in first-party source, and
 * because it removes a dependency on a client binary matching the server.
 *
 * Every ORDER BY forces the C collation. Plain `ORDER BY 1` sorts under the
 * server's collation, which orders `dashboard_versions_...` against
 * `dashboards_...` differently on a C cluster than on an en_US.utf8 one — the
 * same schema then renders two ways and the comparison fails on ordering
 * alone. Explicit ordering is not the same as deterministic ordering.
 */

const managedSchemas = ["dasher", "dasher_private"] as const;
const schemaList = managedSchemas.map((name) => `'${name}'`).join(", ");

/**
 * Routines are captured across a wider set than tables are, because
 * `dasher_api` is where the callable surface lives and it holds no tables at
 * all. Leaving it out meant the signature, `SECURITY DEFINER` flag, and
 * `search_path` of every entry point — `record_evidence` among them — could
 * change without the snapshot noticing. A gate's scope is part of the gate, and
 * this one's scope silently excluded the schema most worth watching.
 */
const routineSchemas = [...managedSchemas, "dasher_api"] as const;
const routineSchemaList = routineSchemas.map((name) => `'${name}'`).join(", ");

interface TextRow {
  readonly line: string;
}

async function lines(
  client: MigrationClient,
  sql: string,
): Promise<readonly string[]> {
  // Ordering lives here, not in the section queries, so no caller can forget
  // it and no caller can get it subtly wrong. `COLLATE "C"` forces byte order:
  // under a locale collation such as en_US.UTF-8, `_` is ignored at the primary
  // level, so `dashboards_active_idx` sorts before
  // `dashboard_versions_dashboard_created_idx` while byte order puts them the
  // other way round. The same schema would then render two ways and the
  // comparison would fail on ordering alone. Explicit ordering is not the same
  // as deterministic ordering.
  const result = await client.query<TextRow>(
    `SELECT rendered.line FROM (${sql}) AS rendered
     ORDER BY rendered.line COLLATE "C"`,
  );
  // One catalog object per physical line. PostgreSQL pretty-prints some
  // definitions across several lines (a CHECK carrying a CASE, for one), which
  // would make an entry span lines and turn a one-object change into a
  // multi-line diff hunk.
  return result.rows.map((row) => row.line.replace(/\s+/gu, " ").trim());
}

function section(title: string, body: readonly string[]): readonly string[] {
  if (body.length === 0) {
    return [];
  }
  return [`-- ${title}`, ...body, ""];
}

export async function renderSchemaSnapshot(
  client: MigrationClient,
): Promise<string> {
  const columns = await lines(
    client,
    `
    SELECT pg_catalog.format(
      '%s.%s.%s %s%s%s',
      namespace.nspname, relation.relname, attribute.attname,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
      CASE WHEN attribute.attnotnull THEN ' NOT NULL' ELSE '' END,
      COALESCE(
        ' DEFAULT ' || pg_catalog.pg_get_expr(
          default_value.adbin, default_value.adrelid
        ),
        ''
      )
    ) AS line
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef AS default_value
      ON default_value.adrelid = relation.oid
     AND default_value.adnum = attribute.attnum
    WHERE namespace.nspname IN (${schemaList})
      AND relation.relkind = 'r'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  `,
  );

  const constraints = await lines(
    client,
    `
    SELECT pg_catalog.format(
      '%s.%s %s %s',
      namespace.nspname, relation.relname, constraint_row.conname,
      pg_catalog.pg_get_constraintdef(constraint_row.oid)
    ) AS line
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN (${schemaList})
  `,
  );

  const indexes = await lines(
    client,
    `
    SELECT pg_catalog.pg_get_indexdef(index_row.indexrelid) AS line
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS relation ON relation.oid = index_row.indrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN (${schemaList})
  `,
  );

  const rowSecurity = await lines(
    client,
    `
    SELECT pg_catalog.format(
      '%s.%s rls=%s force=%s',
      namespace.nspname, relation.relname,
      relation.relrowsecurity::text, relation.relforcerowsecurity::text
    ) AS line
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN (${schemaList}) AND relation.relkind = 'r'
  `,
  );

  const policies = await lines(
    client,
    `
    SELECT pg_catalog.format(
      '%s.%s %s %s %s roles=%s using=%s check=%s',
      namespace.nspname, relation.relname, policy.polname,
      policy.polcmd, CASE WHEN policy.polpermissive THEN 'PERMISSIVE'
                          ELSE 'RESTRICTIVE' END,
      COALESCE(
        (
          SELECT pg_catalog.string_agg(role_row.rolname::text, ',' ORDER BY role_row.rolname COLLATE "C")
          FROM pg_catalog.pg_roles AS role_row
          WHERE role_row.oid = ANY (policy.polroles)
        ),
        'PUBLIC'
      ),
      COALESCE(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid), 'none'
      ),
      COALESCE(
        pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid), 'none'
      )
    ) AS line
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN (${schemaList})
  `,
  );

  const triggers = await lines(
    client,
    `
    SELECT pg_catalog.pg_get_triggerdef(trigger_row.oid) AS line
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN (${schemaList})
      AND NOT trigger_row.tgisinternal
  `,
  );

  const functions = await lines(
    client,
    `
    SELECT pg_catalog.format(
      '%s.%s(%s) -> %s volatility=%s security_definer=%s search_path=%s',
      namespace.nspname, routine.proname,
      pg_catalog.pg_get_function_identity_arguments(routine.oid),
      pg_catalog.format_type(routine.prorettype, NULL),
      routine.provolatile, routine.prosecdef::text,
      COALESCE(pg_catalog.array_to_string(routine.proconfig, ','), 'unset')
    ) AS line
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname IN (${routineSchemaList})
  `,
  );

  /**
   * Execute privileges on those routines, including the absence of a PUBLIC
   * grant. `role_table_grants` below covers tables only, so a `SECURITY
   * DEFINER` entry point could have been granted to PUBLIC — turning it into an
   * unauthenticated write path — with nothing here to see it.
   *
   * `proacl` is null when a routine has never been granted or revoked, which in
   * PostgreSQL means the default: EXECUTE to PUBLIC. That case is rendered
   * explicitly rather than omitted, because an empty line and a wide-open
   * default would otherwise look identical.
   */
  const routineGrants = await lines(
    client,
    `
    SELECT pg_catalog.format(
      '%s.%s(%s) %s',
      namespace.nspname, routine.proname,
      pg_catalog.pg_get_function_identity_arguments(routine.oid),
      CASE
        WHEN routine.proacl IS NULL THEN 'default (EXECUTE to PUBLIC)'
        ELSE pg_catalog.array_to_string(routine.proacl::text[], ' ')
      END
    ) AS line
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname IN (${routineSchemaList})
  `,
  );

  const grants = await lines(
    client,
    `
    SELECT pg_catalog.format(
      '%s.%s %s %s',
      grant_row.table_schema, grant_row.table_name,
      grant_row.grantee, grant_row.privilege_type
    ) AS line
    FROM information_schema.role_table_grants AS grant_row
    WHERE grant_row.table_schema IN (${schemaList})
  `,
  );

  const roleAttributes = await lines(
    client,
    `
    SELECT pg_catalog.format(
      '%s superuser=%s bypassrls=%s login=%s',
      role_row.rolname, role_row.rolsuper::text, role_row.rolbypassrls::text,
      role_row.rolcanlogin::text
    ) AS line
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'dasher_app'
  `,
  );

  return (
    [
      ...section("columns", columns),
      ...section("constraints", constraints),
      ...section("indexes", indexes),
      ...section("row security", rowSecurity),
      ...section("policies", policies),
      ...section("triggers", triggers),
      ...section("functions", functions),
      ...section("routine grants", routineGrants),
      ...section("grants", grants),
      ...section("managed roles", roleAttributes),
    ]
      .join("\n")
      .trim() + "\n"
  );
}
