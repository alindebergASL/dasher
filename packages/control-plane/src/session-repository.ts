import { randomUUID } from "node:crypto";

import {
  OperationConflictError,
  OperationDeniedError,
  OperationInternalError,
  type OperationInternalOutcome,
  type PgCompatibleClient,
  type PgCompatiblePool,
} from "./invitation-repository.js";
import {
  constantTimeDigestEqual,
  SecretKeyRing,
  SecretPrimitiveError,
  type SecretKind,
} from "./secrets.js";
import {
  createSessionCookieMetadata,
  type SessionCookieMetadata,
} from "./session-cookie.js";
import { VerifiedPrincipal } from "./verified-principal.js";

const randomUuidCapability = randomUUID;
const createSessionCookieMetadataCapability = createSessionCookieMetadata;
const constantTimeDigestEqualCapability = constantTimeDigestEqual;
const maximumDeploymentScalars = 64;
const maximumDeploymentUtf16CodeUnits = maximumDeploymentScalars * 2;
const maximumGeneratedUuidAttempts = 16;
const maximumRevisionDigits = 19;
const arrayIsArray = Array.isArray;
const dateConstructor = Date;
const dateGetTime = Date.prototype.getTime;
const datePrototype = Date.prototype;
const functionHasInstance = Function.prototype[Symbol.hasInstance];
const numberConstructor = Number;
const numberIsSafeInteger = Number.isSafeInteger;
const objectDefineProperty = Object.defineProperty;
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const promiseConstructor = Promise;
const promiseResolve = Promise.resolve;
const promiseThen = Promise.prototype.then;
const reflectApply = Reflect.apply;
const regexpTest = RegExp.prototype.test;
const stringCharCodeAt = String.prototype.charCodeAt;
const uint8ArrayConstructor = Uint8Array;
const uint8ArraySet = Uint8Array.prototype.set;
const typedArrayPrototype = objectGetPrototypeOf(
  uint8ArrayConstructor.prototype,
);
const typedArrayByteLengthGetter = objectGetOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const secretKeyRingIssue = SecretKeyRing.prototype.issue;
const secretKeyRingVerify = SecretKeyRing.prototype.verify;
const secretPrimitiveErrorPrototype = SecretPrimitiveError.prototype;
const verifiedPrincipalIssuerGetter = objectGetOwnPropertyDescriptor(
  VerifiedPrincipal.prototype,
  "issuer",
)!.get!;
const verifiedPrincipalSubjectGetter = objectGetOwnPropertyDescriptor(
  VerifiedPrincipal.prototype,
  "subject",
)!.get!;
const keyRingBrandProbe =
  "s1.32767.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const positiveRevisionPattern = /^[1-9][0-9]*$/;
const preflightInputInvalid = objectFreeze({});
const preflightInternalFault = objectFreeze({});

export type SessionRole = "viewer" | "editor" | "admin";
export type SessionSecurityEventReason =
  | "input_invalid"
  | "authority_invalid"
  | "state_invalid"
  | "identifier_conflict"
  | "internal_fault";

export interface SessionSecurityEvent {
  readonly requestId: string;
  readonly reason: SessionSecurityEventReason;
}

/**
 * Trusted, synchronous telemetry capability. The implementation must copy or
 * enqueue the bounded event before returning exact `true`, and must own all
 * later asynchronous work and errors. Arbitrary collaborator side effects,
 * including process termination or creation of an ECMAScript-unobservable
 * poisoned rejected Promise, are outside an in-process library boundary.
 */
export type SessionSecurityEventSink = (event: SessionSecurityEvent) => true;

export interface SessionRepositoryConfig {
  readonly pool: PgCompatiblePool;
  readonly keyRing: SecretKeyRing;
  readonly deploymentRevision: string;
  readonly securityEventSink: SessionSecurityEventSink;
  readonly uuidSource?: () => string;
}

export interface IssueSessionInput {
  readonly requestId: string;
  readonly principal: VerifiedPrincipal;
  readonly membershipId: string;
}

export interface IssueSessionResult {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly role: SessionRole;
  readonly authorityRevision: number;
  readonly sessionId: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly sessionToken: string;
  readonly csrfValue: string;
  readonly sessionCookie: SessionCookieMetadata;
}

export interface ResolveSessionInput {
  readonly requestId: string;
  readonly sessionToken: string;
}

export interface ResolveSessionResult {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly authorityRevision: number;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly sessionCookie: SessionCookieMetadata;
}

export interface RotateSessionInput {
  readonly requestId: string;
  readonly currentSessionToken: string;
  readonly currentCsrfValue: string;
}

export interface RotateSessionResult {
  readonly sessionId: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly sessionToken: string;
  readonly csrfValue: string;
  readonly sessionCookie: SessionCookieMetadata;
}

export interface RevokeSessionInput {
  readonly requestId: string;
  readonly currentSessionToken: string;
  readonly currentCsrfValue: string;
  readonly targetSessionId: string;
}

export interface RevokeSessionResult {
  readonly sessionId: string;
  readonly revokedAt: Date;
}

export interface ChangeMembershipRoleInput {
  readonly requestId: string;
  readonly currentSessionToken: string;
  readonly currentCsrfValue: string;
  readonly membershipId: string;
  readonly newRole: SessionRole;
}

export interface ChangeMembershipRoleResult {
  readonly membershipId: string;
  readonly authorityRevision: number;
}

export interface RevokeMembershipInput {
  readonly requestId: string;
  readonly currentSessionToken: string;
  readonly currentCsrfValue: string;
  readonly membershipId: string;
}

