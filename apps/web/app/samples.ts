import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

export const SAMPLE_NAME = "sample-transactions.csv";

/**
 * The bundled sample: eight months of operating transactions. Read from disk
 * once per process; the file ships beside the app so `next start` finds it
 * from the app directory in every environment we run.
 */
let cached: Uint8Array | undefined;

export function sampleBytes(): Uint8Array {
  // A copy per caller: the reader hands these bytes on to parsing and storage,
  // and one shared buffer would make any mutation everyone's.
  if (cached !== undefined) return Uint8Array.from(cached);
  const candidates = [
    path.join(process.cwd(), "samples", "transactions.csv"),
    path.join(process.cwd(), "apps", "web", "samples", "transactions.csv"),
  ];
  for (const candidate of candidates) {
    try {
      cached = new Uint8Array(readFileSync(candidate));
      return Uint8Array.from(cached);
    } catch {
      continue;
    }
  }
  throw new Error(`Sample not found in ${candidates.join(" or ")}`);
}
