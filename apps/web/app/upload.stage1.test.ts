// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readUpload } from "./upload";

const encoder = new TextEncoder();
const GENERIC_REFUSAL =
  "This dataset can't be used because it may contain credentials. Remove sensitive fields and try again. The current dashboard is unchanged.";

function expectCredentialRefusal(
  text: string,
  forbidden: readonly string[],
): void {
  const read = readUpload("synthetic-dataset.csv", encoder.encode(text));
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.message).toBe(GENERIC_REFUSAL);
  for (const value of forbidden) {
    expect(read.message.toLowerCase()).not.toContain(value.toLowerCase());
  }
}

describe("stage 1 credential-safe upload ingestion", () => {
  it.each([
    "Password",
    "User Password",
    "API Token",
    "Authorization Status Token",
    "client_secret",
    "Access Token",
    "X-API-Key",
    "PrivateKey",
    "Session ID",
    "session_token",
    "Cookie",
    "Authorization",
    "Credential",
  ])(
    "refuses the credential-indicating header %s without echoing it",
    (header) => {
      const placeholder = "SYNTHETIC-TEST-PLACEHOLDER";
      expectCredentialRefusal(
        `Amount,${header}\n10,${placeholder}\n20,${placeholder}\n`,
        [
          // The required generic refusal itself says "credentials", so the
          // singular header "Credential" cannot also be asserted absent.
          ...(header === "Credential" ? [] : [header]),
          placeholder,
        ],
      );
    },
  );

  it("uses the generic credential refusal even when the dataset has no measure", () => {
    const marker = "SYNTHETIC-TEST-PLACEHOLDER";
    expectCredentialRefusal(`Password\n${marker}\n`, ["Password", marker]);
  });

  it.each([
    ["bearer", `Bearer ${"A".repeat(24)}`],
    ["basic", `Basic ${"U1lOVEhFVElD".repeat(2)}`],
    ["PEM private key begin", "-----BEGIN PRIVATE KEY-----"],
    ["JWT", `eyJ${"A".repeat(12)}.eyJ${"B".repeat(12)}.${"C".repeat(16)}`],
    ["AWS access-key ID", `AKIA${"A".repeat(16)}`],
    ["GitHub token", `ghp_${"A".repeat(36)}`],
    ["GitHub fine-grained token", `github_pat_${"A".repeat(32)}`],
    ["Slack token", `xoxb-${"1".repeat(12)}-${"A".repeat(24)}`],
    ["Stripe secret key", `sk_test_${"A".repeat(24)}`],
    ["OpenAI-style secret key", `sk-proj-${"A".repeat(32)}`],
    ["Anthropic-style secret key", `sk-${"ant"}-api03-${"A".repeat(32)}`],
    ["Google API key", `AIza${"A".repeat(35)}`],
  ])(
    "refuses the high-confidence $0 signature under an innocent header",
    (_kind, value) => {
      expectCredentialRefusal(`Amount,Notes\n10,"${value}"\n`, [value]);
    },
  );

  it("accepts benign credential-word near misses in headers", () => {
    const read = readUpload(
      "benign.csv",
      encoder.encode(
        [
          "Token Count,Session Duration,Cookie Preference,Authorization Status,Password Reset Required,Secret Santa Budget,Amount",
          "12,30,analytics,approved,no,25,100",
          "8,45,functional,pending,yes,30,200",
          "",
        ].join("\n"),
      ),
    );
    expect(read.ok).toBe(true);
  });

  it("accepts benign prose that merely mentions credential words", () => {
    const read = readUpload(
      "benign-notes.csv",
      encoder.encode(
        [
          "Amount,Notes",
          '10,"password reset requested"',
          '20,"cookie policy reviewed"',
          '30,"session duration increased"',
          "",
        ].join("\n"),
      ),
    );
    expect(read.ok).toBe(true);
  });

  it.each([
    ["generic long identifier", "A".repeat(64)],
    ["UUID", "123e4567-e89b-12d3-a456-426614174000"],
    ["private-key prose", "private key rotation completed"],
    ["secret-key prose", "secret key metrics reviewed"],
    ["bearer prose", "bearer capacity increased"],
  ])("accepts the benign value control $0", (_kind, value) => {
    const read = readUpload(
      "benign-values.csv",
      encoder.encode(`Amount,Notes\n10,"${value}"\n20,ordinary\n`),
    );
    expect(read.ok).toBe(true);
  });
});