export interface RevokeMembershipResult {
  readonly membershipId: string;
  readonly authorityRevision: number;
  readonly revokedAt: Date;
}

interface ConfigurationSnapshot {
  readonly pool: unknown;
  readonly poolConnect: unknown;
  readonly keyRing: unknown;
  readonly deploymentRevision: unknown;
  readonly securityEventSink: unknown;
  readonly uuidSource: unknown;
}

interface VerifiedSecretSnapshot {
  readonly keyVersion: number;
  readonly digest: Uint8Array;
}

interface IssuedSecretSnapshot extends VerifiedSecretSnapshot {
  readonly wireValue: string;
}

interface ContextSnapshot {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly authorityRevision: number;
  readonly idleExpiresAtEpoch: number;
  readonly absoluteExpiresAtEpoch: number;
  readonly databaseNowEpoch: number;
}

const initializeContextSql = `SELECT
  result.session_id,
  result.user_id,
  result.organization_id,
  result.membership_id,
  result.authority_revision,
  result.idle_expires_at,
  result.absolute_expires_at,
  pg_catalog.clock_timestamp() AS database_now
FROM dasher_api.initialize_context(
  $1::smallint,
  $2::bytea,
  $3::uuid
) AS result`;

const issueSessionSql = `SELECT
  result.user_id,
  result.organization_id,
  result.membership_id,
  result.granted_role,
  result.authority_revision,
  result.session_id,
  result.idle_expires_at,
  result.absolute_expires_at,
  pg_catalog.clock_timestamp() AS database_now
FROM dasher_api.issue_session(
  $1::text,
  $2::text,
  $3::uuid,
  $4::uuid,
  $5::smallint,
  $6::bytea,
  $7::smallint,
  $8::bytea,
  $9::uuid,
  $10::uuid,
  $11::text
) AS result`;

const rotateSessionSql = `SELECT
  result.session_id,
  result.idle_expires_at,
  result.absolute_expires_at,
  pg_catalog.clock_timestamp() AS database_now
FROM dasher_api.rotate_session(
  $1::uuid,
  $2::smallint,
  $3::bytea,
  $4::smallint,
  $5::bytea,
  $6::uuid,
  $7::smallint,
  $8::bytea,
  $9::text
) AS result`;

const revokeSessionSql = `SELECT
  result.session_id,
  result.revoked_at,
  pg_catalog.clock_timestamp() AS database_now
FROM dasher_api.revoke_session(
  $1::uuid,
  $2::uuid,
  $3::smallint,
  $4::bytea,
  $5::text
) AS result`;

const changeMembershipRoleSql = `SELECT
  result.membership_id,
  result.authority_revision
FROM dasher_api.change_membership_role(
  $1::uuid,
  $2::text,
  $3::uuid,
  $4::smallint,
  $5::bytea,
  $6::text
) AS result`;

const revokeMembershipSql = `SELECT
  result.membership_id,
  result.authority_revision,
  result.revoked_at,
  pg_catalog.clock_timestamp() AS database_now
FROM dasher_api.revoke_membership(
  $1::uuid,
  $2::uuid,
  $3::smallint,
  $4::bytea,
  $5::text
) AS result`;

function internal(outcome: OperationInternalOutcome = "not_committed"): never {
  throw new OperationInternalError(outcome);
}

function ownDataProperty(object: unknown, key: string): unknown {
  if (object === null || typeof object !== "object") {
    return internal();
  }
  try {
    const descriptor = objectGetOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return internal();
    }
    return descriptor.value;
  } catch {
    return internal();
  }
}

function ownPreflightDataProperty(object: unknown, key: string): unknown {
  if (object === null || typeof object !== "object") {
    throw preflightInternalFault;
  }
  try {
    const descriptor = objectGetOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw preflightInternalFault;
    }
    return descriptor.value;
  } catch (error) {
    throw error === preflightInternalFault ? error : preflightInternalFault;
  }
}

function snapshotConfiguration(
  config: SessionRepositoryConfig,
): ConfigurationSnapshot {
  if (config === null || typeof config !== "object") {
    return internal();
  }
  try {
    const pool = config.pool;
    return {
      pool,
      poolConnect:
        pool !== null && typeof pool === "object"
          ? (pool as PgCompatiblePool).connect
          : undefined,
      keyRing: config.keyRing,
      deploymentRevision: config.deploymentRevision,
      securityEventSink: config.securityEventSink,
      uuidSource: config.uuidSource,
    };
  } catch {
    return internal();
  }
}

function validateDeploymentRevision(candidate: unknown): string {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > maximumDeploymentUtf16CodeUnits ||
    reflectApply(stringCharCodeAt, candidate, [0]) === 0x20 ||
    reflectApply(stringCharCodeAt, candidate, [candidate.length - 1]) === 0x20
  ) {
    return internal();
  }
  let scalarCount = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    const first = reflectApply(stringCharCodeAt, candidate, [index]);
    if (
      first <= 0x1f ||
      (first >= 0x7f && first <= 0x9f) ||
      (first >= 0xd800 &&
        first <= 0xdfff &&
        !(
          first <= 0xdbff &&
          index + 1 < candidate.length &&
          reflectApply(stringCharCodeAt, candidate, [index + 1]) >= 0xdc00 &&
          reflectApply(stringCharCodeAt, candidate, [index + 1]) <= 0xdfff
        ))
    ) {
      return internal();
    }
    if (first >= 0xd800 && first <= 0xdbff) {
      index += 1;
    }
    scalarCount += 1;
    if (scalarCount > maximumDeploymentScalars) {
      return internal();
    }
  }
  return candidate;
}

function secretPrimitiveFailureCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  try {
    if (objectGetPrototypeOf(error) !== secretPrimitiveErrorPrototype) {
      return undefined;
    }
    const descriptor = objectGetOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function validateKeyRing(candidate: unknown): SecretKeyRing {
  try {
    reflectApply(secretKeyRingVerify, candidate, [
      "session",
      keyRingBrandProbe,
    ]);
  } catch (error) {
    if (secretPrimitiveFailureCode(error) !== undefined) {
      return candidate as SecretKeyRing;
    }
    return internal();
  }
  return candidate as SecretKeyRing;
}

function isCanonicalUuid(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    reflectApply(regexpTest, canonicalUuidPattern, [candidate])
  );
}

function isRole(candidate: unknown): candidate is SessionRole {
  return (
    candidate === "viewer" || candidate === "editor" || candidate === "admin"
  );
}

function copyDigest(candidate: unknown, preflight: boolean): Uint8Array {
  try {
    if (
      !reflectApply(functionHasInstance, uint8ArrayConstructor, [candidate]) ||
      reflectApply(typedArrayByteLengthGetter, candidate, []) !== 32
    ) {
      if (preflight) throw preflightInternalFault;
      return internal();
    }
    const snapshot = new uint8ArrayConstructor(32);
    reflectApply(uint8ArraySet, snapshot, [candidate]);
    return snapshot;
  } catch (error) {
    if (preflight) {
      throw error === preflightInternalFault ? error : preflightInternalFault;
    }
    return internal();
  }
}

function snapshotPersistenceMaterial(
  candidate: unknown,
  preflight: boolean,
): VerifiedSecretSnapshot {
  const property = preflight ? ownPreflightDataProperty : ownDataProperty;
  const keyVersion = property(candidate, "keyVersion");
  const digest = property(candidate, "digest");
  if (
    typeof keyVersion !== "number" ||
    !numberIsSafeInteger(keyVersion) ||
    keyVersion < 1 ||
    keyVersion > 32_767
  ) {
    if (preflight) throw preflightInternalFault;
    return internal();
  }
  return objectFreeze({ keyVersion, digest: copyDigest(digest, preflight) });
}

function verifyCallerSecret(
  keyRing: SecretKeyRing,
  kind: SecretKind,
  wireValue: unknown,
): VerifiedSecretSnapshot {
  try {
    const material = reflectApply(secretKeyRingVerify, keyRing, [
      kind,
      wireValue,
    ]);
    return snapshotPersistenceMaterial(material, true);
  } catch (error) {
    if (error === preflightInternalFault) {
      throw error;
    }
    throw secretPrimitiveFailureCode(error) !== undefined
      ? preflightInputInvalid
      : preflightInternalFault;
  }
}

function issueRepositorySecret(
  keyRing: SecretKeyRing,
  kind: "session" | "csrf",
): IssuedSecretSnapshot {
  try {
    const issued = reflectApply(secretKeyRingIssue, keyRing, [kind]);
    const wireValue = ownPreflightDataProperty(issued, "wireValue");
    if (typeof wireValue !== "string") {
      throw preflightInternalFault;
    }
    const issuedPersistence = snapshotPersistenceMaterial(
      ownPreflightDataProperty(issued, "persistence"),
      true,
    );
    const verified = reflectApply(secretKeyRingVerify, keyRing, [
      kind,
      wireValue,
    ]);
    const material = snapshotPersistenceMaterial(verified, true);
    if (
      issuedPersistence.keyVersion !== material.keyVersion ||
      !reflectApply(constantTimeDigestEqualCapability, undefined, [
        issuedPersistence.digest,
        material.digest,
      ])
    ) {
      throw preflightInternalFault;
    }
    return objectFreeze({
      wireValue,
      keyVersion: material.keyVersion,
      digest: material.digest,
    });
  } catch {
    throw preflightInternalFault;
  }
}

function snapshotPrincipal(
  candidate: unknown,
): Readonly<{ issuer: string; subject: string }> {
  try {
    const issuer = reflectApply(verifiedPrincipalIssuerGetter, candidate, []);
    const subject = reflectApply(verifiedPrincipalSubjectGetter, candidate, []);
    if (typeof issuer !== "string" || typeof subject !== "string") {
      throw preflightInputInvalid;
    }
    return objectFreeze({ issuer, subject });
  } catch (error) {
    throw error === preflightInputInvalid ? error : preflightInputInvalid;
  }
}

function snapshotRows(result: unknown): unknown {
  const rowCount = ownDataProperty(result, "rowCount");
  const rows = ownDataProperty(result, "rows");
  if (rowCount !== 1) {
    return internal();
  }
  try {
    if (!arrayIsArray(rows) || rows.length !== 1) {
      return internal();
    }
    return rows[0];
  } catch {
    return internal();
  }
}

function validatedTimestampEpoch(candidate: unknown): number {
  try {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      objectGetPrototypeOf(candidate) !== datePrototype
    ) {
      return internal();
    }
    const epoch = reflectApply(dateGetTime, candidate, []);
    return numberIsSafeInteger(epoch) ? epoch : internal();
  } catch {
    return internal();
  }
}

function positiveRevision(candidate: unknown): number {
  let parsed: number;
  if (
    typeof candidate === "string" &&
    candidate.length >= 1 &&
    candidate.length <= maximumRevisionDigits &&
    reflectApply(regexpTest, positiveRevisionPattern, [candidate])
  ) {
    parsed = reflectApply(numberConstructor, undefined, [candidate]);
  } else if (typeof candidate === "number") {
    parsed = candidate;
  } else {
    return internal();
  }
  return numberIsSafeInteger(parsed) && parsed > 0 ? parsed : internal();
}

