import { expect, it } from "vitest";

import { MigrationContractError, type MigrationClient } from "./migrator";
import { prepareMigration } from "./migrate";

it("checks ownership before issuing any cluster-wide role query", async () => {
  const queries: string[] = [];
  const client: MigrationClient = {
    query: (async (sql: string) => {
      queries.push(sql);
      if (!sql.includes("pg_catalog.pg_database")) {
        throw new Error("role bootstrap ran before ownership was established");
      }
      return { rows: [{ is_owner: false }] };
    }) as MigrationClient["query"],
    release: () => undefined,
  };

  let refusal: unknown;
  try {
    await prepareMigration(client, []);
  } catch (error) {
    refusal = error;
  }

  expect(refusal).toBeInstanceOf(MigrationContractError);
  expect((refusal as MigrationContractError).code).toBe(
    "executor_not_database_owner",
  );
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain("pg_catalog.pg_database");
});
