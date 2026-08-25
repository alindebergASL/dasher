export {
  deriveLedgerFacts,
  LEDGER_CALCULATION_EVIDENCE_ID,
  LedgerSnapshotSchema,
  periodStart,
  type LedgerFacts,
  type LedgerLineFacts,
  type LedgerSnapshot,
} from "./ledger";

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
