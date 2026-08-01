import { randomUUID } from "node:crypto";

import { normalizeEmailAddress } from "./email.js";
import {
  SecretKeyRing,
  SecretPrimitiveError,
  type IssuedSecret,
  type SecretKind,
  type SecretPersistenceMaterial,
} from "./secrets.js";
import {
  createSessionCookieMetadata,
  type SessionCookieMetadata,
} from "./session-cookie.js";
import { VerifiedPrincipal } from "./verified-principal.js";

const randomUuidCapability = randomUUID;
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
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const promiseConstructor = Promise;
const promiseResolve = Promise.resolve;
const promiseThen = Promise.prototype.then;
const reflectApply = Reflect.apply;
const regexpTest = RegExp.prototype.test;
const setAdd = Set.prototype.add;
const setConstructor = Set;
const setHas = Set.prototype.has;
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
const keyRingBrandProbe =
  "i1.32767.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const verifiedPrincipalIssuerGetter = objectGetOwnPropertyDescriptor(
  VerifiedPrincipal.prototype,
  "issuer",
)!.get!;
const verifiedPrincipalSubjectGetter = objectGetOwnPropertyDescriptor(
  VerifiedPrincipal.prototype,
  "subject",
)!.get!;
const verifiedPrincipalEmailGetter = objectGetOwnPropertyDescriptor(
  VerifiedPrincipal.prototype,
  "normalizedVerifiedEmail",
)!.get!;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const positiveRevisionPattern = /^[1-9][0-9]*$/;
const preflightInputInvalid = objectFreeze({});
const preflightInternalFault = objectFreeze({});

export type InvitationRole = "viewer" | "editor" | "admin";
export type SecurityEventReason =
  | "input_invalid"
  | "authority_invalid"
  | "state_invalid"
  | "identifier_conflict"
  | "internal_fault";

export interface InvitationSecurityEvent {
  readonly requestId: string;
  readonly reason: SecurityEventReason;
}

export type InvitationSecurityEventSink = (
  event: InvitationSecurityEvent,
) => void | Promise<void>;

export class OperationDeniedError extends Error {
  readonly code = "operation_denied" as const;

  constructor() {
    super("Operation denied");
    this.name = "OperationDeniedError";
    objectFreeze(this);
  }
}

export class OperationConflictError extends Error {
  readonly code = "operation_conflict" as const;

  constructor() {
    super("Operation conflict");
    this.name = "OperationConflictError";
    objectFreeze(this);
  }
}

export class OperationInternalError extends Error {
  readonly code = "internal_error" as const;
  readonly outcome: OperationInternalOutcome;
  readonly retrySafe = false as const;

  constructor(outcome: OperationInternalOutcome = "not_committed") {
    super("Internal operation failure");
    this.name = "OperationInternalError";
    this.outcome = outcome;
    objectFreeze(this);
  }
}

/**
 * `commit_indeterminate` means PostgreSQL may have committed but the COMMIT
 * acknowledgement was lost. Callers must reconcile or perform a compensating
 * reissue; blind automatic retry is never safe at this boundary.
 */
export type OperationInternalOutcome = "not_committed" | "commit_indeterminate";

export interface PgCompatibleQueryResult {
  readonly rowCount: number | null;
  readonly rows: readonly unknown[];
}

export interface PgCompatibleClient {
  query(text: string, values?: unknown[]): Promise<PgCompatibleQueryResult>;
  release(destroy?: boolean): unknown;
}

export interface PgCompatiblePool {
  connect(): Promise<PgCompatibleClient>;
}

export interface InvitationRepositoryConfig {
  readonly pool: PgCompatiblePool;
  readonly keyRing: SecretKeyRing;
  readonly deploymentRevision: string;
  readonly securityEventSink: InvitationSecurityEventSink;
  readonly uuidSource?: () => string;
}

export interface IssueInvitationInput {
  readonly requestId: string;
  readonly email: string;
  readonly role: InvitationRole;
  readonly currentSessionToken: string;
  readonly currentCsrfValue: string;
}

