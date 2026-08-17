import { Pool } from "pg";

/**
 * The application's connection pool, and the credential a request presents.
 *
 * WHY A MODULE-LEVEL POOL. A pool per request would open a connection per
 * request, which is the thing a pool exists to avoid. Next.js keeps module
 * state for the lifetime of the server process, so one pool is created lazily
 * and reused — and stashed on `globalThis` because the dev server re-evaluates
 * modules on change and would otherwise leak a pool per edit.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not query. Everything that
 * touches tenant data goes through `withDashboardRepository`, which owns the
 * transaction and the request context; a helper here that ran a statement would
 * be a second data path with none of that. The pool is handed over and nothing
 * else.
 */

const POOL_KEY = Symbol.for("dasher.web.pool");

interface PoolCarrier {
  [POOL_KEY]?: Pool;
}

/**
 * `undefined` when the app is running without a database, which is still a
 * supported way to run it: the planner and the renderer need no persistence,
 * and the fixture demo predates the control plane entirely.
 */
export function databaseUrl(): string | undefined {
  const value = process.env["DASHER_DATABASE_URL"];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function isPersistenceConfigured(): boolean {
  return databaseUrl() !== undefined;
}

export function getPool(): Pool {
  const url = databaseUrl();
  if (url === undefined) {
    // Callers are expected to check `isPersistenceConfigured` first. Reaching
    // here means a code path assumed a database that was never configured, and
    // failing loudly beats returning a pool that cannot connect and surfacing
    // as a timeout somewhere unrelated.
    throw new Error(
      "DASHER_DATABASE_URL is not set; persistence is unavailable",
    );
  }

  const carrier = globalThis as PoolCarrier;
  const existing = carrier[POOL_KEY];
  if (existing !== undefined) return existing;

  const pool = new Pool({ connectionString: url, max: 8 });
  // An idle client that errors — the server restarting, a network drop — emits
  // on the pool. Without a listener, node treats it as an unhandled error event
  // and takes the process down, which is a strange way for a web server to die.
  pool.on("error", () => undefined);
  carrier[POOL_KEY] = pool;
  return pool;
}

const SEED_POOL_KEY = Symbol.for("dasher.web.devSeedPool");

interface SeedPoolCarrier {
  [SEED_POOL_KEY]?: Pool;
}

/**
 * A schema-owner pool, for the development bootstrap and nothing else.
 *
 * Kept apart from `getPool` deliberately. The application's pool connects as a
 * role that cannot write `dasher.organizations` — proven by the bootstrap
 * failing with `permission denied for table organizations` before this existed
 * — and that restriction is the point rather than an obstacle. Seeding needs
 * more authority, so it gets a connection a production deployment simply never
 * configures, instead of the application role being granted what it must not
 * have.
 *
 * `undefined` when unset, which is every environment that is not a developer's.
 */
export function devSeedPool(): Pool | undefined {
  const url = process.env["DASHER_DEV_SEED_DSN"];
  if (url === undefined || url.trim() === "") return undefined;

  const carrier = globalThis as SeedPoolCarrier;
  const existing = carrier[SEED_POOL_KEY];
  if (existing !== undefined) return existing;

  const pool = new Pool({ connectionString: url, max: 2 });
  pool.on("error", () => undefined);
  carrier[SEED_POOL_KEY] = pool;
  return pool;
}
