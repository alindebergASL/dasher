import { describe, expect, it } from "vitest";

import {
  IntegrationPreflightError,
  parsePostgresIntegrationEnv,
  type PostgresIntegrationEnvironment,
} from "../src/index";

const ownerDsn =
  "postgresql://owner_marker:owner_password_marker@localhost:5432/dasher_marker";
const appUsername = "dasher_test_0123456789abcdef0123456789abcdef";
const appDsn = `postgresql://${appUsername}:app_password_marker@localhost:5432/dasher_marker`;
const hmacKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";

const validEnvironment = {
  DASHER_TEST_OWNER_DSN: ownerDsn,
  DASHER_TEST_APP_DSN: appDsn,
  DASHER_TEST_HMAC_KEY_B64URL: hmacKey,
} satisfies PostgresIntegrationEnvironment;

function captureError(environment: PostgresIntegrationEnvironment) {
  try {
    parsePostgresIntegrationEnv(environment);
  } catch (error) {
    expect(error).toBeInstanceOf(IntegrationPreflightError);
    return error as IntegrationPreflightError;
  }

  throw new Error("expected integration preflight to reject the environment");
}

describe("parsePostgresIntegrationEnv", () => {
  it("returns typed, decoded configuration for a complete valid environment", () => {
    const result = parsePostgresIntegrationEnv(validEnvironment);

    expect(result).toEqual({
      ownerDsn,
      appDsn,
      ownerUsername: "owner_marker",
      appUsername,
      ownerDatabase: "dasher_marker",
      appDatabase: "dasher_marker",
      hmacKey: expect.any(Uint8Array),
    });
    expect(result.hmacKey).toHaveLength(32);
  });

  it("rejects every missing or partial variable set", () => {
    const names = Object.keys(
      validEnvironment,
    ) as (keyof PostgresIntegrationEnvironment)[];

    for (let mask = 0; mask < 2 ** names.length - 1; mask += 1) {
      const environment: Record<string, string> = {};

      names.forEach((name, index) => {
        if ((mask & (1 << index)) !== 0) {
          environment[name] = validEnvironment[name]!;
        }
      });

      expect(captureError(environment).code).toBe("invalid_variable_set");
    }
  });

  it.each([
    ["owner", { ...validEnvironment, DASHER_TEST_OWNER_DSN: "not a URL" }],
    ["app", { ...validEnvironment, DASHER_TEST_APP_DSN: "not a URL" }],
    [
      "owner protocol",
      {
        ...validEnvironment,
        DASHER_TEST_OWNER_DSN:
          "https://owner_marker:owner_password_marker@localhost/dasher_marker",
      },
    ],
    [
      "app protocol",
      {
        ...validEnvironment,
        DASHER_TEST_APP_DSN: `https://${appUsername}:app_password_marker@localhost/dasher_marker`,
      },
    ],
    [
      "owner username",
      {
        ...validEnvironment,
        DASHER_TEST_OWNER_DSN:
          "postgresql://:owner_password_marker@localhost/dasher_marker",
      },
    ],
    [
      "owner password",
      {
        ...validEnvironment,
        DASHER_TEST_OWNER_DSN:
          "postgresql://owner_marker@localhost/dasher_marker",
      },
    ],
    [
      "app username",
      {
        ...validEnvironment,
        DASHER_TEST_APP_DSN:
          "postgresql://:app_password_marker@localhost/dasher_marker",
      },
    ],
    [
      "app password",
      {
        ...validEnvironment,
        DASHER_TEST_APP_DSN: `postgresql://${appUsername}@localhost/dasher_marker`,
      },
    ],
  ])("rejects a malformed %s DSN", (_label, environment) => {
    expect(captureError(environment).code).toBe("invalid_dsn");
  });

  it("rejects byte-identical owner and app DSNs", () => {
    const equalDsn = `postgresql://${appUsername}:marker_password@localhost/dasher_marker`;

    expect(
      captureError({
        ...validEnvironment,
        DASHER_TEST_OWNER_DSN: equalDsn,
        DASHER_TEST_APP_DSN: equalDsn,
      }).code,
    ).toBe("equal_dsns");
  });

  it("rejects distinct DSNs with the same username", () => {
    expect(
      captureError({
        ...validEnvironment,
        DASHER_TEST_OWNER_DSN: `postgresql://${appUsername}:owner_password_marker@localhost/dasher_marker`,
      }).code,
    ).toBe("same_username");
  });

  it.each([
    [
      "owner",
      {
        ...validEnvironment,
        DASHER_TEST_OWNER_DSN:
          "postgresql://owner_marker:owner_password_marker@localhost",
      },
    ],
    [
      "app",
      {
        ...validEnvironment,
        DASHER_TEST_APP_DSN: `postgresql://${appUsername}:app_password_marker@localhost`,
      },
    ],
  ])("rejects a missing %s database", (_label, environment) => {
    expect(captureError(environment).code).toBe("missing_database");
  });

  it.each([
    [
      "owner query",
      {
        ...validEnvironment,
        DASHER_TEST_OWNER_DSN: `${ownerDsn}?options=-c%20role%3Ddasher_app`,
      },
    ],
    [
      "app query",
      {
        ...validEnvironment,
        DASHER_TEST_APP_DSN: `${appDsn}?sslmode=disable`,
      },
    ],
    [
      "fragment",
      {
        ...validEnvironment,
        DASHER_TEST_APP_DSN: `${appDsn}#ignored-marker`,
      },
    ],
    [
      "nested database path",
      {
        ...validEnvironment,
        DASHER_TEST_APP_DSN: `${appDsn}/other`,
      },
    ],
    [
      "encoded database slash",
      {
        ...validEnvironment,
        DASHER_TEST_APP_DSN: `postgresql://${appUsername}:***@localhost/dasher%2Fother`,
      },
    ],
    [
      "encoded database backslash",
      {
        ...validEnvironment,
        DASHER_TEST_APP_DSN: `postgresql://${appUsername}:***@localhost/dasher%5Cother`,
      },
    ],
    [
      "database control character",
      {
        ...validEnvironment,
        DASHER_TEST_APP_DSN: `postgresql://${appUsername}:***@localhost/dasher%00marker`,
      },
    ],
  ])("rejects unsafe DSN components in %s", (_label, environment) => {
    expect(captureError(environment).code).toBe("unsafe_dsn_components");
  });

  it.each([
    ["weak", "MDEyMzQ1Njc4OWFiY2RlZg"],
    ["padded", `${hmacKey}=`],
    ["invalid alphabet", `${hmacKey.slice(0, -1)}+`],
    ["non-canonical", `${hmacKey.slice(0, -1)}Z`],
  ])("rejects a %s HMAC key", (_label, candidate) => {
    expect(
      captureError({
        ...validEnvironment,
        DASHER_TEST_HMAC_KEY_B64URL: candidate,
      }).code,
    ).toBe("invalid_hmac_key");
  });

  it.each([
    "dasher_test_0123456789abcdef",
    "dasher_test_0123456789ABCDEF0123456789ABCDEF",
    "dasher-test-0123456789abcdef0123456789abcdef",
    "dasher_test_0123456789abcdef0123456789abcdeg",
  ])("rejects the invalid app login name %s", (candidate) => {
    expect(
      captureError({
        ...validEnvironment,
        DASHER_TEST_APP_DSN: `postgresql://${candidate}:app_password_marker@localhost/dasher_marker`,
      }).code,
    ).toBe("invalid_app_username");
  });

  it("never discloses marker DSNs, passwords, usernames, database, or key", () => {
    const error = captureError({
      ...validEnvironment,
      DASHER_TEST_APP_DSN: `postgresql://${appUsername}:app_password_marker@localhost`,
    });
    const rendered = [
      error.name,
      error.message,
      error.stack,
      String(error),
      JSON.stringify(error),
    ].join("\n");

    for (const marker of [
      ownerDsn,
      appDsn,
      "owner_marker",
      "owner_password_marker",
      appUsername,
      "app_password_marker",
      "dasher_marker",
      hmacKey,
    ]) {
      expect(rendered).not.toContain(marker);
    }
  });
});
