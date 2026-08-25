import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LedgerSourceSchema, ledgerFromCsv } from "./from-csv";
import type { LedgerSnapshot } from "./ledger";

/**
 * The committed ledger export, read the way a real one would be.
 *
 * WHY THIS EXISTS RATHER THAN A JSON IMPORT. The fixture used to be a
 * pre-normalized `LedgerSnapshot` in JSON — already pivoted, already typed,
 * already the shape the compiler wanted. Everything downstream was therefore
 * tested against a file that had skipped the step this slice exists to build,
 * and the parser would have been exercised only by its own unit tests while the
 * product read something else. That is how a package ends up reachable from
 * nothing, which this repository has now done three times.
 *
 * So there is one committed source, in the shape an exporter writes it, and
 * both the product and the tests reach it through the parser.
 *
 * The provenance travels beside the file because a CSV cannot state its own
 * source, retrieval time, or currency, and deriving those from a filename would
 * be a fabrication in the trusted layer.
 */

/**
 * Resolved inside the call, not at import.
 *
 * At module scope this ran the moment anything imported the package, and
 * `import.meta.url` is not a `file:` URL under every test environment — which
 * broke four unrelated web test files that only wanted the domain types. A
 * module that reads the filesystem should do it when asked, and this one lives
 * behind its own entry point so a browser bundle never reaches it at all.
 */
function read(name: string): string {
  const directory = fileURLToPath(
    new URL("../../../fixtures/ledger/", import.meta.url),
  );
  return readFileSync(`${directory}${name}`, "utf8");
}

/**
 * Read once. The file does not change while the process runs, and re-parsing it
 * per request would put a synchronous file read on the request path.
 */
let cached: LedgerSnapshot | undefined;

export function operatingSpendFixture(): LedgerSnapshot {
  cached ??= ledgerFromCsv(
    read("operating-spend.csv"),
    LedgerSourceSchema.parse(
      JSON.parse(read("operating-spend.source.json")) as unknown,
    ),
  );
  return cached;
}