type DateProperty = "idleExpiresAt" | "absoluteExpiresAt" | "revokedAt";

function defineDateSnapshot(
  target: object,
  property: DateProperty,
  epoch: number,
): void {
  objectDefineProperty(target, property, {
    configurable: false,
    enumerable: true,
    get() {
      return new dateConstructor(epoch);
    },
  });
}

function createDatedResult<Result>(
  values: Omit<Result, DateProperty>,
  dates: readonly (readonly [DateProperty, number])[],
): Result {
  const result = values as Result & object;
  for (let index = 0; index < dates.length; index += 1) {
    const pair = dates[index];
    if (pair === undefined) return internal();
    defineDateSnapshot(result, pair[0], pair[1]);
  }
  return objectFreeze(result);
}

function validateLiveExpiryRow(row: unknown): {
  idleExpiresAtEpoch: number;
  absoluteExpiresAtEpoch: number;
  databaseNowEpoch: number;
} {
  const idleExpiresAtEpoch = validatedTimestampEpoch(
    ownDataProperty(row, "idle_expires_at"),
  );
  const absoluteExpiresAtEpoch = validatedTimestampEpoch(
    ownDataProperty(row, "absolute_expires_at"),
  );
  const databaseNowEpoch = validatedTimestampEpoch(
    ownDataProperty(row, "database_now"),
  );
  if (
    idleExpiresAtEpoch <= databaseNowEpoch ||
    absoluteExpiresAtEpoch <= databaseNowEpoch ||
    idleExpiresAtEpoch > absoluteExpiresAtEpoch
  ) {
    return internal();
  }
  return { idleExpiresAtEpoch, absoluteExpiresAtEpoch, databaseNowEpoch };
}

function validateContextRow(row: unknown): ContextSnapshot {
  const sessionId = ownDataProperty(row, "session_id");
  const userId = ownDataProperty(row, "user_id");
  const organizationId = ownDataProperty(row, "organization_id");
  const membershipId = ownDataProperty(row, "membership_id");
  if (
    !isCanonicalUuid(sessionId) ||
    !isCanonicalUuid(userId) ||
    !isCanonicalUuid(organizationId) ||
    !isCanonicalUuid(membershipId)
  ) {
    return internal();
  }
  return objectFreeze({
    sessionId,
    userId,
    organizationId,
    membershipId,
    authorityRevision: positiveRevision(
      ownDataProperty(row, "authority_revision"),
    ),
    ...validateLiveExpiryRow(row),
  });
}

function databaseCode(error: unknown): "P1001" | "P1002" | undefined {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const descriptor = objectGetOwnPropertyDescriptor(error, "code");
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    return descriptor.value === "P1001" || descriptor.value === "P1002"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

interface CapturedReleaseCapability {
  readonly release: PgCompatibleClient["release"];
  readonly receiver: object;
}

type ClientCapture =
  | (CapturedReleaseCapability & {
      readonly valid: true;
      readonly query: PgCompatibleClient["query"];
    })
  | {
      readonly valid: false;
      readonly release?: PgCompatibleClient["release"];
      readonly receiver?: object;
    };

function snapshotClient(client: unknown): ClientCapture {
  if (client === null || typeof client !== "object") {
    return objectFreeze({ valid: false });
  }
  let query: unknown;
  let release: unknown;
  try {
    query = (client as PgCompatibleClient).query;
  } catch {
    // The independent release capture below may still permit destruction.
  }
  try {
    release = (client as PgCompatibleClient).release;
  } catch {
    // A hostile release accessor is never read again.
  }
  if (typeof query === "function" && typeof release === "function") {
    return objectFreeze({
      valid: true,
      query: query as PgCompatibleClient["query"],
      release: release as PgCompatibleClient["release"],
      receiver: client,
    });
  }
  return objectFreeze({
    valid: false,
    ...(typeof release === "function"
      ? {
          release: release as PgCompatibleClient["release"],
          receiver: client,
        }
      : {}),
  });
}

type TransactionStage =
  | "connect"
  | "begin"
  | "set_local"
  | "initialize_select"
  | "initialize_validation"
  | "operation_select"
  | "operation_validation"
  | "commit";

interface TransactionFailure {
  readonly authority: object;
  readonly error: unknown;
  readonly outcome: OperationInternalOutcome;
  readonly stage: TransactionStage;
}

const transactionFailureAuthority = objectFreeze({});

function transactionFailure(
  stage: TransactionStage,
  error: unknown,
  outcome: OperationInternalOutcome = "not_committed",
): TransactionFailure {
  return objectFreeze({
    authority: transactionFailureAuthority,
    error,
    outcome,
    stage,
  });
}

function snapshotTransactionFailure(
  error: unknown,
): TransactionFailure | undefined {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const authority = objectGetOwnPropertyDescriptor(error, "authority");
    if (
      authority === undefined ||
      !("value" in authority) ||
      authority.value !== transactionFailureAuthority
    ) {
      return undefined;
    }
    return error as TransactionFailure;
  } catch {
    return undefined;
  }
}

function observeCleanupResult(result: unknown, onRejected: () => void): void {
  if (
    (typeof result !== "object" || result === null) &&
    typeof result !== "function"
  ) {
    return;
  }
  try {
    const promise = reflectApply(promiseResolve, promiseConstructor, [result]);
    reflectApply(promiseThen, promise, [undefined, onRejected]);
  } catch {
    onRejected();
  }
}

