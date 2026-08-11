/**
 * `canonical-json-v1` snapshotting, RFC 8785 encoding, `canonical-binary-v1`
 * preimages, and the closed hash registry primitives.
 *
 * Untrusted input is snapshotted exactly once: every own property is read a single
 * time into a frozen plain value, so no getter or proxy trap can be reread after
 * the boundary. Task 9 schemas contain no JSON number token, so the parser and the
 * encoder both close over strings, booleans, null, arrays, and objects only.
 */

import { createHash } from "node:crypto";

import { LIMITS } from "./limits";

export type CanonicalValue =
  | string
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export type CanonicalObject = { readonly [key: string]: CanonicalValue };

/** Untrusted raw graph UTF-8 ceiling, checked before any parse. */
export const RAW_GRAPH_BYTE_CEILING = LIMITS.rawGraphBytes;
/** Canonical AST ceiling, checked after parse, NFC, revalidation, and JCS. */
export const CANONICAL_AST_BYTE_CEILING = LIMITS.astBytes;

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): bigint {
  return BigInt(encoder.encode(text).length);
}

function isNfc(text: string): boolean {
  return text.normalize("NFC") === text;
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireCanonicalString(text: string, where: string): void {
  if (hasUnpairedSurrogate(text)) {
    throw new SyntaxError(`unpaired surrogate in ${where}`);
  }
  if (!isNfc(text)) throw new SyntaxError(`non-NFC text in ${where}`);
}

/* ------------------------------------------------------------------ *
 * Untrusted key assignment
 * ------------------------------------------------------------------ */

/**
 * Every parsed or snapshotted object is prototype-free.
 *
 * An untrusted document may name any key, including `__proto__`, `constructor`,
 * and `toString`. On an ordinary `{}` object `__proto__` is an accessor inherited
 * from `Object.prototype`: assigning it mutates the prototype instead of creating
 * an own property, so the key vanishes from the canonical bytes while `in` and
 * property reads still resolve it. Two semantically different documents could then
 * share one canonical hash. A null-prototype object has no inherited accessor and
 * no inherited member to shadow, so a key is either an own data property that the
 * encoder emits or absent everywhere.
 */
function emptyCanonicalObject(): Record<string, CanonicalValue> {
  return Object.create(null) as Record<string, CanonicalValue>;
}

/**
 * Defines one untrusted key as an own enumerable data property. `defineProperty`
 * never invokes a setter, so no key can reach `Object.prototype` even if a future
 * caller hands this module a prototype-bearing object.
 */
function defineCanonicalKey(
  target: Record<string, CanonicalValue>,
  key: string,
  value: CanonicalValue,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/* ------------------------------------------------------------------ *
 * Snapshot boundary
 * ------------------------------------------------------------------ */

function snapshotValue(value: unknown, path: string): CanonicalValue {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string") {
    requireCanonicalString(value as string, path);
    return value as string;
  }
  if (kind === "boolean") return value as boolean;
  if (kind === "number") {
    throw new TypeError(`JSON number token is forbidden at ${path}`);
  }
  if (kind !== "object") {
    throw new TypeError(`unsupported ${kind} value at ${path}`);
  }
  if (Array.isArray(value)) {
    const items: CanonicalValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(snapshotValue(value[index], `${path}/${index}`));
    }
    return Object.freeze(items);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`exotic object prototype at ${path}`);
  }
  const snapshot = emptyCanonicalObject();
  for (const key of Object.keys(value as Record<string, unknown>)) {
    requireCanonicalString(key, `${path} key`);
    defineCanonicalKey(
      snapshot,
      key,
      snapshotValue((value as Record<string, unknown>)[key], `${path}/${key}`),
    );
  }
  return Object.freeze(snapshot);
}

/**
 * Deep-copies an untrusted value exactly once into a frozen canonical value.
 * Every own enumerable property is read a single time.
 */
export function snapshotUntrusted(value: unknown): CanonicalValue {
  return snapshotValue(value, "");
}

/* ------------------------------------------------------------------ *
 * Strict parser
 * ------------------------------------------------------------------ */

class StrictJsonReader {
  private index = 0;

  constructor(private readonly text: string) {}

