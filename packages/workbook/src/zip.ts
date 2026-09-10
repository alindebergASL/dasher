/**
 * The little of ZIP that reading a spreadsheet needs.
 *
 * An .xlsx is a ZIP of XML parts. Node can already inflate a raw DEFLATE
 * stream, so reading one costs a central-directory walk rather than a
 * dependency — and this package having no runtime dependencies is why its
 * advisory surface is its own code.
 *
 * Only what a spreadsheet actually uses is supported: stored and deflated
 * entries. Encryption, ZIP64 beyond the locator, spanning and the compression
 * methods no writer emits are refused by name rather than half-read.
 */
import { inflateRawSync } from "node:zlib";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const ZIP64_END_RECORD = 0x06064b50;

const STORED = 0;
const DEFLATED = 8;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

interface Entry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

function u16(bytes: Uint8Array, at: number): number {
  if (at + 2 > bytes.length) throw new ZipError("This file ends mid-record.");
  return (bytes[at] as number) | ((bytes[at + 1] as number) << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  if (at + 4 > bytes.length) throw new ZipError("This file ends mid-record.");
  // Reassembled arithmetically: << 24 would make the top bit negative.
  return (
    (bytes[at] as number) +
    (bytes[at + 1] as number) * 0x100 +
    (bytes[at + 2] as number) * 0x10000 +
    (bytes[at + 3] as number) * 0x1000000
  );
}

function u64(bytes: Uint8Array, at: number): number {
  const low = u32(bytes, at);
  const high = u32(bytes, at + 4);
  const value = high * 0x100000000 + low;
  if (!Number.isSafeInteger(value)) {
    throw new ZipError("This file is larger than this reader supports.");
  }
  return value;
}

/** UTF-8 always: every spreadsheet writer sets the flag, and CP437 predates them. */
function name(bytes: Uint8Array, at: number, length: number): string {
  return new TextDecoder("utf-8").decode(bytes.subarray(at, at + length));
}

/**
 * The end-of-central-directory record sits at the end, behind a comment of
 * unknown length, so it is found by scanning backwards for its signature.
 */
function findEndOfCentral(bytes: Uint8Array): number {
  const shortest = 22;
  if (bytes.length < shortest) throw new ZipError("This file is too short.");
  const earliest = Math.max(0, bytes.length - shortest - 0xffff);
  for (let at = bytes.length - shortest; at >= earliest; at -= 1) {
    if (u32(bytes, at) === END_OF_CENTRAL) return at;
  }
  throw new ZipError("This file is not a readable spreadsheet archive.");
}

/** Where the central directory starts, following the ZIP64 record when present. */
function centralDirectoryStart(
  bytes: Uint8Array,
  endAt: number,
): {
  offset: number;
  count: number;
} {
  const count = u16(bytes, endAt + 10);
  const offset = u32(bytes, endAt + 16);
  const needsZip64 = count === 0xffff || offset === 0xffffffff;
  if (!needsZip64) return { offset, count };

  const locatorAt = endAt - 20;
  if (locatorAt < 0 || u32(bytes, locatorAt) !== ZIP64_END_LOCATOR) {
    throw new ZipError("This archive is missing its ZIP64 directory.");
  }
  const recordAt = u64(bytes, locatorAt + 8);
  if (
    recordAt + 56 > bytes.length ||
    u32(bytes, recordAt) !== ZIP64_END_RECORD
  ) {
    throw new ZipError("This archive's ZIP64 directory is unreadable.");
  }
  return {
    offset: u64(bytes, recordAt + 48),
    count: u64(bytes, recordAt + 32),
  };
}

function readCentralDirectory(bytes: Uint8Array): Map<string, Entry> {
  const end = findEndOfCentral(bytes);
  const { offset, count } = centralDirectoryStart(bytes, end);
  const entries = new Map<string, Entry>();
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, at) !== CENTRAL_HEADER) {
      throw new ZipError("This archive's directory is corrupt.");
    }
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const entry: Entry = {
      name: name(bytes, at + 46, nameLength),
      method: u16(bytes, at + 10),
      compressedSize: u32(bytes, at + 20),
      uncompressedSize: u32(bytes, at + 24),
      localHeaderOffset: u32(bytes, at + 42),
    };
    // A later entry of the same name shadows an earlier one, as unzip does.
    entries.set(entry.name, entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** A read-only view of the parts inside one archive. */
export class ZipArchive {
  private readonly bytes: Uint8Array;
  private readonly entries: Map<string, Entry>;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.entries = readCentralDirectory(bytes);
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  /** The part's bytes, inflated if it was deflated. */
  read(path: string): Uint8Array {
    const entry = this.entries.get(path);
    if (entry === undefined) {
      throw new ZipError(`This spreadsheet has no ${path}.`);
    }
    if (entry.method !== STORED && entry.method !== DEFLATED) {
      throw new ZipError(
        `Part ${path} uses a compression this reader does not support.`,
      );
    }
    const header = entry.localHeaderOffset;
    if (u32(this.bytes, header) !== LOCAL_HEADER) {
      throw new ZipError(`Part ${path} is not where the directory says.`);
    }
    // The local header repeats the name and extra field at its own lengths,
    // which need not match the central directory's.
    const start =
      header + 30 + u16(this.bytes, header + 26) + u16(this.bytes, header + 28);
    const body = this.bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === STORED) return body;
    try {
      return new Uint8Array(inflateRawSync(body));
    } catch {
      throw new ZipError(`Part ${path} could not be decompressed.`);
    }
  }

  /** The part's text, with any byte-order mark removed. */
  text(path: string): string {
    const decoded = new TextDecoder("utf-8").decode(this.read(path));
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  }
}

/** True when the bytes begin with a local file header, as every archive does. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && u32(bytes, 0) === LOCAL_HEADER;
}
