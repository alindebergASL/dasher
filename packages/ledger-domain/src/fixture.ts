import { LedgerSourceSchema, ledgerFromCsv } from "./from-csv";
import type { LedgerSnapshot } from "./ledger";
import exportFile from "../../../fixtures/ledger/operating-spend.csv.json";
import source from "../../../fixtures/ledger/operating-spend.source.json";

/**
 * The committed ledger export, parsed the way a real one would be.
 *
 * The fixture used to be a pre-normalized `LedgerSnapshot` in JSON — already
 * pivoted, already typed, already the shape the compiler wanted. Everything
 * downstream was therefore tested against a file that had skipped the step this
 * slice exists to build, and the parser would have been exercised only by its
 * own unit tests while the product read something else. That is how a package
 * ends up reachable from nothing, which this repository has now done three
 * times.
 *
 * The provenance is a sidecar because a CSV cannot state its own source,
 * retrieval time, or currency, and deriving those from a filename would be a
 * fabrication in the trusted layer.
 *
 * Both files are JSON because the web app is bundled and a bundler must see the
 * value at build time — the same reason the USGS, OpenAQ and UCR fixtures are
 * imported rather than read from disk. Reading the export through
 * `import.meta.url` built locally and failed `next build`, which is how this
 * shape was arrived at. The export is still CSV text, parsed at runtime by the
 * reader an uploaded file will go through; when uploads exist that text comes
 * from storage and nothing about the parser changes.
 */

/** Parsed once. The text does not change while the process runs. */
let cached: LedgerSnapshot | undefined;

export function operatingSpendFixture(): LedgerSnapshot {
  cached ??= ledgerFromCsv(exportFile.csv, LedgerSourceSchema.parse(source));
  return cached;
}
