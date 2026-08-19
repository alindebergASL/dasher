/**
 * The retained documents the spike verifies against, sealed on load.
 *
 * Both are real captures already in this repository and already used by the
 * product — nothing here is authored for the spike, because a corpus written
 * to make a verifier look good measures the author, not the verifier.
 *
 * Coordinates are BYTE offsets, not string indices. The hash is over bytes, so
 * the coordinates that hash protects have to be over bytes too; a character
 * offset into a JavaScript string is a UTF-16 code-unit offset, which is a
 * third coordinate system that agrees with neither. A slice that cuts a
 * multi-byte character therefore fails to decode cleanly and is refused, which
 * is the correct outcome rather than an inconvenience.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export interface SealedDocument {
  readonly snapshotId: string;
  /** Repository-relative, so a report names something a reader can open. */
  readonly path: string;
  readonly bytes: Buffer;
  readonly contentSha256: string;
  /** What this document is, for the report. Not used in any decision. */
  readonly description: string;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function seal(
  snapshotId: string,
  path: string,
  description: string,
): SealedDocument {
  const bytes = readFileSync(join(REPOSITORY_ROOT, path));
  return { snapshotId, path, bytes, contentSha256: sha256(bytes), description };
}

/**
 * `ucr-campus-facts-2025` carries a real provenance sidecar
 * (`campus-facts-2025.meta.json`: source URL, retrieval time, and a sha256 that
 * this loader reproduces). `openaq-live-2026-08-18` is the capture taken during
 * the live-source slice; it has no sidecar, so the spike seals whatever bytes
 * are on disk and records the hash it computed rather than claiming a
 * provenance it cannot show.
 */
export const DOCUMENTS: readonly SealedDocument[] = [
  seal(
    "ucr-campus-facts-2025",
    "fixtures/ucr/campus-facts-2025.html",
    "UC Riverside Institutional Research, Campus Facts tables, captured 2026-08-19",
  ),
  seal(
    "openaq-live-2026-08-18",
    "fixtures/openaq/live-capture-2026-08-18.json",
    "OpenAQ v3 locations and sensors, captured live 2026-08-18",
  ),
];

export const DOCUMENTS_BY_ID: ReadonlyMap<string, SealedDocument> = new Map(
  DOCUMENTS.map((document) => [document.snapshotId, document]),
);