function destructiveRelease(client: CapturedReleaseCapability): void {
  try {
    const result = reflectApply(client.release, client.receiver, [true]);
    observeCleanupResult(result, () => undefined);
  } catch {
    // Destructive cleanup is best-effort and never authoritative.
  }
}

function normalRelease(client: CapturedReleaseCapability): void {
  try {
    // The pg client/release implementation is trusted in-process driver code
    // with documented void behavior. Standard Promise/thenable observation
    // remains defense in depth; arbitrary driver side effects or poisoned
    // rejected Promises that ECMAScript cannot observe are outside this
    // repository boundary.
    const result = reflectApply(client.release, client.receiver, []);
    observeCleanupResult(result, () => destructiveRelease(client));
  } catch {
    destructiveRelease(client);
  }
}

interface TransactionStep<Result> {
  readonly stage: "initialize" | "operation";
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly validate: (row: unknown) => Result;
}

/**
 * Context established by initialize_context is transaction-local. Every
 * dependent operation is intentionally executed on this same checked-out
 * client before COMMIT; callers must never assume context survives COMMIT.
 */
async function runPinnedTransaction<Result>(
  connect: () => Promise<PgCompatibleClient>,
  steps: readonly TransactionStep<unknown>[],
): Promise<Result> {
  let rawClient: PgCompatibleClient;
  try {
    rawClient = await connect();
  } catch (error) {
    throw transactionFailure("connect", error);
  }
  const capturedClient = snapshotClient(rawClient);
  if (!capturedClient.valid) {
    if (
      capturedClient.release !== undefined &&
      capturedClient.receiver !== undefined
    ) {
      destructiveRelease({
        release: capturedClient.release,
        receiver: capturedClient.receiver,
      });
    }
    throw transactionFailure("connect", new OperationInternalError());
  }
  const client = capturedClient;

  let stage: Exclude<TransactionStage, "connect" | "commit"> = "begin";
  let result: unknown;
  try {
    await reflectApply(client.query, client.receiver, ["BEGIN"]);
    stage = "set_local";
    await reflectApply(client.query, client.receiver, [
      "SET LOCAL search_path = pg_catalog",
    ]);
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (step === undefined) return internal();
      stage =
        step.stage === "initialize" ? "initialize_select" : "operation_select";
      const selected = await reflectApply(client.query, client.receiver, [
        step.sql,
        step.parameters,
      ]);
      stage =
        step.stage === "initialize"
          ? "initialize_validation"
          : "operation_validation";
      result = step.validate(snapshotRows(selected));
    }
  } catch (error) {
    try {
      await reflectApply(client.query, client.receiver, ["ROLLBACK"]);
      normalRelease(client);
    } catch {
      destructiveRelease(client);
    }
    throw transactionFailure(stage, error);
  }

  try {
    await reflectApply(client.query, client.receiver, ["COMMIT"]);
  } catch (error) {
    destructiveRelease(client);
    // COMMIT rejection is ambiguous: this boundary must never be auto-retried.
    throw transactionFailure("commit", error, "commit_indeterminate");
  }
  normalRelease(client);
  return result as Result;
}

export class SessionRepository {
  readonly #connect: () => Promise<PgCompatibleClient>;
  readonly #keyRing: SecretKeyRing;
  readonly #deploymentRevision: string;
  readonly #securityEventSink: SessionSecurityEventSink;
  readonly #uuidSource: () => string;

