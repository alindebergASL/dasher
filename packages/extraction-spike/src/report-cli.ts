/** Prints the spike report. Read-only: it touches nothing but the fixtures. */
import { formatReport, runSpike } from "./report";

process.stdout.write(`${formatReport(runSpike())}\n`);