  parseDocument(): CanonicalValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      throw new SyntaxError("trailing content after JSON document");
    }
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        this.index += 1;
      } else {
        break;
      }
    }
  }

  private expect(character: string): void {
    if (this.text[this.index] !== character) {
      throw new SyntaxError(`expected ${character} at offset ${this.index}`);
    }
    this.index += 1;
  }

  private parseValue(): CanonicalValue {
    const character = this.text[this.index];
    if (character === undefined)
      throw new SyntaxError("unexpected end of input");
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === '"') return this.parseString();
    if (this.text.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      throw new SyntaxError(
        `JSON number token is forbidden at offset ${this.index}`,
      );
    }
    throw new SyntaxError(`unexpected token at offset ${this.index}`);
  }

  private parseObject(): CanonicalObject {
    this.expect("{");
    const result = emptyCanonicalObject();
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return Object.freeze(result);
    }
    for (;;) {
      this.skipWhitespace();
      const key = this.parseString();
      if (seen.has(key)) throw new SyntaxError(`duplicate key ${key}`);
      seen.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      defineCanonicalKey(result, key, this.parseValue());
      this.skipWhitespace();
      const character = this.text[this.index];
      if (character === ",") {
        this.index += 1;
        continue;
      }
      if (character === "}") {
        this.index += 1;
        return Object.freeze(result);
      }
      throw new SyntaxError(`unexpected token at offset ${this.index}`);
    }
  }

  private parseArray(): readonly CanonicalValue[] {
    this.expect("[");
    const items: CanonicalValue[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return Object.freeze(items);
    }
    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue());
      this.skipWhitespace();
      const character = this.text[this.index];
      if (character === ",") {
        this.index += 1;
        continue;
      }
      if (character === "]") {
        this.index += 1;
        return Object.freeze(items);
      }
      throw new SyntaxError(`unexpected token at offset ${this.index}`);
    }
  }

  private parseString(): string {
    this.expect('"');
    let out = "";
    for (;;) {
      const character = this.text[this.index];
      if (character === undefined) throw new SyntaxError("unterminated string");
      const code = this.text.charCodeAt(this.index);
      if (character === '"') {
        this.index += 1;
        requireCanonicalString(out, "string");
        return out;
      }
      if (code < 0x20) {
        throw new SyntaxError(
          `literal control character outside a JSON escape at offset ${this.index}`,
        );
      }
      if (character === "\\") {
        this.index += 1;
        out += this.parseEscape();
        continue;
      }
      out += character;
      this.index += 1;
    }
  }

  private parseEscape(): string {
    const character = this.text[this.index];
    this.index += 1;
    switch (character) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.text.slice(this.index, this.index + 4);
        if (hex.length !== 4) throw new SyntaxError("truncated unicode escape");
        for (let offset = 0; offset < 4; offset += 1) {
          const digit = hex[offset] as string;
          const isHex =
            (digit >= "0" && digit <= "9") ||
            (digit >= "a" && digit <= "f") ||
            (digit >= "A" && digit <= "F");
          if (!isHex) throw new SyntaxError("invalid unicode escape");
        }
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        throw new SyntaxError(`invalid escape at offset ${this.index}`);
    }
  }
}

/**
 * Parses strict JSON with no number token, no duplicate key, no literal control
 * character, no unpaired surrogate, and NFC-only strings.
 */
export function parseStrictJson(text: string): CanonicalValue {
  return new StrictJsonReader(text).parseDocument();
}

/* ------------------------------------------------------------------ *
 * RFC 8785 encoding
 * ------------------------------------------------------------------ */

const ESCAPES = new Map<number, string>([
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x22, '\\"'],
  [0x5c, "\\\\"],
]);

function encodeString(text: string): string {
  let out = '"';
  for (const character of text) {
    const code = character.codePointAt(0) as number;
    const escape = ESCAPES.get(code);
    if (escape !== undefined) {
      out += escape;
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += character;
    }
  }
  return `${out}"`;
}

/** Compares two keys by UTF-16 code unit, as RFC 8785 requires. */
function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