  constructor(config: SessionRepositoryConfig) {
    const snapshot = snapshotConfiguration(config);
    if (
      snapshot.pool === null ||
      typeof snapshot.pool !== "object" ||
      typeof snapshot.poolConnect !== "function" ||
      typeof snapshot.securityEventSink !== "function" ||
      (snapshot.uuidSource !== undefined &&
        typeof snapshot.uuidSource !== "function")
    ) {
      internal();
    }
    const pool = snapshot.pool;
    const poolConnect = snapshot.poolConnect as PgCompatiblePool["connect"];
    this.#connect = () => reflectApply(poolConnect, pool, []);
    this.#keyRing = validateKeyRing(snapshot.keyRing);
    this.#deploymentRevision = validateDeploymentRevision(
      snapshot.deploymentRevision,
    );
    this.#securityEventSink =
      snapshot.securityEventSink as SessionSecurityEventSink;
    this.#uuidSource =
      (snapshot.uuidSource as (() => string) | undefined) ??
      randomUuidCapability;
    objectFreeze(this);
  }

  #emit(requestId: string, reason: SessionSecurityEventReason): void {
    const event = objectFreeze({ requestId, reason });
    try {
      const acknowledgement = reflectApply(this.#securityEventSink, undefined, [
        event,
      ]);
      if (acknowledgement !== true) return;
    } catch {
      // Security telemetry is deliberately non-authoritative.
    }
  }

  #eventRequestId(candidate: unknown): string | undefined {
    if (isCanonicalUuid(candidate)) return candidate;
    try {
      const generated = reflectApply(this.#uuidSource, undefined, []);
      return isCanonicalUuid(generated) ? generated : undefined;
    } catch {
      return undefined;
    }
  }

  #generateDistinctUuid(excluded: readonly string[]): string {
    for (
      let attempt = 0;
      attempt < maximumGeneratedUuidAttempts;
      attempt += 1
    ) {
      let generated: unknown;
      try {
        generated = reflectApply(this.#uuidSource, undefined, []);
      } catch {
        throw preflightInternalFault;
      }
      if (!isCanonicalUuid(generated)) throw preflightInternalFault;
      let duplicate = false;
      for (let index = 0; index < excluded.length; index += 1) {
        if (excluded[index] === generated) duplicate = true;
      }
      if (!duplicate) return generated;
    }
    throw preflightInternalFault;
  }

  #requestCandidate(input: unknown): unknown {
    try {
      return input !== null && typeof input === "object"
        ? (input as { requestId?: unknown }).requestId
        : undefined;
    } catch {
      return undefined;
    }
  }

  #handlePreflight<Result>(
    requestCandidate: unknown,
    prepare: () => Result,
  ): { readonly prepared: Result; readonly requestId: string } {
    try {
      const prepared = prepare();
      return { prepared, requestId: requestCandidate as string };
    } catch (error) {
      const requestId = this.#eventRequestId(requestCandidate);
      const invalid = error === preflightInputInvalid;
      if (requestId !== undefined) {
        this.#emit(requestId, invalid ? "input_invalid" : "internal_fault");
      }
      throw invalid ? new OperationDeniedError() : new OperationInternalError();
    }
  }

  #mapFailure(error: unknown, requestId: string): never {
    const failure = snapshotTransactionFailure(error);
    const selectable =
      failure?.stage === "initialize_select" ||
      failure?.stage === "operation_select";
    const code = selectable ? databaseCode(failure.error) : undefined;
    if (code === "P1001") {
      this.#emit(requestId, "authority_invalid");
      throw new OperationDeniedError();
    }
    if (code === "P1002") {
      this.#emit(requestId, "identifier_conflict");
      throw new OperationConflictError();
    }
    this.#emit(requestId, "internal_fault");
    throw new OperationInternalError(failure?.outcome ?? "not_committed");
  }

  #snapshotCommonAuthenticatedInput(
    input: unknown,
    requestCandidate: unknown,
    properties: readonly string[],
  ): Readonly<Record<string, unknown>> {
    if (input === null || typeof input !== "object")
      throw preflightInputInvalid;
    const snapshot = objectCreate(null) as Record<string, unknown>;
    snapshot.requestId = requestCandidate;
    try {
      for (let index = 0; index < properties.length; index += 1) {
        const property = properties[index];
        if (property === undefined) throw preflightInternalFault;
        snapshot[property] = (input as Record<string, unknown>)[property];
      }
    } catch (error) {
      throw error === preflightInternalFault ? error : preflightInputInvalid;
    }
    if (!isCanonicalUuid(snapshot.requestId)) throw preflightInputInvalid;
    return objectFreeze(snapshot);
  }

  async issueSession(input: IssueSessionInput): Promise<IssueSessionResult> {
    const requestCandidate = this.#requestCandidate(input);
    const handled = this.#handlePreflight(requestCandidate, () => {
      const snapshot = this.#snapshotCommonAuthenticatedInput(
        input,
        requestCandidate,
        ["principal", "membershipId"],
      );
      if (!isCanonicalUuid(snapshot.membershipId)) throw preflightInputInvalid;
      const principal = snapshotPrincipal(snapshot.principal);
      const session = issueRepositorySecret(this.#keyRing, "session");
      const csrf = issueRepositorySecret(this.#keyRing, "csrf");
      const sessionId = this.#generateDistinctUuid([
        snapshot.requestId as string,
      ]);
      const auditEventId = this.#generateDistinctUuid([
        snapshot.requestId as string,
        sessionId,
      ]);
      return objectFreeze({
        requestId: snapshot.requestId as string,
        membershipId: snapshot.membershipId as string,
        principal,
        session,
        csrf,
        sessionId,
        auditEventId,
      });
    });
    const prepared = handled.prepared;
    try {
      const parameters = objectFreeze([
        prepared.principal.issuer,
        prepared.principal.subject,
        prepared.membershipId,
        prepared.sessionId,
        prepared.session.keyVersion,
        copyDigest(prepared.session.digest, false),
        prepared.csrf.keyVersion,
        copyDigest(prepared.csrf.digest, false),
        prepared.auditEventId,
        prepared.requestId,
        this.#deploymentRevision,
      ]);
      return await runPinnedTransaction<IssueSessionResult>(this.#connect, [
        {
          stage: "operation",
          sql: issueSessionSql,
          parameters,
          validate: (row) => {
            const userId = ownDataProperty(row, "user_id");
            const organizationId = ownDataProperty(row, "organization_id");
            const membershipId = ownDataProperty(row, "membership_id");
            const role = ownDataProperty(row, "granted_role");
            const sessionId = ownDataProperty(row, "session_id");
            if (
              !isCanonicalUuid(userId) ||
              !isCanonicalUuid(organizationId) ||
              !isCanonicalUuid(membershipId) ||
              membershipId !== prepared.membershipId ||
              !isRole(role) ||
              !isCanonicalUuid(sessionId) ||
              sessionId !== prepared.sessionId
            ) {
              return internal();
            }
            const expiry = validateLiveExpiryRow(row);
            return createDatedResult<IssueSessionResult>(
              {
                userId,
                organizationId,
                membershipId,
                role,
                authorityRevision: positiveRevision(
                  ownDataProperty(row, "authority_revision"),
                ),
                sessionId,
                sessionToken: prepared.session.wireValue,
                csrfValue: prepared.csrf.wireValue,
                sessionCookie: createSessionCookieMetadataCapability(
                  expiry.databaseNowEpoch,
                  expiry.absoluteExpiresAtEpoch,
                ),
              } as Omit<IssueSessionResult, DateProperty>,
              [
                ["idleExpiresAt", expiry.idleExpiresAtEpoch],
                ["absoluteExpiresAt", expiry.absoluteExpiresAtEpoch],
              ],
            );
          },
        },
      ]);
    } catch (error) {
      return this.#mapFailure(error, handled.requestId);
    }
  }

  async resolveSession(
    input: ResolveSessionInput,
  ): Promise<ResolveSessionResult> {
    const requestCandidate = this.#requestCandidate(input);
    const handled = this.#handlePreflight(requestCandidate, () => {
      const snapshot = this.#snapshotCommonAuthenticatedInput(
        input,
        requestCandidate,
        ["sessionToken"],
      );
      return objectFreeze({
        requestId: snapshot.requestId as string,
        session: verifyCallerSecret(
          this.#keyRing,
          "session",
          snapshot.sessionToken,
        ),
      });
    });
    try {
      const context = await runPinnedTransaction<ContextSnapshot>(
        this.#connect,
        [
          {
            stage: "initialize",
            sql: initializeContextSql,
            parameters: objectFreeze([
              handled.prepared.session.keyVersion,
              copyDigest(handled.prepared.session.digest, false),
              handled.prepared.requestId,
            ]),
            validate: validateContextRow,
          },
        ],
      );
      return createDatedResult<ResolveSessionResult>(
        {
          sessionId: context.sessionId,
          userId: context.userId,
          organizationId: context.organizationId,
          membershipId: context.membershipId,
          authorityRevision: context.authorityRevision,
          sessionCookie: createSessionCookieMetadataCapability(
            context.databaseNowEpoch,
            context.absoluteExpiresAtEpoch,
          ),
        } as Omit<ResolveSessionResult, DateProperty>,
        [
          ["idleExpiresAt", context.idleExpiresAtEpoch],
          ["absoluteExpiresAt", context.absoluteExpiresAtEpoch],
        ],
      );
    } catch (error) {
      return this.#mapFailure(error, handled.requestId);
    }
  }

  async rotateSession(input: RotateSessionInput): Promise<RotateSessionResult> {
    const requestCandidate = this.#requestCandidate(input);
    const handled = this.#handlePreflight(requestCandidate, () => {
      const snapshot = this.#snapshotCommonAuthenticatedInput(
        input,
        requestCandidate,
        ["currentSessionToken", "currentCsrfValue"],
      );
      const currentSession = verifyCallerSecret(
        this.#keyRing,
        "session",
        snapshot.currentSessionToken,
      );
      const currentCsrf = verifyCallerSecret(
        this.#keyRing,
        "csrf",
        snapshot.currentCsrfValue,
      );
      const successorSession = issueRepositorySecret(this.#keyRing, "session");
      const successorCsrf = issueRepositorySecret(this.#keyRing, "csrf");
      const successorSessionId = this.#generateDistinctUuid([
        snapshot.requestId as string,
      ]);
      const auditEventId = this.#generateDistinctUuid([
        snapshot.requestId as string,
        successorSessionId,
      ]);
      return objectFreeze({
        requestId: snapshot.requestId as string,
        currentSession,
        currentCsrf,
        successorSession,
        successorCsrf,
        successorSessionId,
        auditEventId,
      });
    });
    const prepared = handled.prepared;
    try {
      return await runPinnedTransaction<RotateSessionResult>(this.#connect, [
        this.#contextStep(prepared.currentSession, prepared.requestId),
        {
          stage: "operation",
          sql: rotateSessionSql,
          parameters: objectFreeze([
            prepared.successorSessionId,
            prepared.successorSession.keyVersion,
            copyDigest(prepared.successorSession.digest, false),
            prepared.successorCsrf.keyVersion,
            copyDigest(prepared.successorCsrf.digest, false),
            prepared.auditEventId,
            prepared.currentCsrf.keyVersion,
            copyDigest(prepared.currentCsrf.digest, false),
            this.#deploymentRevision,
          ]),
          validate: (row) => {
            const sessionId = ownDataProperty(row, "session_id");
            if (
              !isCanonicalUuid(sessionId) ||
              sessionId !== prepared.successorSessionId
            ) {
              return internal();
            }
            const expiry = validateLiveExpiryRow(row);
            return createDatedResult<RotateSessionResult>(
              {
                sessionId,
                sessionToken: prepared.successorSession.wireValue,
                csrfValue: prepared.successorCsrf.wireValue,
                sessionCookie: createSessionCookieMetadataCapability(
                  expiry.databaseNowEpoch,
                  expiry.absoluteExpiresAtEpoch,
                ),
              } as Omit<RotateSessionResult, DateProperty>,
              [
                ["idleExpiresAt", expiry.idleExpiresAtEpoch],
                ["absoluteExpiresAt", expiry.absoluteExpiresAtEpoch],
              ],
            );
          },
        },
      ]);
    } catch (error) {
      return this.#mapFailure(error, handled.requestId);
    }
  }

  #contextStep(
    session: VerifiedSecretSnapshot,
    requestId: string,
  ): TransactionStep<ContextSnapshot> {
    return {
      stage: "initialize",
      sql: initializeContextSql,
      parameters: objectFreeze([
        session.keyVersion,
        copyDigest(session.digest, false),
        requestId,
      ]),
      validate: validateContextRow,
    };
  }

  async revokeSession(input: RevokeSessionInput): Promise<RevokeSessionResult> {
    return this.#runCsrfMutation(
      input,
      ["targetSessionId"],
      (snapshot) => {
        if (!isCanonicalUuid(snapshot.targetSessionId))
          throw preflightInputInvalid;
      },
      (snapshot, currentCsrf, auditEventId) => {
        const targetSessionId = snapshot.targetSessionId as string;
        return {
          sql: revokeSessionSql,
          parameters: objectFreeze([
            targetSessionId,
            auditEventId,
            currentCsrf.keyVersion,
            copyDigest(currentCsrf.digest, false),
            this.#deploymentRevision,
          ]),
          validate: (row: unknown) => {
            const sessionId = ownDataProperty(row, "session_id");
            if (!isCanonicalUuid(sessionId) || sessionId !== targetSessionId) {
              return internal();
            }
            const revokedAt = validatedTimestampEpoch(
              ownDataProperty(row, "revoked_at"),
            );
            const databaseNow = validatedTimestampEpoch(
              ownDataProperty(row, "database_now"),
            );
            if (revokedAt > databaseNow) return internal();
            return createDatedResult<RevokeSessionResult>(
              { sessionId } as Omit<RevokeSessionResult, DateProperty>,
              [["revokedAt", revokedAt]],
            );
          },
        };
      },
    );
  }

  async changeMembershipRole(
    input: ChangeMembershipRoleInput,
  ): Promise<ChangeMembershipRoleResult> {
    return this.#runCsrfMutation(
      input,
      ["membershipId", "newRole"],
      (snapshot) => {
        if (
          !isCanonicalUuid(snapshot.membershipId) ||
          !isRole(snapshot.newRole)
        ) {
          throw preflightInputInvalid;
        }
      },
      (snapshot, currentCsrf, auditEventId) => {
        const membershipId = snapshot.membershipId as string;
        return {
          sql: changeMembershipRoleSql,
          parameters: objectFreeze([
            membershipId,
            snapshot.newRole,
            auditEventId,
            currentCsrf.keyVersion,
            copyDigest(currentCsrf.digest, false),
            this.#deploymentRevision,
          ]),
          validate: (row: unknown) => {
            const returnedMembershipId = ownDataProperty(row, "membership_id");
            if (
              !isCanonicalUuid(returnedMembershipId) ||
              returnedMembershipId !== membershipId
            ) {
              return internal();
            }
            return objectFreeze({
              membershipId: returnedMembershipId,
              authorityRevision: positiveRevision(
                ownDataProperty(row, "authority_revision"),
              ),
            });
          },
        };
      },
    );
  }

  async revokeMembership(
    input: RevokeMembershipInput,
  ): Promise<RevokeMembershipResult> {
    return this.#runCsrfMutation(
      input,
      ["membershipId"],
      (snapshot) => {
        if (!isCanonicalUuid(snapshot.membershipId))
          throw preflightInputInvalid;
      },
      (snapshot, currentCsrf, auditEventId) => {
        const membershipId = snapshot.membershipId as string;
        return {
          sql: revokeMembershipSql,
          parameters: objectFreeze([
            membershipId,
            auditEventId,
            currentCsrf.keyVersion,
            copyDigest(currentCsrf.digest, false),
            this.#deploymentRevision,
          ]),
          validate: (row: unknown) => {
            const returnedMembershipId = ownDataProperty(row, "membership_id");
            if (
              !isCanonicalUuid(returnedMembershipId) ||
              returnedMembershipId !== membershipId
            ) {
              return internal();
            }
            const revokedAt = validatedTimestampEpoch(
              ownDataProperty(row, "revoked_at"),
            );
            const databaseNow = validatedTimestampEpoch(
              ownDataProperty(row, "database_now"),
            );
            if (revokedAt > databaseNow) return internal();
            return createDatedResult<RevokeMembershipResult>(
              {
                membershipId: returnedMembershipId,
                authorityRevision: positiveRevision(
                  ownDataProperty(row, "authority_revision"),
                ),
              } as Omit<RevokeMembershipResult, DateProperty>,
              [["revokedAt", revokedAt]],
            );
          },
        };
      },
    );
  }

  async #runCsrfMutation<Result>(
    input: unknown,
    extraProperties: readonly string[],
    validateInput: (snapshot: Readonly<Record<string, unknown>>) => void,
    build: (
      snapshot: Readonly<Record<string, unknown>>,
      currentCsrf: VerifiedSecretSnapshot,
      auditEventId: string,
    ) => Omit<TransactionStep<Result>, "stage">,
  ): Promise<Result> {
    const requestCandidate = this.#requestCandidate(input);
    const handled = this.#handlePreflight(requestCandidate, () => {
      const propertyNames = ["currentSessionToken", "currentCsrfValue"];
      for (let index = 0; index < extraProperties.length; index += 1) {
        const property = extraProperties[index];
        if (property === undefined) throw preflightInternalFault;
        propertyNames[propertyNames.length] = property;
      }
      const snapshot = this.#snapshotCommonAuthenticatedInput(
        input,
        requestCandidate,
        propertyNames,
      );
      validateInput(snapshot);
      const currentSession = verifyCallerSecret(
        this.#keyRing,
        "session",
        snapshot.currentSessionToken,
      );
      const currentCsrf = verifyCallerSecret(
        this.#keyRing,
        "csrf",
        snapshot.currentCsrfValue,
      );
      const auditEventId = this.#generateDistinctUuid([
        snapshot.requestId as string,
      ]);
      const operation = build(snapshot, currentCsrf, auditEventId);
      return objectFreeze({
        requestId: snapshot.requestId as string,
        currentSession,
        operation,
      });
    });
    try {
      return await runPinnedTransaction<Result>(this.#connect, [
        this.#contextStep(
          handled.prepared.currentSession,
          handled.prepared.requestId,
        ),
        { stage: "operation", ...handled.prepared.operation },
      ]);
    } catch (error) {
      return this.#mapFailure(error, handled.requestId);
    }
  }
}
