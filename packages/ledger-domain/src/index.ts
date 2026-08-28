export {
  deriveLedgerFacts,
  LEDGER_CALCULATION_EVIDENCE_ID,
  LEDGER_TOO_LARGE,
  LedgerSnapshotSchema,
  periodStart,
  type LedgerFacts,
  type LedgerLineFacts,
  type LedgerSnapshot,
} from "./ledger";

export {
  LedgerSourceSchema,
  ledgerFromCsv,
  type LedgerSource,
} from "./from-csv";

/**
 * The refusal `ledgerFromCsv` throws, re-exported because it throws it.
 *
 * A caller could not name the error this package's own public function raises
 * without depending on `@dasher/workbook` directly — so it either caught
 * `unknown` and lost the reason, or acquired a dependency on the reader to
 * describe the reader's failures. Neither is a choice anyone should have to
 * make to handle a documented error.
 */
export { CsvRefused, type CsvRefusal } from "@dasher/workbook";

export {
  calculateLedger,
  LedgerCalculationFailed,
  type LedgerCalculation,
  type LedgerCell,
} from "./calculation";

/**
 * The arithmetic and formatting the facts need, exported because the compiler
 * consumes them and the values are no longer `number`.
 *
 * A caller that reached for `+`, `Math.abs` or `toFixed` on one of these figures
 * would be doing float arithmetic on money again, one layer further out. These
 * are what it reaches for instead.
 */
export {
  type Exact,
  ZERO,
  abs,
  add,
  compare,
  fromNumber,
  ratioToPercent,
  round,
  sign,
  subtract,
  toFixed,
} from "./exact";
