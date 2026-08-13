import type { MigrationClient } from "./migrator.js";

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
 * Ordering is explicit everywhere so the output is stable across servers.
 */

const managedSchemas = ["dasher", "dasher_private"] as const;
const schemaList = managedSchemas.map((name) => `'${name}'`).join(", ");

interface TextRow {
  readonly line: string;
}

async function lines(
  client: MigrationClient,
  sql: string,
): Promise<readonly string[]> {
  const result = await client.query<TextRow>(sql);
  return result.rows.map((row) => row.line);
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
    ORDER BY 1
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
    ORDER BY 1
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
    ORDER BY 1
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
    ORDER BY 1
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
          SELECT pg_catalog.string_agg(role_row.rolname::text, ',' ORDER BY 1)
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
    ORDER BY 1
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
    ORDER BY 1
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
    WHERE namespace.nspname IN (${schemaList})
    ORDER BY 1
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
    ORDER BY 1
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
    ORDER BY 1
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
      ...section("grants", grants),
      ...section("managed roles", roleAttributes),
    ]
      .join("\n")
      .trim() + "\n"
  );
}
