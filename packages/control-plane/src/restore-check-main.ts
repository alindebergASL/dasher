import { formatRestoreCheck, runRestoreCheck } from "./restore-check";

/**
 * The executable wrapper. Importable behaviour lives in `restore-check.ts`, so
 * importing it has no process-global or database effect — the separation
 * `migrate-cli.ts` and `provision-cli.ts` both keep.
 */
const dsn = process.env["DASHER_RESTORE_CHECK_DSN"];
if (dsn === undefined || dsn.trim() === "") {
  process.stdout.write(
    "\nDASHER_RESTORE_CHECK_DSN is not set.\n" +
      "  Point it at the RESTORED database — not the live one — and re-run.\n\n",
  );
  process.exitCode = 2;
} else {
  const result = await runRestoreCheck(dsn);
  process.stdout.write(formatRestoreCheck(result));
  if (!result.ok) process.exitCode = 1;
}