export interface IssueInvitationResult {
  readonly invitationId: string;
  readonly expiresAt: Date;
  readonly inviteToken: string;
}

export interface AcceptInvitationInput {
  readonly requestId: string;
  readonly inviteToken: string;
  readonly principal: VerifiedPrincipal;
}

export interface AcceptInvitationResult {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly sessionId: string;
  readonly role: InvitationRole;
  readonly authorityRevision: number;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly sessionToken: string;
  readonly csrfValue: string;
  readonly sessionCookie: SessionCookieMetadata;
}

interface ConfigurationSnapshot {
  readonly pool: unknown;
  readonly poolConnect: unknown;
  readonly keyRing: unknown;
  readonly deploymentRevision: unknown;
  readonly securityEventSink: unknown;
  readonly uuidSource: unknown;
}

interface PreparedIssue {
  readonly requestId: string;
  readonly email: string;
  readonly role: InvitationRole;
  readonly session: SecretPersistenceMaterial;
  readonly csrf: SecretPersistenceMaterial;
  readonly invitationId: string;
  readonly auditEventId: string;
  readonly invite: ReturnType<SecretKeyRing["issue"]>;
}

interface PreparedAccept {
  readonly requestId: string;
  readonly invite: SecretPersistenceMaterial;
  readonly principal: Readonly<{
    issuer: string;
    subject: string;
    normalizedVerifiedEmail: string;
  }>;
  readonly proposedUserId: string;
  readonly proposedMembershipId: string;
  readonly proposedSessionId: string;
  readonly auditEventId: string;
  readonly session: ReturnType<SecretKeyRing["issue"]>;
  readonly csrf: ReturnType<SecretKeyRing["issue"]>;
}

const issueInvitationSql = `SELECT
  result.invitation_id,
  result.expires_at
FROM dasher_api.issue_invitation(
  $1::uuid,
  $2::text,
  $3::text,
  $4::smallint,
  $5::bytea,
  $6::uuid,
  $7::smallint,
  $8::bytea,
  $9::smallint,
  $10::bytea,
  $11::uuid,
  $12::text
) AS result`;

const acceptInvitationSql = `SELECT
  result.user_id,
  result.organization_id,
  result.membership_id,
  result.granted_role,
  result.authority_revision,
  result.session_id,
  result.idle_expires_at,
  result.absolute_expires_at,
  pg_catalog.clock_timestamp() AS database_now
FROM dasher_api.accept_invitation(
  $1::smallint,
  $2::bytea,
  $3::text,
  $4::text,
  $5::text,
  $6::boolean,
  $7::uuid,
  $8::uuid,
  $9::uuid,
  $10::smallint,
  $11::bytea,
  $12::smallint,
  $13::bytea,
  $14::uuid,
  $15::uuid,
  $16::text
) AS result`;

function internal(): never {
  throw new OperationInternalError();
}

