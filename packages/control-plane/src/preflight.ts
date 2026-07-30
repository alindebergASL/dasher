import { z } from "zod";

export const POSTGRES_INTEGRATION_ENV_NAMES = [
  "DASHER_TEST_OWNER_DSN",
  "DASHER_TEST_APP_DSN",
  "DASHER_TEST_HMAC_KEY_B64URL",
] as const;

type PostgresIntegrationEnvName =
  (typeof POSTGRES_INTEGRATION_ENV_NAMES)[number];

export type PostgresIntegrationEnvironment = Readonly<
  Partial<Record<PostgresIntegrationEnvName, string | undefined>>
>;

export type IntegrationPreflightErrorCode =
  | "equal_dsns"
  | "invalid_app_username"
  | "invalid_dsn"
  | "invalid_hmac_key"
  | "invalid_variable_set"
  | "missing_database"
  | "same_username"
  | "unsafe_dsn_components";

export interface PostgresIntegrationConfig {
  readonly ownerDsn: string;
  readonly appDsn: string;
  readonly ownerUsername: string;
  readonly appUsername: string;
  readonly ownerDatabase: string;
  readonly appDatabase: string;
  readonly hmacKey: Uint8Array;
}

export class IntegrationPreflightError extends Error {
  readonly code: IntegrationPreflightErrorCode;

  constructor(code: IntegrationPreflightErrorCode) {
    super(`PostgreSQL integration preflight rejected the environment: ${code}`);
    this.name = "IntegrationPreflightError";
    this.code = code;
  }
}

const requiredEnvironmentSchema = z.object({
  DASHER_TEST_OWNER_DSN: z.string().min(1),
  DASHER_TEST_APP_DSN: z.string().min(1),
  DASHER_TEST_HMAC_KEY_B64URL: z.string().min(1),
});

const appUsernamePattern = /^dasher_test_[0-9a-f]{32}$/;
const hmacKeyPattern = /^[A-Za-z0-9_-]{43}$/;

interface ParsedDsn {
  readonly username: string;
  readonly database: string;
}

function reject(code: IntegrationPreflightErrorCode): never {
  throw new IntegrationPreflightError(code);
}

function decodeUrlComponent(component: string): string {
  try {
    return decodeURIComponent(component);
  } catch {
    return reject("invalid_dsn");
  }
}

function parseDsn(dsn: string): ParsedDsn {
  let url: URL;

  try {
    url = new URL(dsn);
  } catch {
    return reject("invalid_dsn");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return reject("invalid_dsn");
  }

  if (
    url.hostname.length === 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname.slice(1).includes("/")
  ) {
    return reject("unsafe_dsn_components");
  }

  const username = decodeUrlComponent(url.username);
  const password = decodeUrlComponent(url.password);

  if (username.length === 0 || password.length === 0) {
    return reject("invalid_dsn");
  }

  if (url.pathname.length <= 1) {
    return reject("missing_database");
  }

  const database = decodeUrlComponent(url.pathname.slice(1));
  if (database.length === 0) {
    return reject("missing_database");
  }

  if (
    database.includes("/") ||
    database.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(database)
  ) {
    return reject("unsafe_dsn_components");
  }

  return { username, database };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function parseHmacKey(encoded: string): Uint8Array {
  if (!hmacKeyPattern.test(encoded)) {
    return reject("invalid_hmac_key");
  }

  try {
    const standardBase64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(`${standardBase64}=`);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );

    if (bytes.length !== 32 || base64UrlEncode(bytes) !== encoded) {
      return reject("invalid_hmac_key");
    }

    return bytes;
  } catch {
    return reject("invalid_hmac_key");
  }
}

export function parsePostgresIntegrationEnv(
  environment: PostgresIntegrationEnvironment,
): PostgresIntegrationConfig {
  const parsedEnvironment = requiredEnvironmentSchema.safeParse({
    DASHER_TEST_OWNER_DSN: environment.DASHER_TEST_OWNER_DSN,
    DASHER_TEST_APP_DSN: environment.DASHER_TEST_APP_DSN,
    DASHER_TEST_HMAC_KEY_B64URL: environment.DASHER_TEST_HMAC_KEY_B64URL,
  });

  if (!parsedEnvironment.success) {
    return reject("invalid_variable_set");
  }

  const {
    DASHER_TEST_OWNER_DSN: ownerDsn,
    DASHER_TEST_APP_DSN: appDsn,
    DASHER_TEST_HMAC_KEY_B64URL: encodedHmacKey,
  } = parsedEnvironment.data;

  if (ownerDsn === appDsn) {
    return reject("equal_dsns");
  }

  const owner = parseDsn(ownerDsn);
  const app = parseDsn(appDsn);

  if (owner.username === app.username) {
    return reject("same_username");
  }

  if (!appUsernamePattern.test(app.username)) {
    return reject("invalid_app_username");
  }

  return {
    ownerDsn,
    appDsn,
    ownerUsername: owner.username,
    appUsername: app.username,
    ownerDatabase: owner.database,
    appDatabase: app.database,
    hmacKey: parseHmacKey(encodedHmacKey),
  };
}