export function jcsEncode(value: CanonicalValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map(jcsEncode).join(",")}]`;
  }
  const object = value as CanonicalObject;
  const keys = Object.keys(object).sort(compareCodeUnits);
  return `{${keys
    .map(
      (key) =>
        `${encodeString(key)}:${jcsEncode(object[key] as CanonicalValue)}`,
    )
    .join(",")}}`;
}

/** Byte length of a canonical JCS string token, including quotes and escapes. */
export function jcsStringTokenBytes(text: string): bigint {
  return utf8ByteLength(encodeString(text));
}

/**
 * A canonical byte ceiling was exceeded.
 *
 * This module owns no semantic error code, so the two byte gates raise a
 * distinguishable error and the package boundary maps it to `limit_exceeded`;
 * every other host exception raised here is a malformed document.
 */
export class CanonicalLimitError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalLimitError";
  }
}

export interface RawGraphSnapshot {
  readonly value: CanonicalValue;
  readonly rawBytes: bigint;
  readonly canonicalText: string;
  readonly canonicalBytes: bigint;
}

/**
 * Applies the two distinct inclusive ceilings in their required order: the
 * pre-parse raw UTF-8 gate first, then the post-parse canonical JCS gate.
 */
export function snapshotRawGraphBytes(raw: string): RawGraphSnapshot {
  const rawBytes = utf8ByteLength(raw);
  if (rawBytes > RAW_GRAPH_BYTE_CEILING) {
    throw new CanonicalLimitError(
      `raw graph bytes ${rawBytes} exceed ${RAW_GRAPH_BYTE_CEILING}`,
    );
  }
  const value = parseStrictJson(raw);
  const canonicalText = jcsEncode(value);
  const canonicalBytes = utf8ByteLength(canonicalText);
  if (canonicalBytes > CANONICAL_AST_BYTE_CEILING) {
    throw new CanonicalLimitError(
      `canonical graph bytes ${canonicalBytes} exceed ${CANONICAL_AST_BYTE_CEILING}`,
    );
  }
  return { value, rawBytes, canonicalText, canonicalBytes };
}

/* ------------------------------------------------------------------ *
 * canonical-binary-v1 and the hash registry
 * ------------------------------------------------------------------ */

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function domainBytes(domain: string): Uint8Array {
  return encoder.encode(`${domain}\0`);
}

function unsigned32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

/** Signed 64-bit big-endian two's complement. */
export function canonicalBinaryI64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let remaining = BigInt.asUintN(64, value);
  for (let index = 7; index >= 0; index -= 1) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

export function canonicalBinaryBoolean(value: boolean): Uint8Array {
  return new Uint8Array([value ? 0x01 : 0x00]);
}

/** Unsigned-32 UTF-8 length prefix plus NFC bytes. */
export function canonicalBinaryText(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  return concatBytes([unsigned32(bytes.length), bytes]);
}

/** Unsigned-32 length prefix plus raw bytes: the registry's "SHA byte string". */
export function canonicalBinaryByteString(bytes: Uint8Array): Uint8Array {
  return concatBytes([unsigned32(bytes.length), bytes]);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    const high = HEX_DIGITS.indexOf(hex[index * 2] as string);
    const low = HEX_DIGITS.indexOf(hex[index * 2 + 1] as string);
    if (high < 0 || low < 0) throw new RangeError("invalid hex text");
    out[index] = high * 16 + low;
  }
  return out;
}

/** Exact fixed-width raw 32-byte digest: the registry's "SHA bytes". */
export function canonicalBinaryShaBytes(hex: string): Uint8Array {
  if (!isSha256Hex(hex)) throw new RangeError("invalid SHA-256 hex");
  return hexToBytes(hex);
}

/** UUID network bytes. */
export function canonicalBinaryUuid(uuid: string): Uint8Array {
  if (!isUuidText(uuid)) throw new RangeError(`invalid UUID text ${uuid}`);
  return hexToBytes(uuid.split("-").join(""));
}

/** `00` for an absent nullable value, `01` plus the encoding when present. */
export function canonicalBinaryNullable(value: Uint8Array | null): Uint8Array {
  return value === null
    ? new Uint8Array([0x00])
    : concatBytes([new Uint8Array([0x01]), value]);
}

/** The canonical semantic row hash: domain, NUL, unsigned-32 length, exact bytes. */
export function rowHash(domain: string, canonicalText: string): string {
  const bytes = encoder.encode(canonicalText);
  return sha256Hex(
    concatBytes([domainBytes(domain), unsigned32(bytes.length), bytes]),
  );
}

/**
 * The plan-wide UUIDv8 rule: SHA-256 over domain, NUL, and the ordered preimage;
 * digest bytes 0..15 with the version and variant nibbles fixed.
 */
export function uuidV8(domain: string, parts: readonly Uint8Array[]): string {
  const digest = createHash("sha256")
    .update(concatBytes([domainBytes(domain), ...parts]))
    .digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

const HEX_DIGITS = "0123456789abcdef";

export function isUuidText(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 36) return false;
  for (let index = 0; index < 36; index += 1) {
    const character = value[index] as string;
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (character !== "-") return false;
    } else if (!HEX_DIGITS.includes(character)) {
      return false;
    }
  }
  return true;
}

export function isSha256Hex(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (let index = 0; index < 64; index += 1) {
    if (!HEX_DIGITS.includes(value[index] as string)) return false;
  }
  return true;
}

/** Unsigned bytewise comparison used by every sorted-array rule. */
export function compareUtf8(left: string, right: string): -1 | 0 | 1 {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] as number;
    const y = b[index] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

export function compareBytes(left: Uint8Array, right: Uint8Array): -1 | 0 | 1 {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index] as number;
    const y = right[index] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

/* ------------------------------------------------------------------ *
 * Closed temporal primitives
 * ------------------------------------------------------------------ */

export interface CivilDate {
  readonly year: bigint;
  readonly month: bigint;
  readonly day: bigint;
}

function isLeapYear(year: bigint): boolean {
  return (year % 4n === 0n && year % 100n !== 0n) || year % 400n === 0n;
}

const MONTH_LENGTHS = [
  31n,
  28n,
  31n,
  30n,
  31n,
  30n,
  31n,
  31n,
  30n,
  31n,
  30n,
  31n,
];

function monthLength(year: bigint, month: bigint): bigint {
  if (month === 2n && isLeapYear(year)) return 29n;
  return MONTH_LENGTHS[Number(month) - 1] as bigint;
}

/** Days from 1970-01-01 for a proleptic Gregorian civil date. */
export function daysFromCivil(
  year: bigint,
  month: bigint,
  day: bigint,
): bigint {
  const shiftedYear = month <= 2n ? year - 1n : year;
  const era = (shiftedYear >= 0n ? shiftedYear : shiftedYear - 399n) / 400n;
  const yearOfEra = shiftedYear - era * 400n;
  const dayOfYear =
    (153n * (month + (month > 2n ? -3n : 9n)) + 2n) / 5n + day - 1n;
  const dayOfEra =
    yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146097n + dayOfEra - 719468n;
}

export function civilFromDays(days: bigint): CivilDate {
  const shifted = days + 719468n;
  const era = (shifted >= 0n ? shifted : shifted - 146096n) / 146097n;
  const dayOfEra = shifted - era * 146097n;
  const yearOfEra =
    (dayOfEra - dayOfEra / 1460n + dayOfEra / 36524n - dayOfEra / 146096n) /
    365n;
  const year = yearOfEra + era * 400n;
  const dayOfYear =
    dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const shiftedMonth = (5n * dayOfYear + 2n) / 153n;
  const day = dayOfYear - (153n * shiftedMonth + 2n) / 5n + 1n;
  const month = shiftedMonth + (shiftedMonth < 10n ? 3n : -9n);
  return { year: month <= 2n ? year + 1n : year, month, day };
}

function readDigits(text: string, start: number, count: number): bigint | null {
  if (start + count > text.length) return null;
  let value = 0n;
  for (let index = start; index < start + count; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return null;
    value = value * 10n + BigInt(code - 0x30);
  }
  return value;
}

/** Parses exact `YYYY-MM-DD`, returning signed days from 1970-01-01. */
export function parseDateText(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length !== 10) return null;
  if (value[4] !== "-" || value[7] !== "-") return null;
  const year = readDigits(value, 0, 4);
  const month = readDigits(value, 5, 2);
  const day = readDigits(value, 8, 2);
  if (year === null || month === null || day === null) return null;
  if (month < 1n || month > 12n) return null;
  if (day < 1n || day > monthLength(year, month)) return null;
  return daysFromCivil(year, month, day);
}

export function formatDateText(days: bigint): string {
  const civil = civilFromDays(days);
  const year = civil.year.toString().padStart(4, "0");
  const month = civil.month.toString().padStart(2, "0");
  const day = civil.day.toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parses exact UTC RFC 3339 with six fractional digits, returning signed epoch
 * microseconds. No other instant spelling exists in Task 9.
 */
export function parseTimestampMicros(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length !== 27) return null;
  if (value[10] !== "T" || value[13] !== ":" || value[16] !== ":") return null;
  if (value[19] !== "." || value[26] !== "Z") return null;
  const days = parseDateText(value.slice(0, 10));
  if (days === null) return null;
  const hour = readDigits(value, 11, 2);
  const minute = readDigits(value, 14, 2);
  const second = readDigits(value, 17, 2);
  const micros = readDigits(value, 20, 6);
  if (hour === null || minute === null || second === null || micros === null) {
    return null;
  }
  if (hour > 23n || minute > 59n || second > 59n) return null;
  return (
    ((days * 24n + hour) * 60n + minute) * 60n * 1000000n +
    second * 1000000n +
    micros
  );
}

export function formatTimestampMicros(micros: bigint): string {
  const dayMicros = 86400000000n;
  const days =
    micros >= 0n ? micros / dayMicros : (micros - dayMicros + 1n) / dayMicros;
  const remainder = micros - days * dayMicros;
  const hour = remainder / 3600000000n;
  const minute = (remainder % 3600000000n) / 60000000n;
  const second = (remainder % 60000000n) / 1000000n;
  const fraction = remainder % 1000000n;
  return `${formatDateText(days)}T${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:${second.toString().padStart(2, "0")}.${fraction
    .toString()
    .padStart(6, "0")}Z`;
}