function snapshotConfiguration(
  config: InvitationRepositoryConfig,
): ConfigurationSnapshot {
  if (config === null || typeof config !== "object") {
    return internal();
  }
  try {
    const pool = config.pool;
    const poolConnect =
      pool !== null && typeof pool === "object"
        ? (pool as PgCompatiblePool).connect
        : undefined;
    const keyRing = config.keyRing;
    const deploymentRevision = config.deploymentRevision;
    const securityEventSink = config.securityEventSink;
    const uuidSource = config.uuidSource;
    return {
      pool,
      poolConnect,
      keyRing,
      deploymentRevision,
      securityEventSink,
      uuidSource,
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
      internal();
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

function validateKeyRing(candidate: unknown): SecretKeyRing {
  try {
    reflectApply(secretKeyRingVerify, candidate, ["invite", keyRingBrandProbe]);
    return candidate as SecretKeyRing;
  } catch (error) {
    const code = secretPrimitiveFailureCode(error);
    if (code === "unknown_version" || code === "retired_version") {
      return candidate as SecretKeyRing;
    }
    return internal();
  }
  return internal();
}

function secretPrimitiveFailureCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  try {
    if (objectGetPrototypeOf(error) !== secretPrimitiveErrorPrototype) {
      return undefined;
    }
    const code = objectGetOwnPropertyDescriptor(error, "code");
    return code !== undefined &&
      "value" in code &&
      typeof code.value === "string"
      ? code.value
      : undefined;
  } catch {
    return undefined;
  }
}

function verifyWireSecret(
  keyRing: SecretKeyRing,
  kind: SecretKind,
  wireValue: unknown,
): SecretPersistenceMaterial {
  try {
    return reflectApply(secretKeyRingVerify, keyRing, [
      kind,
      wireValue,
    ]) as SecretPersistenceMaterial;
  } catch (error) {
    throw secretPrimitiveFailureCode(error) !== undefined
      ? preflightInputInvalid
      : preflightInternalFault;
  }
}

function issueRepositorySecret<Kind extends SecretKind>(
  keyRing: SecretKeyRing,
  kind: Kind,
): IssuedSecret<Kind> {
  try {
    return reflectApply(secretKeyRingIssue, keyRing, [
      kind,
    ]) as IssuedSecret<Kind>;
  } catch {
    throw preflightInternalFault;
  }
}

function isCanonicalUuid(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    reflectApply(regexpTest, canonicalUuidPattern, [candidate])
  );
}

function isRole(candidate: unknown): candidate is InvitationRole {
  return (
    candidate === "viewer" || candidate === "editor" || candidate === "admin"
  );
}

function ownDataProperty(object: unknown, key: string): unknown {
  if (object === null || typeof object !== "object") {
    return internal();
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = objectGetOwnPropertyDescriptor(object, key);
  } catch {
    return internal();
  }
  if (descriptor === undefined || !("value" in descriptor)) {
    return internal();
  }
  return descriptor.value;
}

function snapshotRows(result: unknown): unknown {
  const rowCount = ownDataProperty(result, "rowCount");
  const rows = ownDataProperty(result, "rows");
  if (rowCount !== 1) {
    return internal();
  }

  try {
    if (!arrayIsArray(rows)) {
      return internal();
    }
    const length = rows.length;
    if (length !== 1) {
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
    if (!numberIsSafeInteger(epoch)) {
      return internal();
    }
    return epoch;
  } catch {
    return internal();
  }
}

function defineDateSnapshot(
  target: object,
  property: "expiresAt" | "idleExpiresAt" | "absoluteExpiresAt",
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

function createIssueResult(
  invitationId: string,
  expiresAtEpoch: number,
  inviteToken: string,
): IssueInvitationResult {
  const result = {
    invitationId,
    inviteToken,
  } as Partial<IssueInvitationResult>;
  defineDateSnapshot(result, "expiresAt", expiresAtEpoch);
  return objectFreeze(result as IssueInvitationResult);
}

function createAcceptResult(
  values: Omit<AcceptInvitationResult, "idleExpiresAt" | "absoluteExpiresAt">,
  idleExpiresAtEpoch: number,
  absoluteExpiresAtEpoch: number,
): AcceptInvitationResult {
  const result = { ...values } as Partial<AcceptInvitationResult>;
  defineDateSnapshot(result, "idleExpiresAt", idleExpiresAtEpoch);
  defineDateSnapshot(result, "absoluteExpiresAt", absoluteExpiresAtEpoch);
  return objectFreeze(result as AcceptInvitationResult);
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
  if (!numberIsSafeInteger(parsed) || parsed <= 0) {
    return internal();
  }
  return parsed;
}

function copyDigest(material: SecretPersistenceMaterial): Uint8Array {
  try {
    if (
      !reflectApply(functionHasInstance, uint8ArrayConstructor, [
        material.digest,
      ]) ||
      reflectApply(typedArrayByteLengthGetter, material.digest, []) !== 32
    ) {
      return internal();
    }
    const snapshot = new uint8ArrayConstructor(32);
    reflectApply(uint8ArraySet, snapshot, [material.digest]);
    return snapshot;
  } catch {
    return internal();
  }
}

function snapshotPrincipal(candidate: unknown): Readonly<{
  issuer: string;
  subject: string;
  normalizedVerifiedEmail: string;
}> {
  try {
    return objectFreeze({
      issuer: reflectApply(verifiedPrincipalIssuerGetter, candidate, []),
      subject: reflectApply(verifiedPrincipalSubjectGetter, candidate, []),
      normalizedVerifiedEmail: reflectApply(
        verifiedPrincipalEmailGetter,
        candidate,
        [],
      ),
    });
  } catch {
    throw preflightInputInvalid;
  }
}

function databaseCode(error: unknown): "P1001" | "P1002" | undefined {
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  try {
    const descriptor = objectGetOwnPropertyDescriptor(error, "code");
    if (descriptor === undefined || !("value" in descriptor)) {
      return undefined;
    }
    return descriptor.value === "P1001" || descriptor.value === "P1002"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function snapshotClient(client: unknown): {
  query: PgCompatibleClient["query"];
  release: PgCompatibleClient["release"];
  receiver: object;
} {
  if (client === null || typeof client !== "object") {
    return internal();
  }
  try {
    const candidate = client as PgCompatibleClient;
    if (
      typeof candidate.query !== "function" ||
      typeof candidate.release !== "function"
    ) {
      return internal();
    }
    return {
      query: candidate.query,
      release: candidate.release,
      receiver: client,
    };
  } catch {
    return internal();
  }
}

type TransactionStage =
  "connect" | "begin" | "set_local" | "select" | "validation" | "commit";

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
  if (error === null || typeof error !== "object") {
    return undefined;
  }
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

function destructiveRelease(client: ReturnType<typeof snapshotClient>): void {
  try {
    const result = reflectApply(client.release, client.receiver, [true]);
    observeCleanupResult(result, () => undefined);
  } catch {
    // Destructive cleanup is best-effort and never authoritative.
  }
}

function normalRelease(client: ReturnType<typeof snapshotClient>): void {
  try {
    const result = reflectApply(client.release, client.receiver, []);
    observeCleanupResult(result, () => destructiveRelease(client));
  } catch {
    destructiveRelease(client);
  }
}

function bestEffortDestructiveRelease(client: unknown): void {
  if (client === null || typeof client !== "object") {
    return;
  }
  try {
    const release = (client as PgCompatibleClient).release;
    if (typeof release === "function") {
      const result = reflectApply(release, client, [true]);
      observeCleanupResult(result, () => undefined);
    }
  } catch {
    // No untrusted cleanup failure is retained or exposed.
  }
}

async function runPinnedTransaction<Result>(
  connect: () => Promise<PgCompatibleClient>,
  selectSql: string,
  parameters: readonly unknown[],
  validate: (row: unknown) => Result,
): Promise<Result> {
  let rawClient: PgCompatibleClient;
  try {
    rawClient = await connect();
  } catch (error) {
    throw transactionFailure("connect", error);
  }
  let client: ReturnType<typeof snapshotClient>;
  try {
    client = snapshotClient(rawClient);
  } catch (error) {
    bestEffortDestructiveRelease(rawClient);
    throw transactionFailure("connect", error);
  }

  let result: Result;
  let precommitStage: Exclude<TransactionStage, "connect" | "commit"> = "begin";
  try {
    await reflectApply(client.query, client.receiver, ["BEGIN"]);
    precommitStage = "set_local";
    await reflectApply(client.query, client.receiver, [
      "SET LOCAL search_path = pg_catalog",
    ]);
    precommitStage = "select";
    const selected = await reflectApply(client.query, client.receiver, [
      selectSql,
      parameters,
    ]);
    precommitStage = "validation";
    const row = snapshotRows(selected);
    result = validate(row);
  } catch (error) {
    try {
      await reflectApply(client.query, client.receiver, ["ROLLBACK"]);
      normalRelease(client);
    } catch {
      destructiveRelease(client);
    }
    throw transactionFailure(precommitStage, error);
  }

  try {
    await reflectApply(client.query, client.receiver, ["COMMIT"]);
  } catch (error) {
    destructiveRelease(client);
    throw transactionFailure("commit", error, "commit_indeterminate");
  }

  normalRelease(client);
  return result;
}

export class InvitationRepository {
  readonly #connect: () => Promise<PgCompatibleClient>;
  readonly #keyRing: SecretKeyRing;
  readonly #deploymentRevision: string;
  readonly #uuidSource: () => string;
  readonly #securityEventSink: InvitationSecurityEventSink;

  constructor(config: InvitationRepositoryConfig) {
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
    this.#connect = () =>
      reflectApply(
        snapshot.poolConnect as PgCompatiblePool["connect"],
        pool,
        [],
      );
    this.#keyRing = validateKeyRing(snapshot.keyRing);
    this.#deploymentRevision = validateDeploymentRevision(
      snapshot.deploymentRevision,
    );
    this.#securityEventSink =
      snapshot.securityEventSink as InvitationSecurityEventSink;
    this.#uuidSource =
      (snapshot.uuidSource as (() => string) | undefined) ??
      randomUuidCapability;
    objectFreeze(this);
  }

  #emit(requestId: string, reason: SecurityEventReason): void {
    const event = objectFreeze({ requestId, reason });
    try {
      const possiblePromise = this.#securityEventSink(event);
      if (possiblePromise !== undefined) {
        observeCleanupResult(possiblePromise, () => undefined);
      }
    } catch {
      // Security telemetry is deliberately non-authoritative.
    }
  }

  #eventRequestId(candidate: unknown): string | undefined {
    if (isCanonicalUuid(candidate)) {
      return candidate;
    }
    try {
      const generated = this.#uuidSource();
      return isCanonicalUuid(generated) ? generated : undefined;
    } catch {
      return undefined;
    }
  }

  #generateDistinctUuid(excluded: ReadonlySet<string>): string {
    for (
      let attempt = 0;
      attempt < maximumGeneratedUuidAttempts;
      attempt += 1
    ) {
      let generated: unknown;
      try {
        generated = this.#uuidSource();
      } catch {
        throw preflightInternalFault;
      }
      if (!isCanonicalUuid(generated)) {
        throw preflightInternalFault;
      }
      if (!reflectApply(setHas, excluded, [generated])) {
        return generated;
      }
    }
    throw preflightInternalFault;
  }

  #mapFailure(
    error: unknown,
    requestId: string,
    operation: "issue" | "accept",
  ): never {
    const failure = snapshotTransactionFailure(error);
    const code =
      failure?.stage === "select" ? databaseCode(failure.error) : undefined;
    if (code === "P1001") {
      this.#emit(
        requestId,
        operation === "issue" ? "authority_invalid" : "state_invalid",
      );
      throw new OperationDeniedError();
    }
    if (code === "P1002") {
      this.#emit(requestId, "identifier_conflict");
      throw new OperationConflictError();
    }
    this.#emit(requestId, "internal_fault");
    throw new OperationInternalError(failure?.outcome ?? "not_committed");
  }

  #prepareIssue(
    input: IssueInvitationInput,
    requestId: unknown,
  ): PreparedIssue {
    let snapshot: {
      requestId: unknown;
      email: unknown;
      role: unknown;
      currentSessionToken: unknown;
      currentCsrfValue: unknown;
    };
    try {
      if (input === null || typeof input !== "object") {
        throw preflightInputInvalid;
      }
      snapshot = {
        requestId,
        email: input.email,
        role: input.role,
        currentSessionToken: input.currentSessionToken,
        currentCsrfValue: input.currentCsrfValue,
      };
    } catch (error) {
      throw error === preflightInputInvalid ? error : preflightInputInvalid;
    }
    if (!isCanonicalUuid(snapshot.requestId) || !isRole(snapshot.role)) {
      throw preflightInputInvalid;
    }

    let email: string;
    try {
      email = normalizeEmailAddress(snapshot.email as string);
    } catch {
      throw preflightInputInvalid;
    }
    const session = verifyWireSecret(
      this.#keyRing,
      "session",
      snapshot.currentSessionToken,
    );
    const csrf = verifyWireSecret(
      this.#keyRing,
      "csrf",
      snapshot.currentCsrfValue,
    );
    const excluded = new setConstructor<string>();
    reflectApply(setAdd, excluded, [snapshot.requestId]);
    const invitationId = this.#generateDistinctUuid(excluded);
    reflectApply(setAdd, excluded, [invitationId]);
    const auditEventId = this.#generateDistinctUuid(excluded);
    const invite = issueRepositorySecret(this.#keyRing, "invite");
    return objectFreeze({
      requestId: snapshot.requestId,
      email,
      role: snapshot.role,
      session,
      csrf,
      invitationId,
      auditEventId,
      invite,
    });
  }

  async issueInvitation(
    input: IssueInvitationInput,
  ): Promise<IssueInvitationResult> {
    let requestCandidate: unknown;
    try {
      requestCandidate =
        input !== null && typeof input === "object"
          ? input.requestId
          : undefined;
    } catch {
      requestCandidate = undefined;
    }
    let prepared: PreparedIssue;
    let eventRequestId: string;
    try {
      prepared = this.#prepareIssue(input, requestCandidate);
      eventRequestId = prepared.requestId;
    } catch (error) {
      const requestId = this.#eventRequestId(requestCandidate);
      const inputInvalid = error === preflightInputInvalid;
      if (requestId !== undefined) {
        this.#emit(
          requestId,
          inputInvalid ? "input_invalid" : "internal_fault",
        );
      }
      throw inputInvalid
        ? new OperationDeniedError()
        : new OperationInternalError();
    }

    try {
      const parameters = objectFreeze([
        prepared.invitationId,
        prepared.email,
        prepared.role,
        prepared.invite.persistence.keyVersion,
        copyDigest(prepared.invite.persistence),
        prepared.auditEventId,
        prepared.session.keyVersion,
        copyDigest(prepared.session),
        prepared.csrf.keyVersion,
        copyDigest(prepared.csrf),
        prepared.requestId,
        this.#deploymentRevision,
      ]);
      return await runPinnedTransaction(
        this.#connect,
        issueInvitationSql,
        parameters,
        (row) => {
          const invitationId = ownDataProperty(row, "invitation_id");
          if (
            !isCanonicalUuid(invitationId) ||
            invitationId !== prepared.invitationId
          ) {
            return internal();
          }
          return createIssueResult(
            invitationId,
            validatedTimestampEpoch(ownDataProperty(row, "expires_at")),
            prepared.invite.wireValue,
          );
        },
      );
    } catch (error) {
      return this.#mapFailure(error, eventRequestId, "issue");
    }
  }

  #prepareAccept(
    input: AcceptInvitationInput,
    requestId: unknown,
  ): PreparedAccept {
    let snapshot: {
      requestId: unknown;
      inviteToken: unknown;
      principal: unknown;
    };
    try {
      if (input === null || typeof input !== "object") {
        throw preflightInputInvalid;
      }
      snapshot = {
        requestId,
        inviteToken: input.inviteToken,
        principal: input.principal,
      };
    } catch (error) {
      throw error === preflightInputInvalid ? error : preflightInputInvalid;
    }
    if (!isCanonicalUuid(snapshot.requestId)) {
      throw preflightInputInvalid;
    }

    const invite = verifyWireSecret(
      this.#keyRing,
      "invite",
      snapshot.inviteToken,
    );
    const principal = snapshotPrincipal(snapshot.principal);
    const excluded = new setConstructor<string>();
    reflectApply(setAdd, excluded, [snapshot.requestId]);
    const proposedUserId = this.#generateDistinctUuid(excluded);
    reflectApply(setAdd, excluded, [proposedUserId]);
    const proposedMembershipId = this.#generateDistinctUuid(excluded);
    reflectApply(setAdd, excluded, [proposedMembershipId]);
    const proposedSessionId = this.#generateDistinctUuid(excluded);
    reflectApply(setAdd, excluded, [proposedSessionId]);
    const auditEventId = this.#generateDistinctUuid(excluded);
    const session = issueRepositorySecret(this.#keyRing, "session");
    const csrf = issueRepositorySecret(this.#keyRing, "csrf");
    return objectFreeze({
      requestId: snapshot.requestId,
      invite,
      principal,
      proposedUserId,
      proposedMembershipId,
      proposedSessionId,
      auditEventId,
      session,
      csrf,
    });
  }

  async acceptInvitation(
    input: AcceptInvitationInput,
  ): Promise<AcceptInvitationResult> {
    let requestCandidate: unknown;
    try {
      requestCandidate =
        input !== null && typeof input === "object"
          ? input.requestId
          : undefined;
    } catch {
      requestCandidate = undefined;
    }
    let prepared: PreparedAccept;
    let eventRequestId: string;
    try {
      prepared = this.#prepareAccept(input, requestCandidate);
      eventRequestId = prepared.requestId;
    } catch (error) {
      const requestId = this.#eventRequestId(requestCandidate);
      const inputInvalid = error === preflightInputInvalid;
      if (requestId !== undefined) {
        this.#emit(
          requestId,
          inputInvalid ? "input_invalid" : "internal_fault",
        );
      }
      throw inputInvalid
        ? new OperationDeniedError()
        : new OperationInternalError();
    }

    try {
      const parameters = objectFreeze([
        prepared.invite.keyVersion,
        copyDigest(prepared.invite),
        prepared.principal.issuer,
        prepared.principal.subject,
        prepared.principal.normalizedVerifiedEmail,
        true,
        prepared.proposedUserId,
        prepared.proposedMembershipId,
        prepared.proposedSessionId,
        prepared.session.persistence.keyVersion,
        copyDigest(prepared.session.persistence),
        prepared.csrf.persistence.keyVersion,
        copyDigest(prepared.csrf.persistence),
        prepared.auditEventId,
        prepared.requestId,
        this.#deploymentRevision,
      ]);
      return await runPinnedTransaction(
        this.#connect,
        acceptInvitationSql,
        parameters,
        (row) => {
          const userId = ownDataProperty(row, "user_id");
          const organizationId = ownDataProperty(row, "organization_id");
          const membershipId = ownDataProperty(row, "membership_id");
          const sessionId = ownDataProperty(row, "session_id");
          const role = ownDataProperty(row, "granted_role");
          if (
            !isCanonicalUuid(userId) ||
            !isCanonicalUuid(organizationId) ||
            !isCanonicalUuid(membershipId) ||
            !isCanonicalUuid(sessionId) ||
            !isRole(role) ||
            sessionId !== prepared.proposedSessionId
          ) {
            return internal();
          }
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
          return createAcceptResult(
            {
              userId,
              organizationId,
              membershipId,
              sessionId,
              role,
              authorityRevision: positiveRevision(
                ownDataProperty(row, "authority_revision"),
              ),
              sessionToken: prepared.session.wireValue,
              csrfValue: prepared.csrf.wireValue,
              sessionCookie: createSessionCookieMetadata(
                databaseNowEpoch,
                absoluteExpiresAtEpoch,
              ),
            },
            idleExpiresAtEpoch,
            absoluteExpiresAtEpoch,
          );
        },
      );
    } catch (error) {
      return this.#mapFailure(error, eventRequestId, "accept");
    }
  }
}
